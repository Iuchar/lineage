// Мост: поднимает Python прямо в браузере и уводит туда все запросы к API.
// Клиентский код не знает о подмене — он по-прежнему зовёт fetch("/api/…"), только ответ приходит
// не по сети, а из ядра, которое работает на этой же странице.

const PYODIDE = "https://cdn.jsdelivr.net/pyodide/v0.28.0/full/";
const CORE = "core.zip"; // ядро и эталонные роды, собирает scripts/pack-core.mjs

// Обёртка вокруг нашего приложения: зовёт его по ASGI без всякой сети.
const HANDLER = `
import asyncio, json, os, sys

# В браузере нет потоков, а FastAPI уводит туда и синхронные обработчики, и зависимости с yield.
# Зовём их напрямую: всё равно всё происходит в одном потоке страницы.
import contextlib
import starlette.concurrency, fastapi.concurrency, fastapi.routing, fastapi.dependencies.utils

async def _direct(func, *args, **kwargs):
    return func(*args, **kwargs)

@contextlib.asynccontextmanager
async def _direct_cm(manager):
    try:
        yield manager.__enter__()
    except Exception as error:
        if not manager.__exit__(type(error), error, error.__traceback__):
            raise
    else:
        manager.__exit__(None, None, None)

for module in (starlette.concurrency, fastapi.concurrency, fastapi.routing, fastapi.dependencies.utils):
    if hasattr(module, "run_in_threadpool"):
        module.run_in_threadpool = _direct
    if hasattr(module, "contextmanager_in_threadpool"):
        module.contextmanager_in_threadpool = _direct_cm

from app.main import app as _app


async def handle(method, path, query, body, headers_json):
    """Возвращает ответ приложения: код, заголовки и тело — как отдал бы настоящий сервер.

    Тело приходит из браузера чужим объектом, поэтому переводится в настоящие байты, а заголовки —
    строкой JSON: так между двумя мирами не остаётся ничего, что можно понять по-разному.
    """
    raw = bytes(body.to_py()) if hasattr(body, "to_py") else bytes(body or b"")
    headers = json.loads(headers_json)
    answer = {"status": 500, "headers": [], "body": b""}
    chunks = []

    async def receive():
        return {"type": "http.request", "body": raw, "more_body": False}

    async def send(message):
        if message["type"] == "http.response.start":
            answer["status"] = message["status"]
            answer["headers"] = [[k.decode(), v.decode()] for k, v in message.get("headers", [])]
        elif message["type"] == "http.response.body":
            chunks.append(message.get("body", b""))

    scope = {
        "type": "http", "asgi": {"version": "3.0", "spec_version": "2.3"}, "http_version": "1.1",
        "method": method, "path": path, "raw_path": path.encode(), "query_string": query.encode(),
        "headers": [[k.lower().encode(), v.encode()] for k, v in headers],
        "scheme": "https", "client": ("browser", 0), "server": ("browser", 443), "root_path": "",
    }
    await _app(scope, receive, send)
    answer["body"] = b"".join(chunks)
    return answer
`;

export interface BridgeSteps {
  (text: string): void;
}

interface Pyodide {
  loadPackage: (names: string[] | string) => Promise<void>;
  runPythonAsync: (code: string) => Promise<unknown>;
  unpackArchive: (buffer: ArrayBuffer, format: string, options?: { extractDir?: string }) => void;
  FS: {
    mkdirTree: (path: string) => void;
    mount: (type: unknown, options: unknown, path: string) => void;
    syncfs: (populate: boolean, callback: (error: unknown) => void) => void;
    filesystems: { IDBFS: unknown };
  };
  globals: { get: (name: string) => unknown };
}

let python: Pyodide | null = null;
let handler: ((method: string, path: string, query: string, body: Uint8Array,
                headersJson: string) => Promise<unknown>) | null = null;

/** Поднимает ядро в браузере и подменяет fetch. Зовётся один раз при старте страницы. */
export async function startBridge(say: BridgeSteps = () => {}): Promise<void> {
  if (python) return;
  say("поднимаю Python");
  const { loadPyodide } = (await import(/* @vite-ignore */ `${PYODIDE}pyodide.mjs`)) as {
    loadPyodide: (options: { indexURL: string }) => Promise<Pyodide>;
  };
  const py = await loadPyodide({ indexURL: PYODIDE });

  say("беру базу данных и веб-часть");
  await py.loadPackage(["sqlite3", "micropip"]);
  await py.runPythonAsync(`
import micropip
await micropip.install(["fastapi", "pydantic"])
`);

  say("разворачиваю ядро");
  const core = await fetch(new URL(CORE, document.baseURI)).then((r) => r.arrayBuffer());
  py.FS.mkdirTree("/core");
  py.unpackArchive(core, "zip", { extractDir: "/core" });
  py.FS.mkdirTree("/data");
  await py.runPythonAsync(`
import os, sys
sys.path.insert(0, "/core")
os.environ["RODOSLOVNYE_DB"] = "/data/rodoslovnye.sqlite3"
`);

  say("запускаю приложение");
  await py.runPythonAsync(HANDLER);
  handler = py.globals.get("handle") as typeof handler;
  python = py;
  catchFetch();
}

/** Роды, которых ещё нет в базе гостя, разворачиваются из эталонных файлов рядом со страницей. */
export async function seedClans(say: BridgeSteps = () => {}): Promise<void> {
  if (!python) return;
  const has = (await python.runPythonAsync(`
import sqlite3, os
from app.db.connection import connect
conn = connect(os.environ["RODOSLOVNYE_DB"])
n = conn.execute("SELECT count(*) FROM clans").fetchone()[0]
conn.close()
n
`)) as number;
  if (has) return;
  say("разворачиваю роды");
  await python.runPythonAsync(`
import os, pathlib
from app.db.clans import import_clan
from app.db.connection import connect
from app.gedcom.load import load_file

conn = connect(os.environ["RODOSLOVNYE_DB"])
for name, file in [("Гленн Уриск", "Gleann_Uruisg_tree.ged"), ("Уинтерхоуп", "Winterhope_tree.ged"),
                   ("О'Дувейн", "O_Dubhain_tree.ged"), ("Монад Кройве", "Monadh_Croibhe_tree.ged")]:
    import_clan(conn, name, load_file(pathlib.Path("/core/clans") / file), source_file=file)
conn.close()
`);
}

/** Запросы к API уходят в ядро, всё прочее (шрифты, картинки) идёт как обычно. */
function catchFetch(): void {
  const real = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input as RequestInfo, init);
    const url = new URL(request.url, document.baseURI);
    const ours = url.pathname.startsWith("/api/") || url.pathname.startsWith("/r/");
    if (!ours || !handler) return real(input as RequestInfo, init);

    const body = new Uint8Array(await request.clone().arrayBuffer());
    const headers: [string, string][] = [...request.headers.entries()];
    const answer = (await handler(request.method, url.pathname, url.search.replace(/^\?/, ""),
                                  body, JSON.stringify(headers))) as {
      toJs: (options: { dict_converter: unknown }) => Map<string, unknown>;
    };
    const plain = answer.toJs({ dict_converter: Object.fromEntries }) as unknown as {
      status: number; headers: [string, string][]; body: Uint8Array;
    };
    const bytes = new Uint8Array(plain.body);
    return new Response(bytes.buffer as ArrayBuffer, { status: plain.status, headers: plain.headers });
  };
}
