"""Набор меток рода: переименовать, перекрасить, удалить. Одна правка журнала — и заголовок рода,
и все люди с этой меткой, поэтому откат возвращает метку целиком, со всеми, на ком она стояла."""

from __future__ import annotations

import json
import sqlite3

from pydantic import BaseModel

from app.db.journal import ChangeInfo, Edit, JournalError
from app.gedcom.meta import STATUS_NAMES, TAG_COLORS, add_tag_def, read_meta, read_status, read_tag_defs, write_status
from app.gedcom.records import Record


class TagChange(BaseModel):
    name: str
    color: str


class TagError(ValueError):
    pass


def _holders(conn: sqlite3.Connection, clan_id: int, name: str) -> list[int]:
    return [row[0] for row in conn.execute("SELECT id, raw FROM persons WHERE clan_id = ?", (clan_id,))
            if name in read_meta(Record.from_json(json.loads(row[1]))).tags]


def tag_usage(conn: sqlite3.Connection, clan_id: int, name: str) -> int:
    return len(_holders(conn, clan_id, name))


def set_status(conn: sqlite3.Connection, clan_id: int, status: str) -> ChangeInfo:
    """Статус рода — в заголовке файла, правкой через журнал: откат вернёт прежний."""
    if status not in STATUS_NAMES:
        raise TagError("Такого статуса нет")
    edit = Edit(conn, clan_id)
    header = edit.header()
    if read_status(header) == status:
        raise TagError("Статус тот же")
    write_status(header, status)
    edit.summary = f"Статус рода: {STATUS_NAMES[status]}"
    try:
        return edit.commit()
    except JournalError as error:
        raise TagError(str(error)) from None


def update_tag(conn: sqlite3.Connection, clan_id: int, old: str, change: TagChange) -> ChangeInfo:
    new = change.name.strip()
    if not new:
        raise TagError("У метки должно быть название")
    if change.color not in TAG_COLORS:
        raise TagError("Такого цвета в палитре нет")
    edit = Edit(conn, clan_id)
    header = edit.header()
    names = [t.name for t in read_tag_defs(header)]
    if new != old and new in names:
        raise TagError(f"Метка «{new}» уже есть")
    # на том же месте в наборе: порядок меток — порядок их создания
    record = next((c for c in header.all("_TAGDEF") if c.value == old), None)
    if record is None:
        add_tag_def(header, new, change.color)
    else:
        record.value = new
        color = record.first("_COLOR")
        if color is None:
            record.children.append(Record(level=2, tag="_COLOR", value=change.color))
        else:
            color.value = change.color
    if new != old:
        for pid in _holders(conn, clan_id, old):
            record = edit.person(pid)
            for child in record.all("_TAG"):
                if child.value == old:
                    child.value = new
    edit.summary = f"Метка «{old}» → «{new}»" if new != old else f"Метка «{new}»: цвет {change.color}"
    try:
        return edit.commit()
    except JournalError as error:
        raise TagError(str(error)) from None


def delete_tag(conn: sqlite3.Connection, clan_id: int, name: str) -> ChangeInfo:
    edit = Edit(conn, clan_id)
    header = edit.header()
    header.children = [c for c in header.children if not (c.tag == "_TAGDEF" and c.value == name)]
    holders = _holders(conn, clan_id, name)
    for pid in holders:
        record = edit.person(pid)
        record.children = [c for c in record.children if not (c.tag == "_TAG" and c.value == name)]
    edit.summary = f"Удалена метка «{name}»" + (f" — снята с {len(holders)}" if holders else "")
    try:
        return edit.commit()
    except JournalError as error:
        raise TagError(str(error)) from None
