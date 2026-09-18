"""Правка родни без удаления людей и правка семьи как отдельной записи.

Родство в GEDCOM держится на ссылках с двух сторон: у семьи HUSB, WIFE и CHIL, у человека FAMS и FAMC,
у ребёнка при FAMC ещё тип родства PEDI. Правка всегда меняет обе стороны, иначе файл разойдётся сам с собой.
Семья, в которой не осталось никого, кроме одного супруга без детей, уходит — как при удалении человека.
Семья, где остались одни дети, законна: это братья и сёстры с неизвестными родителями.

    1 _MORDER Y        у человека: очередь его браков задана вручную, порядок FAMS главнее правила
"""

from __future__ import annotations

import sqlite3
from typing import Literal

from pydantic import BaseModel

from app.db.journal import ChangeInfo, Edit, JournalError
from app.gedcom.convert import _person
from app.gedcom.records import Record

Pedigree = Literal["birth", "adopted", "foster"]
MANUAL_ORDER = "_MORDER"
PEDIGREE_RU = {"birth": "родное", "adopted": "приёмное", "foster": "под опекой"}


class KinError(ValueError):
    pass


class ParentChange(BaseModel):
    """Семья, где человек записан ребёнком: оставить, отвязать или перенести в другую; тип родства."""

    family_id: int
    action: Literal["keep", "drop", "move"] = "keep"
    to_family_id: int | None = None
    pedigree: Pedigree | None = None


class SpouseChange(BaseModel):
    """Союз человека: оставить, выйти из него или поставить на своё место другого."""

    family_id: int
    action: Literal["keep", "drop", "replace"] = "keep"
    to_person_id: int | None = None


class KinChanges(BaseModel):
    parents: list[ParentChange] = []
    spouses: list[SpouseChange] = []
    marriage_order: list[int] | None = None  # союзы по очереди; None — не трогать
    marriage_order_auto: bool = False  # вернуть очередь правилу


# ── ссылки ──

def _id(conn: sqlite3.Connection, clan_id: int, table: str, xref: str | None) -> int | None:
    if not xref:
        return None
    row = conn.execute(f"SELECT id FROM {table} WHERE clan_id = ? AND xref = ?", (clan_id, xref)).fetchone()
    return row[0] if row else None


def _first(record: Record) -> str:
    return _person(record).given or "без имени"


def _by_sex(record: Record, male: str, female: str) -> str:
    return female if _person(record).sex == "F" else male


def couple(edit: Edit, conn: sqlite3.Connection, family_id: int) -> str:
    """«Мурдо и Аина», «Мурдо», «неизвестные родители»."""
    family = edit.family(family_id)
    names = [_first(edit.person(pid)) for tag in ("HUSB", "WIFE")
             if (pid := _id(conn, edit.clan_id, "persons", family.value_of(tag))) is not None]
    return " и ".join(names) or "неизвестные родители"


def _unlink(record: Record, tag: str, pointer: str) -> None:
    record.children = [c for c in record.children if not (c.tag == tag and c.value == pointer)]


def _link(record: Record, tag: str, pointer: str, pedigree: str | None = None) -> None:
    if any(c.value == pointer for c in record.all(tag)):
        return
    link = Record(level=1, tag=tag, value=pointer)
    if pedigree and pedigree != "birth":
        link.children.append(Record(level=2, tag="PEDI", value=pedigree))
    record.children.append(link)


def _pedigree_of(record: Record, family_xref: str) -> str:
    link = next((c for c in record.all("FAMC") if c.value == family_xref), None)
    return (link.value_of("PEDI") or "birth").lower() if link else "birth"


def set_pedigree(record: Record, family_xref: str, pedigree: str) -> None:
    link = next((c for c in record.all("FAMC") if c.value == family_xref), None)
    if link is None:
        return
    link.children = [c for c in link.children if c.tag != "PEDI"]
    if pedigree != "birth":
        link.children.append(Record(level=2, tag="PEDI", value=pedigree))


def prune(edit: Edit, conn: sqlite3.Connection, family_id: int) -> None:
    """Семья из одного супруга без детей или совсем пустая — уходит, ссылки на неё снимаются."""
    family = edit.family(family_id)
    members = [c for c in family.children if c.tag in ("HUSB", "WIFE", "CHIL")]
    if family.all("CHIL") or len(members) > 1:
        return
    for member in members:
        pid = _id(conn, edit.clan_id, "persons", member.value)
        if pid is not None:
            person = edit.person(pid)
            _unlink(person, "FAMS", family.xref or "")
            _unlink(person, "FAMC", family.xref or "")
    edit.drop("FAM", family_id)


def detach_child(edit: Edit, conn: sqlite3.Connection, family_id: int, child_id: int) -> None:
    family = edit.family(family_id)
    pointer = edit.xref_of("INDI", child_id)
    _unlink(family, "CHIL", pointer)
    _unlink(edit.person(child_id), "FAMC", family.xref or "")
    prune(edit, conn, family_id)


def _descendants(conn: sqlite3.Connection, person_id: int) -> set[int]:
    out: set[int] = set()
    stack = [person_id]
    while stack:
        pid = stack.pop()
        for (family_id,) in conn.execute("SELECT family_id FROM spouse_families WHERE person_id = ?", (pid,)):
            for (child,) in conn.execute("SELECT person_id FROM family_children WHERE family_id = ?", (family_id,)):
                if child not in out:
                    out.add(child)
                    stack.append(child)
    return out


def _check_family(conn: sqlite3.Connection, clan_id: int, family_id: int) -> sqlite3.Row:
    row = conn.execute("SELECT clan_id, husband_id, wife_id FROM families WHERE id = ?", (family_id,)).fetchone()
    if row is None or row["clan_id"] != clan_id:
        raise KinError("Такой семьи в роду нет")
    return row


# ── родня человека ──

def apply_kin(edit: Edit, conn: sqlite3.Connection, person_id: int, kin: KinChanges) -> list[str]:
    """Поменять родню в той же правке, что и поля. Возвращает части описания для журнала."""
    record = edit.person(person_id)
    parts: list[str] = []
    child_of = {r[0] for r in conn.execute("SELECT family_id FROM family_children WHERE person_id = ?", (person_id,))}
    spouse_of = [r[0] for r in conn.execute(
        "SELECT family_id FROM spouse_families WHERE person_id = ? ORDER BY position", (person_id,))]

    for change in kin.parents:
        if change.family_id not in child_of:
            raise KinError("Человек не записан ребёнком в этой семье")
        xref = edit.xref_of("FAM", change.family_id)
        was = couple(edit, conn, change.family_id)
        if change.action == "drop":
            detach_child(edit, conn, change.family_id, person_id)
            parts.append(f"{_by_sex(record, 'отвязан', 'отвязана')} от родителей: {was}")
            continue
        pedigree = change.pedigree or _pedigree_of(record, xref)
        if change.action == "move":
            target = change.to_family_id
            if target is None or target == change.family_id:
                raise KinError("Выберите другую семью")
            row = _check_family(conn, edit.clan_id, target)
            if target in child_of:
                raise KinError("Человек уже записан в этой семье")
            below = _descendants(conn, person_id) | {person_id}
            if row["husband_id"] in below or row["wife_id"] in below:
                raise KinError("Нельзя стать ребёнком самого себя или своего потомка")
            detach_child(edit, conn, change.family_id, person_id)
            family = edit.family(target)
            family.children.append(Record(level=1, tag="CHIL", value=edit.xref_of("INDI", person_id)))
            _link(record, "FAMC", family.xref or "", pedigree)
            parts.append(f"{_by_sex(record, 'перенесён', 'перенесена')} к родителям: {couple(edit, conn, target)}")
        elif change.pedigree and change.pedigree != _pedigree_of(record, xref):
            set_pedigree(record, xref, change.pedigree)
            parts.append(f"родство с {was} — {PEDIGREE_RU[change.pedigree]}")

    for change in kin.spouses:
        if change.family_id not in spouse_of:
            raise KinError("Человек не записан супругом в этой семье")
        if change.action == "keep":
            continue
        family = edit.family(change.family_id)
        pointer = edit.xref_of("INDI", person_id)
        slot = next((c for c in family.children if c.tag in ("HUSB", "WIFE") and c.value == pointer), None)
        others = [c for c in family.children if c.tag in ("HUSB", "WIFE") and c.value != pointer]
        partner = _first(edit.person(pid)) if others and (pid := _id(conn, edit.clan_id, "persons", others[0].value)) else None
        if change.action == "drop":
            if slot is not None:
                family.children.remove(slot)
            _unlink(record, "FAMS", family.xref or "")
            prune(edit, conn, change.family_id)
            parts.append(f"союз с {partner} разорван" if partner else _by_sex(record, "вышел из союза", "вышла из союза"))
        else:
            new = change.to_person_id
            if new is None or new == person_id:
                raise KinError("Выберите другого человека")
            if conn.execute("SELECT clan_id FROM persons WHERE id = ?", (new,)).fetchone()[0] != edit.clan_id:
                raise KinError("Заменить можно только человеком этого рода")
            new_pointer = edit.xref_of("INDI", new)
            if any(c.value == new_pointer for c in family.children if c.tag in ("HUSB", "WIFE", "CHIL")):
                raise KinError("Этот человек уже в этой семье")
            if slot is not None:
                slot.value = new_pointer
            _unlink(record, "FAMS", family.xref or "")
            _link(edit.person(new), "FAMS", family.xref or "")
            taker = edit.person(new)
            parts.append(f"в союзе{f' с {partner}' if partner else ''} теперь {_first(taker)} — {_by_sex(taker, 'заменил', 'заменила')}")

    if kin.marriage_order is not None:
        current = [c for c in record.children if c.tag == "FAMS"]
        by_id = {}
        for link in current:
            fid = _id(conn, edit.clan_id, "families", link.value)
            if fid is not None:
                by_id[fid] = link
        if sorted(kin.marriage_order) != sorted(by_id):
            raise KinError("Очередь браков не совпадает с браками человека")
        slots = [i for i, c in enumerate(record.children) if c.tag == "FAMS" and c in by_id.values()]
        for i, fid in zip(slots, kin.marriage_order, strict=True):
            record.children[i] = by_id[fid]
        record.children = [c for c in record.children if c.tag != MANUAL_ORDER]
        record.children.append(Record(level=1, tag=MANUAL_ORDER, value="Y"))
        parts.append("очередь браков")
    elif kin.marriage_order_auto and record.first(MANUAL_ORDER) is not None:
        record.children = [c for c in record.children if c.tag != MANUAL_ORDER]
        parts.append("очередь браков — по правилу")
    return parts


def manual_order(record: Record) -> bool:
    return (record.value_of(MANUAL_ORDER) or "").upper() == "Y"


# ── семья ──

class DateValue(BaseModel):
    gedcom: str | None
    ru: str
    input: str  # что поставить в поле: по-русски, если это читается обратно в ту же дату, иначе строка GEDCOM


class FamilyChild(BaseModel):
    id: int
    pedigree: Pedigree


class FamilyForm(BaseModel):
    id: int
    clan_id: int
    xref: str
    husband: int | None
    wife: int | None
    marriage: DateValue
    place: str | None
    divorced: bool
    divorce: DateValue
    children: list[FamilyChild]  # в порядке файла


class FamilyFields(BaseModel):
    marriage: str | None = None
    place: str | None = None
    divorced: bool = False
    divorce: str | None = None
    children: list[int] | None = None  # новый порядок оставшихся детей
    unlink: list[int] = []  # дети, которых отвязать


def family_form(conn: sqlite3.Connection, family_id: int) -> FamilyForm:
    from app.db.editor import date_value

    row = conn.execute("SELECT clan_id, xref, husband_id, wife_id, raw FROM families WHERE id = ?", (family_id,)).fetchone()
    if row is None:
        raise KinError("Такой семьи нет")
    import json

    record = Record.from_json(json.loads(row["raw"]))
    marr, div = record.first("MARR"), record.first("DIV")
    children = []
    for (child,) in conn.execute("SELECT person_id FROM family_children WHERE family_id = ? ORDER BY position", (family_id,)):
        pedigree = conn.execute("SELECT pedigree FROM family_children WHERE family_id = ? AND person_id = ?",
                                (family_id, child)).fetchone()[0]
        children.append(FamilyChild(id=child, pedigree=(pedigree or "birth").lower()
                                    if (pedigree or "birth").lower() in PEDIGREE_RU else "birth"))
    return FamilyForm(
        id=family_id, clan_id=row["clan_id"], xref=row["xref"], husband=row["husband_id"], wife=row["wife_id"],
        marriage=date_value(marr.value_of("DATE") if marr else None), place=marr.value_of("PLAC") if marr else None,
        divorced=div is not None, divorce=date_value(div.value_of("DATE") if div else None), children=children,
    )


def _event(family: Record, tag: str) -> Record:
    event = family.first(tag)
    if event is None:
        event = Record(level=1, tag=tag)
        # события семьи — после супругов и детей, как пишут программы
        at = max((i for i, c in enumerate(family.children) if c.tag in ("HUSB", "WIFE", "CHIL", "MARR")), default=-1)
        family.children.insert(at + 1, event)
    return event


def _put(event: Record, tag: str, value: str | None) -> None:
    event.children = [c for c in event.children if c.tag != tag]
    if value:
        at = 0 if tag == "DATE" else len(event.children)
        event.children.insert(at, Record(level=event.level + 1, tag=tag, value=value))


def update_family(conn: sqlite3.Connection, family_id: int, fields: FamilyFields) -> ChangeInfo:
    from app.db.editor import EditError, _date, _date_ru_value

    row = conn.execute("SELECT clan_id FROM families WHERE id = ?", (family_id,)).fetchone()
    if row is None:
        raise KinError("Такой семьи нет")
    edit = Edit(conn, row[0])
    family = edit.family(family_id)
    name = couple(edit, conn, family_id)
    before = Record.from_json(family.to_json())
    parts: list[str] = []
    try:
        marriage = _date(fields.marriage, "Венчание")
        divorce = _date(fields.divorce, "Развод")
    except EditError as error:
        raise KinError(str(error)) from None

    place = (fields.place or "").strip() or None
    if marriage or place:
        event = _event(family, "MARR")
        _put(event, "DATE", marriage)
        _put(event, "PLAC", place)
        event.value = None
    elif (event := family.first("MARR")) is not None:
        _put(event, "DATE", None)
        _put(event, "PLAC", None)
        if not event.children:
            family.children.remove(event)
    if fields.divorced:
        event = _event(family, "DIV")
        _put(event, "DATE", divorce)
        event.value = None if divorce else "Y"
    elif family.first("DIV") is not None:
        family.children = [c for c in family.children if c.tag != "DIV"]

    was, now = before.first("MARR"), family.first("MARR")
    if _date_ru_value(was) != _date_ru_value(now) or (was and was.value_of("PLAC")) != (now and now.value_of("PLAC")):
        parts.append(f"венчание {_date_ru_value(now)}" + (f", {now.value_of('PLAC')}" if now and now.value_of("PLAC") else ""))
    if (before.first("DIV") is None) != (family.first("DIV") is None):
        parts.append("развод" if family.first("DIV") is not None else "развода нет")
    elif family.first("DIV") is not None and _date_ru_value(before.first("DIV")) != _date_ru_value(family.first("DIV")):
        parts.append(f"развод {_date_ru_value(family.first('DIV'))}")

    ids = {pid: link for link in family.all("CHIL") if (pid := _id(conn, edit.clan_id, "persons", link.value)) is not None}
    for child in fields.unlink:
        if child not in ids:
            raise KinError("Этот человек не записан ребёнком в семье")
        kid = edit.person(child)
        parts.append(f"{_by_sex(kid, 'отвязан', 'отвязана')} {_first(kid)}")
    if fields.children is not None:
        rest = [pid for pid in ids if pid not in fields.unlink]
        if sorted(fields.children) != sorted(rest):
            raise KinError("Порядок детей не совпадает с детьми семьи")
        if fields.children != rest:
            slots = [i for i, c in enumerate(family.children) if c.tag == "CHIL" and c in ids.values()]
            order = fields.children + [pid for pid in ids if pid in fields.unlink]
            for i, pid in zip(slots, order, strict=True):
                family.children[i] = ids[pid]
            parts.append("порядок детей")
    for child in fields.unlink:
        detach_child(edit, conn, family_id, child)
    edit.summary = f"{name}: {', '.join(parts) or 'правка'}"
    try:
        return edit.commit()
    except JournalError as error:
        raise KinError(str(error)) from None
