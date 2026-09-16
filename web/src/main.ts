// Каркас: проверяем, что интерфейс собран и сервер отвечает. Холст появится на шаге 4.

const root = document.getElementById("app");

async function checkServer(): Promise<string> {
  try {
    const response = await fetch("/api/health");
    if (!response.ok) return `Сервер ответил ошибкой ${response.status}`;
    const body: { status?: string } = await response.json();
    return body.status === "ok" ? "Сервер отвечает" : "Сервер ответил непонятно";
  } catch {
    return "Сервер недоступен";
  }
}

if (root) {
  root.textContent = "Родословные — проверка сервера…";
  checkServer().then((state) => {
    root.textContent = `Родословные — ${state}`;
  });
}
