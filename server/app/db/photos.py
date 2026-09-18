"""Снимки людей: файлы в папке photos рядом с базой, ссылка — в записи человека (OBJE / FILE).

Загрузка и снятие снимка — правки, как любые другие: идут через журнал и откатываются. Сам файл
при откате остаётся на диске — откат возвращает ссылку, и снимок снова на месте.
"""

from __future__ import annotations

import hashlib
import re
import sqlite3
from pathlib import Path

import app.config
from app.db.editor import EditError, _clan, _first_name
from app.db.journal import ChangeInfo, Edit, JournalError
from app.gedcom.meta import PHOTO_PREFIX, read_meta, set_photo

MAX_PHOTO = 8 * 1024 * 1024
KINDS = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif"}


def photos_dir() -> Path:
    return Path(app.config.DB_PATH).parent / "photos"


def _kind(data: bytes, content_type: str | None) -> str:
    # по сигнатуре файла, а не по тому, что сказал браузер
    if data.startswith(b"\xff\xd8\xff"):
        return "jpg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "gif"
    raise EditError("Это не снимок: нужен JPEG, PNG, WebP или GIF")


def save_photo(conn: sqlite3.Connection, person_id: int, data: bytes, content_type: str | None = None) -> ChangeInfo:
    if len(data) > MAX_PHOTO:
        raise EditError("Снимок больше 8 МБ")
    if not data:
        raise EditError("Пустой файл")
    clan_id = _clan(conn, person_id)
    ext = _kind(data, content_type)
    name = f"{person_id}-{hashlib.sha256(data).hexdigest()[:12]}.{ext}"
    folder = photos_dir() / str(clan_id)
    folder.mkdir(parents=True, exist_ok=True)
    (folder / name).write_bytes(data)

    edit = Edit(conn, clan_id)
    record = edit.person(person_id)
    set_photo(record, f"{PHOTO_PREFIX}{clan_id}/{name}")
    # свой снимок и есть портрет: выключатель «заглушка» или «без портрета» после загрузки снимается
    record.children = [c for c in record.children if c.tag != "_PORTRAIT"]
    edit.summary = f"{_first_name(record)}: снимок"
    try:
        return edit.commit()
    except JournalError as error:
        raise EditError(str(error)) from None


def remove_photo(conn: sqlite3.Connection, person_id: int) -> ChangeInfo:
    edit = Edit(conn, _clan(conn, person_id))
    record = edit.person(person_id)
    if read_meta(record).photo is None:
        raise EditError("Снимка нет")
    set_photo(record, None)
    edit.summary = f"{_first_name(record)}: снимок убран"
    try:
        return edit.commit()
    except JournalError as error:
        raise EditError(str(error)) from None


def photo_path(clan: str, name: str) -> Path:
    if not re.fullmatch(r"\d+", clan) or not re.fullmatch(r"[\w-]+\.(jpg|png|webp|gif)", name):
        raise FileNotFoundError(name)
    path = photos_dir() / clan / name
    if not path.is_file():
        raise FileNotFoundError(name)
    return path
