// Складывает ядро (server/app) и роды проекта в архив, который страница распаковывает в браузере.
// Руками ничего не копируем: витрина всегда едет с тем же кодом, что и настоящий сервер.

import { spawnSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDeflateRaw } from "node:zlib";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const CORE = resolve(ROOT, "server", "app");
const OUT = resolve(ROOT, "web", "public", "core.zip");
// роды проекта: их видит гость при первом заходе. Список один на всё приложение — витрина берёт
// отсюда и файлы для архива, и имена родов: раньше он лежал в трёх местах и однажды разошёлся
const CLANS = JSON.parse(await readFile(resolve(ROOT, "houses", "роды.json"), "utf8")).map((c) => c.file);

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      // в витрину едет только само ядро: следы запусков и служебные папки надстроек ей ни к чему,
      // а на сервере сборки их и нет — локальный архив не должен отличаться от собранного там
      if (entry.name === "__pycache__" || entry.name.startsWith(".")) continue;
      yield* walk(path);
    } else if (!entry.name.endsWith(".pyc")) {
      yield path;
    }
  }
}

// ── минимальный zip без внешних зависимостей: способ хранения «как есть», этого хватает ──
const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function local(name, data, crc) {
  const head = Buffer.alloc(30);
  head.writeUInt32LE(0x04034b50, 0);
  head.writeUInt16LE(20, 4);
  head.writeUInt16LE(0, 6);
  head.writeUInt16LE(0, 8); // без сжатия
  head.writeUInt16LE(0, 10);
  head.writeUInt16LE(0, 12);
  head.writeUInt32LE(crc, 14);
  head.writeUInt32LE(data.length, 18);
  head.writeUInt32LE(data.length, 22);
  head.writeUInt16LE(Buffer.byteLength(name), 26);
  head.writeUInt16LE(0, 28);
  return Buffer.concat([head, Buffer.from(name, "utf8"), data]);
}

function central(name, data, crc, offset) {
  const head = Buffer.alloc(46);
  head.writeUInt32LE(0x02014b50, 0);
  head.writeUInt16LE(20, 4);
  head.writeUInt16LE(20, 6);
  head.writeUInt16LE(0, 8);
  head.writeUInt16LE(0, 10);
  head.writeUInt16LE(0, 12);
  head.writeUInt16LE(0, 14);
  head.writeUInt32LE(crc, 16);
  head.writeUInt32LE(data.length, 20);
  head.writeUInt32LE(data.length, 24);
  head.writeUInt16LE(Buffer.byteLength(name), 28);
  head.writeUInt32LE(offset, 42);
  return Buffer.concat([head, Buffer.from(name, "utf8")]);
}

async function pack(files) {
  const parts = [];
  const index = [];
  let offset = 0;
  for (const [name, data] of files) {
    const crc = crc32(data);
    const block = local(name, data, crc);
    parts.push(block);
    index.push(central(name, data, crc, offset));
    offset += block.length;
  }
  const directory = Buffer.concat(index);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

// Роды в .gitignore перечислены поимённо — так личное дерево не уедет в репозиторий случайно.
// Обратная сторона: про новый род легко забыть, и тогда он есть на своём компьютере, но не на сервере
// сборки, где витрина собирается из того, что в git. Поэтому проверяем здесь, пока это дешёво.
function untracked(names) {
  // core.quotepath=off: иначе git отдаёт кириллицу в именах экранированной, и сверять её не с чем
  const seen = spawnSync("git", ["-c", "core.quotepath=off", "ls-files", "houses"], { cwd: ROOT, encoding: "utf8" });
  if (seen.status !== 0) return []; // git недоступен — проверять нечем, не мешаем сборке
  const inGit = new Set(seen.stdout.split(/\r?\n/).map((line) => line.trim().split("/").pop()));
  return names.filter((name) => !inGit.has(name));
}

const forgotten = untracked([...CLANS, "роды.json"]);
if (forgotten.length) {
  console.error(`Роды есть в списке, но не в git: ${forgotten.join(", ")}.`);
  console.error("На сервере сборки их не будет. Добавьте исключение в .gitignore и закоммитьте файл.");
  process.exit(1);
}

const files = [];
for await (const path of walk(CORE)) {
  files.push([`app/${relative(CORE, path).split("\\").join("/")}`, await readFile(path)]);
}
for (const name of CLANS) {
  files.push([`houses/${name}`, await readFile(resolve(ROOT, "houses", name))]);
}

await mkdir(dirname(OUT), { recursive: true });
const zip = await pack(files);
await new Promise((done, fail) => {
  const out = createWriteStream(OUT);
  out.on("finish", done);
  out.on("error", fail);
  out.end(zip);
});
const { size } = await stat(OUT);
console.log(`core.zip: ${files.length} файлов, ${(size / 1024).toFixed(0)} КБ`);
