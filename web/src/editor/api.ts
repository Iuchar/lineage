// Запросы редактора: ответ или понятная причина отказа от сервера.

export type Result<T> = { ok: true; data: T } | { ok: false; status: number; detail: string };

export async function send<T>(method: string, url: string, body?: unknown): Promise<Result<T>> {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.ok) {
    const text = await response.text();
    return { ok: true, data: (text ? JSON.parse(text) : null) as T };
  }
  const detail = ((await response.json().catch(() => ({}))) as { detail?: unknown }).detail;
  return { ok: false, status: response.status, detail: typeof detail === "string" ? detail : "Не получилось" };
}
