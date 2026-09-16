"""Запуск одной командой: собрать интерфейс, если он устарел, и поднять сервер."""

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

import uvicorn

from app.main import DIST, ROOT

WEB = ROOT / "web"
WEB_SOURCES = ["index.html", "src", "package.json", "vite.config.ts", "tsconfig.json"]


def _newest_mtime(paths: list[Path]) -> float:
    newest = 0.0
    for path in paths:
        if path.is_dir():
            newest = max([newest, *(p.stat().st_mtime for p in path.rglob("*") if p.is_file())])
        elif path.exists():
            newest = max(newest, path.stat().st_mtime)
    return newest


def build_interface(force: bool = False) -> None:
    index = DIST / "index.html"
    sources = [WEB / name for name in WEB_SOURCES]
    if not force and index.exists() and index.stat().st_mtime >= _newest_mtime(sources):
        return

    npm = shutil.which("npm")
    if npm is None:
        sys.exit("Для сборки интерфейса нужен Node.js: команда npm не найдена.")
    if not (WEB / "node_modules").is_dir():
        subprocess.run([npm, "install"], cwd=WEB, check=True)
    subprocess.run([npm, "run", "build"], cwd=WEB, check=True)


def main() -> None:
    parser = argparse.ArgumentParser(prog="rodoslovnye", description="Родословные: локальный сервер")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8710)
    parser.add_argument("--rebuild", action="store_true", help="пересобрать интерфейс принудительно")
    args = parser.parse_args()

    # консоль Windows по умолчанию не в UTF-8, и русский вывод превращается в кракозябры
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    build_interface(force=args.rebuild)
    print(f"Родословные: http://{args.host}:{args.port}")
    uvicorn.run("app.main:app", host=args.host, port=args.port)
