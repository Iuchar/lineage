"""Пути приложения. База лежит в data/ рядом с проектом, переопределяется переменной окружения."""

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = ROOT / "data"
HOUSES_DIR = ROOT / "houses"
DIST = ROOT / "web" / "dist"
DB_PATH = Path(os.environ.get("RODOSLOVNYE_DB", DATA_DIR / "rodoslovnye.sqlite3"))
