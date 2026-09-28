"""Файл рода.

Каждый род живёт своим файлом `.ged` в папке `houses`: приложение пишет его при загрузке и переписывает
после каждой правки. Чужой исходник не хранится — всё, что удалось из него прочесть, уже лежит в нашем
файле, со всеми служебными тегами приложения.

Куда писать, решает сама база: рабочая база — папка `houses` проекта, любая другая (проверочная,
тестовая, временная) — папка `houses` рядом с этой базой. Так проверки не трогают настоящие роды.

Файл — слепок одного рода. Связки между родами, журнал правок и доступ живут только в базе.
"""

from __future__ import annotations

import logging
import re
import sqlite3
from pathlib import Path

from app.config import DATA_DIR, HOUSES_DIR
from app.gedcom.export import export_clan

log = logging.getLogger(__name__)

# кириллица в латиницу: имена родов в файлах пишутся так, чтобы открывались в любой системе
TRANSLIT = {
    "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "e", "ж": "zh", "з": "z", "и": "i",
    "й": "y", "к": "k", "л": "l", "м": "m", "н": "n", "о": "o", "п": "p", "р": "r", "с": "s", "т": "t",
    "у": "u", "ф": "f", "х": "h", "ц": "ts", "ч": "ch", "ш": "sh", "щ": "sch", "ъ": "", "ы": "y", "ь": "",
    "э": "e", "ю": "yu", "я": "ya",
}
PLAIN = re.compile(r"^[A-Za-z0-9._-]+$")


def _db_path(conn: sqlite3.Connection) -> Path | None:
    """Файл, с которым работает соединение. База в памяти файла не имеет — тогда и рода на диск не ложатся."""
    for _, name, file in conn.execute("PRAGMA database_list"):
        if name == "main":
            return Path(file) if file else None
    return None


def houses_dir(conn: sqlite3.Connection) -> Path | None:
    db = _db_path(conn)
    if db is None:
        return None
    # рабочая база — рода в папке проекта; любая другая — рядом с ней, чтобы не путать проверку с работой
    return HOUSES_DIR if db.parent == DATA_DIR else db.parent / "houses"


def translit(text: str) -> str:
    out = []
    for char in text.strip():
        low = char.lower()
        if low in TRANSLIT:
            part = TRANSLIT[low]
            out.append(part.capitalize() if char.isupper() and part else part)
        elif char.isalnum() or char in "._-":
            out.append(char)
        elif char.isspace() or char in "'’`":
            out.append("_")
    name = re.sub(r"_+", "_", "".join(out)).strip("_.")
    return name or "rod"


def _pick_name(conn: sqlite3.Connection, clan_id: int, name: str, source_file: str | None) -> str:
    """Имя файла: годится имя загруженного файла — берём его, иначе имя рода латиницей."""
    if source_file and source_file.endswith(".ged") and PLAIN.match(source_file):
        wanted = source_file
    else:
        wanted = f"{translit(name)}.ged"
    taken = {row[0] for row in conn.execute("SELECT file FROM clans WHERE file IS NOT NULL AND id <> ?", (clan_id,))}
    if wanted not in taken:
        return wanted
    stem = wanted[: -len(".ged")]
    number = 2
    while f"{stem}-{number}.ged" in taken:
        number += 1
    return f"{stem}-{number}.ged"


def house_file(conn: sqlite3.Connection, clan_id: int) -> str | None:
    """Имя файла рода; при первом обращении выбирается и запоминается в базе."""
    row = conn.execute("SELECT name, source_file, file FROM clans WHERE id = ?", (clan_id,)).fetchone()
    if row is None:
        return None
    if row["file"]:
        return str(row["file"])
    chosen = _pick_name(conn, clan_id, row["name"], row["source_file"])
    with conn:
        conn.execute("UPDATE clans SET file = ? WHERE id = ?", (chosen, clan_id))
    return chosen


def save_house(conn: sqlite3.Connection, clan_id: int) -> Path | None:
    """Переписать файл рода. Правка уже в базе, поэтому беда с диском её не отменяет — только пишем в журнал."""
    folder = houses_dir(conn)
    if folder is None:
        return None
    name = house_file(conn, clan_id)
    if name is None:
        return None
    path = folder / name
    try:
        folder.mkdir(parents=True, exist_ok=True)
        path.write_text(export_clan(conn, clan_id), encoding="utf-8", newline="\n")
    except OSError as error:
        log.warning("Не удалось записать файл рода %s: %s", path, error)
        return None
    return path
