"""Перезалив файла в существующий род.

Свои узнаются по идентификатору из файла: совпал — человек обновляется и сохраняет id, не совпал — новый.
Кого нет в файле, тот остаётся в роду, пока редактор явно не попросит удалить — молча ничего не удаляется.
Сводка строится честно: перезалив проигрывается на копии базы в памяти, и сравниваются «до» и «после».
"""

from __future__ import annotations

import re
import sqlite3
from collections import Counter
from datetime import UTC, datetime

from pydantic import BaseModel

from app.db.clans import _insert_event, _raw
from app.db.houses import save_house
from app.db.tree import ClanNotFoundError, ClanTree, clan_tree
from app.gedcom.convert import ClanData


class ClanMatch(BaseModel):
    id: int
    name: str
    persons: int
    matched: int  # сколько идентификаторов файла уже есть в этом роду


class PersonBrief(BaseModel):
    id: int
    xref: str
    name: str
    years: str
    where: str  # «сын Тормода и Аилсы», «жена Кеннаха»


class FieldChange(BaseModel):
    label: str
    was: str
    now: str


class PersonChange(BaseModel):
    id: int
    xref: str
    name: str
    changes: list[FieldChange]


class ReloadPreview(BaseModel):
    clan_id: int
    clan_name: str
    matched: int
    total: int
    added: list[PersonBrief]
    changed: list[PersonChange]
    missing: list[PersonBrief]
    tree: ClanTree  # род после перезалива, если никого не удалять


class ReloadReport(BaseModel):
    added: int
    changed: int
    deleted: int
    kept: int


def clan_matches(conn: sqlite3.Connection, data: ClanData) -> list[ClanMatch]:
    xrefs = set(data.persons)
    out = []
    for clan in conn.execute("SELECT id, name FROM clans ORDER BY id"):
        own = [row["xref"] for row in conn.execute("SELECT xref FROM persons WHERE clan_id = ?", (clan["id"],))]
        out.append(ClanMatch(id=clan["id"], name=clan["name"], persons=len(own), matched=len(xrefs.intersection(own))))
    return out


def suggested_name(data: ClanData) -> str:
    """Имя нового рода — самая частая фамилия людей в файле."""
    surnames = Counter(p.surname for p in data.persons.values() if p.surname and not p.is_branch_stub)
    return surnames.most_common(1)[0][0] if surnames else ""


def reload_clan(conn: sqlite3.Connection, clan_id: int, data: ClanData, delete: set[int],
                source_file: str | None = None) -> ReloadReport:
    if conn.execute("SELECT 1 FROM clans WHERE id = ?", (clan_id,)).fetchone() is None:
        raise ClanNotFoundError(clan_id)

    old_persons = {row["xref"]: row["id"] for row in conn.execute("SELECT xref, id FROM persons WHERE clan_id = ?", (clan_id,))}
    old_families = {
        row["xref"]: dict(row)
        for row in conn.execute("SELECT xref, id, husband_id, wife_id FROM families WHERE clan_id = ?", (clan_id,))
    }
    missing = {pid for xref, pid in old_persons.items() if xref not in data.persons}
    deleted = missing & delete
    kept = missing - deleted
    before = _snapshots(conn, clan_id)

    # связи оставленных: вернутся в семьи, которые файл перепишет
    kept_children = [
        dict(row) for row in conn.execute(
            f"SELECT family_id, person_id, pedigree FROM family_children WHERE person_id IN ({_marks(kept)})", tuple(kept))
    ]
    kept_spouses = [
        dict(row) for row in conn.execute(
            f"SELECT family_id, person_id FROM spouse_families WHERE person_id IN ({_marks(kept)})", tuple(kept))
    ]

    with conn:
        # перезалив меняет род мимо журнала: откатывать старые правки поверх нового файла нельзя
        conn.execute("DELETE FROM changes WHERE clan_id = ?", (clan_id,))
        conn.execute(
            "UPDATE clans SET source_file = COALESCE(?, source_file), imported_at = ?, header_raw = ? WHERE id = ?",
            (source_file, datetime.now(UTC).isoformat(timespec="seconds"), _raw(data.header), clan_id),
        )
        conn.executemany("DELETE FROM persons WHERE id = ?", [(pid,) for pid in deleted])

        person_ids: dict[str, int] = {}
        for person in data.persons.values():
            values = (person.uid, person.name_raw, person.given, person.surname, person.married_surname,
                      person.sex, int(person.is_branch_stub), _raw(person.record))
            if person.xref in old_persons:
                pid = old_persons[person.xref]
                conn.execute(
                    """UPDATE persons SET uid = ?, name_raw = ?, given = ?, surname = ?, married_surname = ?,
                              sex = ?, is_branch_stub = ?, raw = ? WHERE id = ?""",
                    (*values, pid),
                )
                conn.execute("DELETE FROM events WHERE person_id = ?", (pid,))
            else:
                pid = conn.execute(
                    """INSERT INTO persons (clan_id, xref, uid, name_raw, given, surname, married_surname,
                                            sex, is_branch_stub, raw) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (clan_id, person.xref, *values),
                ).lastrowid or 0
            person_ids[person.xref] = pid
            for position, event in enumerate(person.events):
                _insert_event(conn, "person_id", pid, position, event)

        family_ids: dict[str, int] = {}
        for family in data.families.values():
            old = old_families.get(family.xref)
            # пустое место супруга в файле не выбрасывает оставленного человека
            husband = person_ids.get(family.husband or "") or (old["husband_id"] if old and old["husband_id"] in kept else None)
            wife = person_ids.get(family.wife or "") or (old["wife_id"] if old and old["wife_id"] in kept else None)
            if old:
                fid = old["id"]
                conn.execute("UPDATE families SET uid = ?, husband_id = ?, wife_id = ?, raw = ? WHERE id = ?",
                             (family.uid, husband, wife, _raw(family.record), fid))
                conn.execute("DELETE FROM events WHERE family_id = ?", (fid,))
                conn.execute("DELETE FROM family_children WHERE family_id = ?", (fid,))
                conn.execute("DELETE FROM spouse_families WHERE family_id = ?", (fid,))
            else:
                fid = conn.execute(
                    "INSERT INTO families (clan_id, xref, uid, husband_id, wife_id, raw) VALUES (?, ?, ?, ?, ?, ?)",
                    (clan_id, family.xref, family.uid, husband, wife, _raw(family.record)),
                ).lastrowid or 0
            family_ids[family.xref] = fid
            for position, event in enumerate(family.events):
                _insert_event(conn, "family_id", fid, position, event)

        # семьи, которых нет в файле, уходят, если в них не осталось никого из оставленных
        for xref, old in old_families.items():
            if xref in data.families:
                continue
            members = {old["husband_id"], old["wife_id"]} | {
                row[0] for row in conn.execute("SELECT person_id FROM family_children WHERE family_id = ?", (old["id"],))
            }
            if not members & kept:
                conn.execute("DELETE FROM families WHERE id = ?", (old["id"],))

        for family in data.families.values():
            for position, child in enumerate(family.children):
                if child not in person_ids:
                    continue
                pedigree = next(
                    (link.pedigree for link in data.persons[child].parent_families if link.family == family.xref), None)
                conn.execute(
                    "INSERT OR IGNORE INTO family_children (family_id, person_id, position, pedigree) VALUES (?, ?, ?, ?)",
                    (family_ids[family.xref], person_ids[child], position, pedigree),
                )
        for person in data.persons.values():
            for position, xref in enumerate(person.spouse_families):
                if xref in family_ids:
                    conn.execute(
                        "INSERT OR IGNORE INTO spouse_families (person_id, family_id, position) VALUES (?, ?, ?)",
                        (person_ids[person.xref], family_ids[xref], position),
                    )

        alive = {row[0] for row in conn.execute("SELECT id FROM families WHERE clan_id = ?", (clan_id,))}
        for row in kept_children:
            if row["family_id"] in alive:
                conn.execute(
                    """INSERT OR IGNORE INTO family_children (family_id, person_id, position, pedigree)
                       VALUES (?, ?, (SELECT COALESCE(MAX(position) + 1, 0) FROM family_children WHERE family_id = ?), ?)""",
                    (row["family_id"], row["person_id"], row["family_id"], row["pedigree"]),
                )
        for row in kept_spouses:
            if row["family_id"] in alive:
                conn.execute(
                    """INSERT OR IGNORE INTO spouse_families (person_id, family_id, position)
                       VALUES (?, ?, (SELECT COALESCE(MAX(position) + 1, 0) FROM spouse_families WHERE person_id = ?))""",
                    (row["person_id"], row["family_id"], row["person_id"]),
                )

        conn.execute("DELETE FROM extra_records WHERE clan_id = ?", (clan_id,))
        for position, record in enumerate(data.extras):
            conn.execute("INSERT INTO extra_records (clan_id, position, tag, xref, raw) VALUES (?, ?, ?, ?, ?)",
                         (clan_id, position, record.tag, record.xref, _raw(record)))

    save_house(conn, clan_id)
    after = _snapshots(conn, clan_id)
    changed = sum(1 for xref in data.persons if xref in before and before[xref] != after.get(xref))
    return ReloadReport(added=len(set(data.persons) - set(old_persons)), changed=changed,
                        deleted=len(deleted), kept=len(kept))


def preview_reload(conn: sqlite3.Connection, clan_id: int, data: ClanData) -> ReloadPreview:
    clan = conn.execute("SELECT name FROM clans WHERE id = ?", (clan_id,)).fetchone()
    if clan is None:
        raise ClanNotFoundError(clan_id)

    copy = sqlite3.connect(":memory:")
    conn.backup(copy)
    copy.row_factory = sqlite3.Row
    copy.execute("PRAGMA foreign_keys = ON")
    try:
        before = _snapshots(conn, clan_id)
        reload_clan(copy, clan_id, data, delete=set())
        after = _snapshots(copy, clan_id)
        old_ids = {row["xref"]: row["id"] for row in conn.execute("SELECT xref, id FROM persons WHERE clan_id = ?", (clan_id,))}
        new_ids = {row["xref"]: row["id"] for row in copy.execute("SELECT xref, id FROM persons WHERE clan_id = ?", (clan_id,))}

        added = [_brief(copy, new_ids[x], x) for x in data.persons if x not in old_ids]
        missing = [_brief(conn, pid, x) for x, pid in old_ids.items() if x not in data.persons]
        changed = []
        for xref in data.persons:
            if xref not in before:
                continue
            was, now = before[xref], after[xref]
            fields = [
                FieldChange(label=label, was=was.get(label) or "—", now=now.get(label) or "—")
                for label in _LABELS if (was.get(label) or "") != (now.get(label) or "")
            ]
            if not fields and was["_raw"] != now["_raw"]:
                fields = [FieldChange(label="Прочее в записи", was="", now="изменено")]
            if fields:
                changed.append(PersonChange(id=old_ids[xref], xref=xref, name=_name(now), changes=fields))

        return ReloadPreview(
            clan_id=clan_id, clan_name=clan["name"],
            matched=len(set(data.persons) & set(old_ids)), total=len(data.persons),
            added=added, changed=changed, missing=missing, tree=clan_tree(copy, clan_id),
        )
    finally:
        copy.close()


_LABELS = ["Имя", "Фамилия", "Фамилия по мужу", "Пол", "Рождение", "Место рождения", "Смерть", "Место смерти",
           "Родители", "Браки", "Заметки", "Другие события"]
_SEX = {"M": "мужской", "F": "женский", "U": "неизвестен"}


def _marks(ids: set[int]) -> str:
    return ",".join("?" * len(ids)) or "NULL"


def _name(snapshot: dict[str, str]) -> str:
    return " ".join(part for part in (snapshot.get("Имя"), snapshot.get("Фамилия")) if part) or "без имени"


def _snapshots(conn: sqlite3.Connection, clan_id: int) -> dict[str, dict[str, str]]:
    """Сведения о каждом человеке рода словами — то, что видно в панели. По ним сравнивается «до» и «после»."""
    persons = {row["id"]: dict(row) for row in conn.execute(
        "SELECT id, xref, given, surname, married_surname, sex, raw FROM persons WHERE clan_id = ?", (clan_id,))}
    given = {pid: p["given"] or "?" for pid, p in persons.items()}
    out: dict[int, dict[str, str]] = {
        pid: {"Имя": p["given"] or "", "Фамилия": p["surname"] or "", "Фамилия по мужу": p["married_surname"] or "",
              "Пол": _SEX.get(p["sex"] or "", ""), "_raw": p["raw"], "_xref": p["xref"]}
        for pid, p in persons.items()
    }
    other: dict[int, list[str]] = {}
    notes: dict[int, list[str]] = {}
    for row in conn.execute(
        """SELECT e.person_id, e.tag, e.type, e.value, e.date_raw, pl.name AS place FROM events e
             JOIN persons p ON p.id = e.person_id LEFT JOIN places pl ON pl.id = e.place_id
            WHERE p.clan_id = ? ORDER BY e.person_id, e.position""", (clan_id,)):
        snap = out[row["person_id"]]
        if row["tag"] in ("BIRT", "DEAT"):
            date, place = ("Рождение", "Место рождения") if row["tag"] == "BIRT" else ("Смерть", "Место смерти")
            if date not in snap:
                snap[date] = row["date_raw"] or ""
                snap[place] = row["place"] or ""
        elif row["tag"] == "EVEN" and row["value"]:
            notes.setdefault(row["person_id"], []).append(row["value"])
        else:
            text = " ".join(t for t in (row["tag"], row["value"], row["date_raw"], row["place"]) if t)
            other.setdefault(row["person_id"], []).append(text)
    for pid, items in notes.items():
        out[pid]["Заметки"] = _short(items)
    for pid, items in other.items():
        out[pid]["Другие события"] = "; ".join(items)

    for row in conn.execute(
        """SELECT fc.person_id, f.husband_id, f.wife_id FROM family_children fc JOIN families f ON f.id = fc.family_id
            WHERE f.clan_id = ? ORDER BY fc.person_id, f.id""", (clan_id,)):
        names = " и ".join(given[p] for p in (row["husband_id"], row["wife_id"]) if p in given)
        snap = out[row["person_id"]]
        snap["Родители"] = "; ".join(filter(None, [snap.get("Родители", ""), names]))
    for row in conn.execute(
        """SELECT sf.person_id, f.husband_id, f.wife_id FROM spouse_families sf JOIN families f ON f.id = sf.family_id
            WHERE f.clan_id = ? ORDER BY sf.person_id, sf.position""", (clan_id,)):
        spouse = row["wife_id"] if row["husband_id"] == row["person_id"] else row["husband_id"]
        snap = out[row["person_id"]]
        snap["Браки"] = ", ".join(filter(None, [snap.get("Браки", ""), given.get(spouse, "неизвестен")]))
    return {snap["_xref"]: snap for snap in out.values()}


def _short(items: list[str]) -> str:
    text = " / ".join(items)
    return text if len(text) <= 80 else text[:79] + "…"


def _brief(conn: sqlite3.Connection, person_id: int, xref: str) -> PersonBrief:
    person = conn.execute("SELECT clan_id, given, surname, sex FROM persons WHERE id = ?", (person_id,)).fetchone()
    years = [row["date_raw"] for row in conn.execute(
        "SELECT date_raw FROM events WHERE person_id = ? AND tag IN ('BIRT', 'DEAT') ORDER BY tag = 'DEAT', position", (person_id,))
        if row["date_raw"]]
    parents = conn.execute(
        """SELECT h.given AS husband, h.sex AS husband_sex, w.given AS wife, w.sex AS wife_sex
             FROM family_children fc JOIN families f ON f.id = fc.family_id
             LEFT JOIN persons h ON h.id = f.husband_id LEFT JOIN persons w ON w.id = f.wife_id
            WHERE fc.person_id = ? LIMIT 1""", (person_id,)).fetchone()
    where = ""
    if parents and (parents["husband"] or parents["wife"]):
        role = {"M": "сын", "F": "дочь"}.get(person["sex"] or "", "ребёнок")
        names = [_genitive(parents[k], parents[f"{k}_sex"]) for k in ("husband", "wife") if parents[k]]
        where = f"{role} {' и '.join(names)}"
    else:
        spouse = conn.execute(
            """SELECT CASE WHEN f.husband_id = ? THEN w.given ELSE h.given END AS name,
                      CASE WHEN f.husband_id = ? THEN w.sex ELSE h.sex END AS sex FROM spouse_families sf
                 JOIN families f ON f.id = sf.family_id LEFT JOIN persons h ON h.id = f.husband_id
                 LEFT JOIN persons w ON w.id = f.wife_id WHERE sf.person_id = ? ORDER BY sf.position LIMIT 1""",
            (person_id, person_id, person_id)).fetchone()
        if spouse and spouse["name"]:
            role = {"F": "жена", "M": "муж"}.get(person["sex"] or "", "супруг")
            where = f"{role} {_genitive(spouse['name'], spouse['sex'])}"
    name = " ".join(p for p in (person["given"], person["surname"]) if p) or "без имени"
    return PersonBrief(id=person_id, xref=xref, name=name, years=" — ".join(years), where=where)


def _genitive(name: str, sex: str | None) -> str:
    """Родительный падеж личного имени для подписи «сын Тормода и Аилсы». Несклоняемые и незнакомые — как есть."""
    if " " in name or not re.fullmatch(r"[А-Яа-яЁё-]+", name):
        return name
    last = name[-1]
    if last in "ая" and sex != "U":
        return name[:-1] + ("и" if last == "я" or name[-2:-1] in "гкхжчшщ" else "ы")
    if sex == "M":
        if last in "ьй":
            return name[:-1] + "я"
        if last not in "аеёиоуыэюя":
            return name + "а"
    return name
