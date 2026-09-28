// Сборка витрины: ядро в архив, проверка типов, сборка страницы с относительными путями.
import { spawnSync } from "node:child_process";
import { rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const run = (command, args, env = {}) => {
  const done = spawnSync(command, args, { stdio: "inherit", shell: true, env: { ...process.env, ...env } });
  if (done.status !== 0) process.exit(done.status ?? 1);
};

run("node", ["scripts/pack-core.mjs"]);
run("npx", ["tsc", "--noEmit"]);
run("npx", ["vite", "build"], { RODOSLOVNYE_PAGES: "1" });

// Pages отдаёт папку как сайт и ищет index.html, а входная страница витрины зовётся index-pages.html
const out = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "docs", "витрина");
await rename(join(out, "index-pages.html"), join(out, "index.html"));
console.log("витрина: docs/витрина/index.html");
