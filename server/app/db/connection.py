"""Соединение с базой и миграции: пронумерованные SQL-файлы применяются по порядку, каждый один раз."""

import sqlite3
from datetime import UTC, datetime
from pathlib import Path

MIGRATIONS = Path(__file__).parent / "migrations"


def connect(path: Path | str) -> sqlite3.Connection:
    if isinstance(path, Path):
        path.parent.mkdir(parents=True, exist_ok=True)
    # соединение живёт один запрос, но FastAPI может открыть его в одном потоке, а использовать в другом
    conn = sqlite3.connect(path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    migrate(conn)
    return conn


def migrate(conn: sqlite3.Connection) -> list[int]:
    conn.execute(
        "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)"
    )
    applied = {row[0] for row in conn.execute("SELECT version FROM schema_migrations")}
    done: list[int] = []
    for file in sorted(MIGRATIONS.glob("*.sql")):
        version = int(file.name.split("_", 1)[0])
        if version in applied:
            continue
        with conn:
            conn.executescript(file.read_text(encoding="utf-8"))
            conn.execute(
                "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
                (version, datetime.now(UTC).isoformat(timespec="seconds")),
            )
        done.append(version)
    return done
