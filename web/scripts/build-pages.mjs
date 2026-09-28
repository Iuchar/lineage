// Сборка витрины: ядро в архив, проверка типов, сборка страницы с относительными путями.
import { spawnSync } from "node:child_process";

const run = (command, args, env = {}) => {
  const done = spawnSync(command, args, { stdio: "inherit", shell: true, env: { ...process.env, ...env } });
  if (done.status !== 0) process.exit(done.status ?? 1);
};

run("node", ["scripts/pack-core.mjs"]);
run("npx", ["tsc", "--noEmit"]);
run("npx", ["vite", "build"], { RODOSLOVNYE_PAGES: "1" });
