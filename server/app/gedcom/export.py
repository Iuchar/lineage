"""Род → файл GEDCOM 5.5.1. Без потерь: записи уходят теми же деревьями, что пришли из файла и что правит
редактор, — со всеми тегами, которых приложение не понимает. Порядок — как в исходных файлах: заголовок,
люди, семьи, прочие записи, конец файла.
"""

from __future__ import annotations

import json
import sqlite3

from app.gedcom.records import Record


class ExportError(LookupError):
    pass


def _lines(raw: str) -> list[str]:
    return Record.from_json(json.loads(raw)).to_lines()


def _header() -> Record:
    head = Record(level=0, tag="HEAD")
    gedc = Record(level=1, tag="GEDC")
    gedc.children = [Record(level=2, tag="VERS", value="5.5.1"), Record(level=2, tag="FORM", value="LINEAGE-LINKED")]
    head.children = [gedc, Record(level=1, tag="CHAR", value="UTF-8")]
    return head


def export_clan(conn: sqlite3.Connection, clan_id: int) -> str:
    clan = conn.execute("SELECT name, header_raw FROM clans WHERE id = ?", (clan_id,)).fetchone()
    if clan is None:
        raise ExportError(clan_id)
    lines = _lines(clan["header_raw"]) if clan["header_raw"] else _header().to_lines()
    for table in ("persons", "families"):
        for (raw,) in conn.execute(f"SELECT raw FROM {table} WHERE clan_id = ? ORDER BY id", (clan_id,)):
            lines += _lines(raw)
    for (raw,) in conn.execute("SELECT raw FROM extra_records WHERE clan_id = ? ORDER BY position", (clan_id,)):
        lines += _lines(raw)
    lines.append("0 TRLR")
    return "\n".join(lines) + "\n"
