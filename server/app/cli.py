"""Командная строка.

    rodoslovnye                                   собрать интерфейс, если устарел, и поднять сервер
    rodoslovnye import ФАЙЛ.ged --name "Род"      загрузить файл новым родом
"""

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

import uvicorn

from app.config import DB_PATH, DIST, ROOT

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


def serve(args: argparse.Namespace) -> None:
    build_interface(force=args.rebuild)
    print(f"Родословные: http://{args.host}:{args.port}")
    uvicorn.run("app.main:app", host=args.host, port=args.port)


def import_file(args: argparse.Namespace) -> None:
    from app.db.clans import ClanExistsError, import_clan
    from app.db.connection import connect
    from app.gedcom.load import GedcomEncodingError, load_file
    from app.gedcom.records import GedcomSyntaxError

    try:
        data = load_file(args.file)
        conn = connect(args.db)
        report = import_clan(conn, args.name, data, source_file=args.file.name)
    except (OSError, GedcomEncodingError, GedcomSyntaxError, ClanExistsError, ValueError) as error:
        sys.exit(f"Не загружено: {error}")

    print(
        f"Род «{report.name}» загружен: людей {report.persons}, семей {report.families}, "
        f"событий {report.events}, узлов-заглушек {report.branch_stubs}, новых мест {report.places}."
    )
    for warning in report.warnings:
        print(f"  предупреждение: {warning}")


def main(argv: list[str] | None = None) -> None:
    # консоль Windows по умолчанию не в UTF-8, и русский вывод превращается в кракозябры
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    argv = sys.argv[1:] if argv is None else argv
    if not argv or argv[0].startswith("-"):
        argv = ["serve", *argv]

    parser = argparse.ArgumentParser(prog="rodoslovnye", description="Родословные")
    commands = parser.add_subparsers(dest="command", required=True)

    serve_cmd = commands.add_parser("serve", help="поднять сервер (по умолчанию)")
    serve_cmd.add_argument("--host", default="127.0.0.1")
    serve_cmd.add_argument("--port", type=int, default=8710)
    serve_cmd.add_argument("--rebuild", action="store_true", help="пересобрать интерфейс принудительно")
    serve_cmd.set_defaults(handler=serve)

    import_cmd = commands.add_parser("import", help="загрузить файл .ged новым родом")
    import_cmd.add_argument("file", type=Path)
    import_cmd.add_argument("--name", required=True, help="имя рода, под которым он появится")
    import_cmd.add_argument("--db", type=Path, default=DB_PATH, help="путь к базе")
    import_cmd.set_defaults(handler=import_file)

    args = parser.parse_args(argv)
    args.handler(args)
