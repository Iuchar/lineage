"""Род → файл GEDCOM 5.5.1. Без потерь: записи уходят теми же деревьями, что пришли из файла и что правит
редактор, — со всеми тегами, которых приложение не понимает. Порядок — как в исходных файлах: заголовок,
люди, семьи, прочие записи, конец файла.

Выгрузить род может любой, но каждый получает свой слой: редактор — всё, свой для рода — общее и родовое,
прочий зритель — только общее. Отбор тот же, что у дерева на карте (app/db/eyes.py), только по записям файла:
скрытого человека в файле нет вовсе, и ничто на него не ссылается.
"""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Callable

from app.gedcom.meta import PHOTO_PREFIX, See, read_meta, read_note_see
from app.gedcom.records import Record

Allows = Callable[[See], bool]  # видно ли этим глазам то, что закрыто таким уровнем


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


def _load(raw: str) -> Record:
    return Record.from_json(json.loads(raw))


def _sift_person(record: Record, allows: Allows) -> Record | None:
    """Запись человека для зрителя: None — человека ему не видно вовсе."""
    meta = read_meta(record)
    if not allows(meta.see):
        return None
    kept: list[Record] = []
    for child in record.children:
        if child.tag in ("_SEE", "_HIDDEN"):
            continue  # разметка доступа — дело нашей базы, зрителю она ни к чему
        if child.tag == "EVEN" and child.value_of("TYPE") == "Comment":
            if not allows(read_note_see(child)):
                continue
            child.children = [c for c in child.children if c.tag != "_SEE"]
        if child.tag in ("BIRT", "DEAT") and not allows(meta.see_dates):
            child.children = [c for c in child.children if c.tag != "DATE"]
            if not child.children and not child.value:
                continue  # от события осталась одна дата — без неё оно пустое
        if not allows(meta.see_portrait) and (
                child.tag == "_PORTRAIT" or (child.tag == "OBJE" and (child.value_of("FILE") or "").startswith(PHOTO_PREFIX))):
            continue
        kept.append(child)
    record.children = kept
    return record


def _sift(persons: list[Record], families: list[Record], allows: Allows) -> tuple[list[Record], list[Record]]:
    people = []
    gone: set[str] = set()
    for record in persons:
        seen = _sift_person(record, allows)
        if seen is None:
            if record.xref:
                gone.add(record.xref)
        else:
            people.append(seen)

    unions = []
    dropped: set[str] = set()
    for family in families:
        lost = any(c.tag in ("HUSB", "WIFE") and c.value in gone for c in family.children)
        family.children = [c for c in family.children if not (c.tag in ("HUSB", "WIFE", "CHIL") and c.value in gone)]
        if lost:
            # супруг скрыт — уходит и всё о браке: венчание и развод говорили бы, что он был.
            # То же правило, что в дереве и в карточке союза: остаются только дети
            family.children = [c for c in family.children if c.tag in ("HUSB", "WIFE", "CHIL")]
        # союз, в котором не осталось никого, — намёк на скрытых: его тоже нет.
        # Как и бездетный союз со скрытым супругом: показывать в нём нечего
        members = {c.tag for c in family.children} & {"HUSB", "WIFE", "CHIL"}
        if not members or (lost and "CHIL" not in members):
            if family.xref:
                dropped.add(family.xref)
            continue
        unions.append(family)
    for person in people:
        person.children = [c for c in person.children if not (c.tag in ("FAMC", "FAMS") and c.value in dropped)]
    return people, unions


def export_clan(conn: sqlite3.Connection, clan_id: int, allows: Allows | None = None) -> str:
    """Файл рода. allows — чьими глазами: None — редактор, всё без отбора."""
    clan = conn.execute("SELECT name, header_raw FROM clans WHERE id = ?", (clan_id,)).fetchone()
    if clan is None:
        raise ExportError(clan_id)
    lines = _lines(clan["header_raw"]) if clan["header_raw"] else _header().to_lines()
    persons = [_load(raw) for (raw,) in conn.execute("SELECT raw FROM persons WHERE clan_id = ? ORDER BY id", (clan_id,))]
    families = [_load(raw) for (raw,) in conn.execute("SELECT raw FROM families WHERE clan_id = ? ORDER BY id", (clan_id,))]
    if allows is not None:
        persons, families = _sift(persons, families, allows)
    for record in persons + families:
        lines += record.to_lines()
    for (raw,) in conn.execute("SELECT raw FROM extra_records WHERE clan_id = ? ORDER BY position", (clan_id,)):
        lines += _lines(raw)
    lines.append("0 TRLR")
    return "\n".join(lines) + "\n"
