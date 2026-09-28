"""Запись рода в базу. Заливка всегда идёт в явно названный род, новый."""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass, field
from datetime import UTC, datetime

from app.db.houses import save_house
from app.gedcom.convert import ClanData, Event
from app.gedcom.records import Record


class ClanExistsError(ValueError):
    pass


@dataclass
class ImportReport:
    clan_id: int
    name: str
    persons: int
    families: int
    events: int
    branch_stubs: int
    places: int
    warnings: list[str] = field(default_factory=list)


def _raw(record: Record | None) -> str | None:
    return json.dumps(record.to_json(), ensure_ascii=False, separators=(",", ":")) if record else None


def _place_id(conn: sqlite3.Connection, name: str | None) -> int | None:
    if not name:
        return None
    conn.execute("INSERT OR IGNORE INTO places (name) VALUES (?)", (name,))
    return conn.execute("SELECT id FROM places WHERE name = ?", (name,)).fetchone()[0]


def _insert_event(conn: sqlite3.Connection, owner: str, owner_id: int, position: int, event: Event) -> None:
    date = event.date
    start = date.start if date else None
    end = date.end if date else None
    conn.execute(
        f"""INSERT INTO events ({owner}, position, tag, type, value, date_raw, date_kind,
               date_year, date_month, date_day, date_end_year, date_end_month, date_end_day,
               date_phrase, place_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            owner_id, position, event.tag, event.type, event.value,
            date.raw if date else None, date.kind if date else None,
            start.year if start else None, start.month if start else None, start.day if start else None,
            end.year if end else None, end.month if end else None, end.day if end else None,
            date.phrase if date else None,
            _place_id(conn, event.place),
        ),
    )


def import_clan(conn: sqlite3.Connection, name: str, data: ClanData, source_file: str | None = None) -> ImportReport:
    name = name.strip()
    if not name:
        raise ValueError("у рода должно быть имя")
    if conn.execute("SELECT 1 FROM clans WHERE name = ?", (name,)).fetchone():
        raise ClanExistsError(f"род «{name}» уже есть в базе")

    places_before = conn.execute("SELECT COUNT(*) FROM places").fetchone()[0]
    events = 0
    with conn:
        clan_id = conn.execute(
            "INSERT INTO clans (name, source_file, imported_at, header_raw) VALUES (?, ?, ?, ?)",
            (name, source_file, datetime.now(UTC).isoformat(timespec="seconds"), _raw(data.header)),
        ).lastrowid
        assert clan_id is not None

        person_ids: dict[str, int] = {}
        for person in data.persons.values():
            person_ids[person.xref] = conn.execute(
                """INSERT INTO persons (clan_id, xref, uid, name_raw, given, surname, married_surname,
                                        sex, is_branch_stub, raw)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    clan_id, person.xref, person.uid, person.name_raw, person.given, person.surname,
                    person.married_surname, person.sex, int(person.is_branch_stub), _raw(person.record),
                ),
            ).lastrowid or 0
            for position, event in enumerate(person.events):
                _insert_event(conn, "person_id", person_ids[person.xref], position, event)
                events += 1

        family_ids: dict[str, int] = {}
        for family in data.families.values():
            family_ids[family.xref] = conn.execute(
                "INSERT INTO families (clan_id, xref, uid, husband_id, wife_id, raw) VALUES (?, ?, ?, ?, ?, ?)",
                (
                    clan_id, family.xref, family.uid,
                    person_ids.get(family.husband or ""), person_ids.get(family.wife or ""),
                    _raw(family.record),
                ),
            ).lastrowid or 0
            for position, event in enumerate(family.events):
                _insert_event(conn, "family_id", family_ids[family.xref], position, event)
                events += 1

        for family in data.families.values():
            for position, child in enumerate(family.children):
                if child not in person_ids:
                    continue
                pedigree = next(
                    (link.pedigree for link in data.persons[child].parent_families if link.family == family.xref),
                    None,
                )
                conn.execute(
                    "INSERT INTO family_children (family_id, person_id, position, pedigree) VALUES (?, ?, ?, ?)",
                    (family_ids[family.xref], person_ids[child], position, pedigree),
                )

        for person in data.persons.values():
            for position, xref in enumerate(person.spouse_families):
                if xref in family_ids:
                    conn.execute(
                        "INSERT OR IGNORE INTO spouse_families (person_id, family_id, position) VALUES (?, ?, ?)",
                        (person_ids[person.xref], family_ids[xref], position),
                    )

        for position, record in enumerate(data.extras):
            conn.execute(
                "INSERT INTO extra_records (clan_id, position, tag, xref, raw) VALUES (?, ?, ?, ?, ?)",
                (clan_id, position, record.tag, record.xref, _raw(record)),
            )

    save_house(conn, clan_id)
    return ImportReport(
        clan_id=clan_id,
        name=name,
        persons=len(data.persons),
        families=len(data.families),
        events=events,
        branch_stubs=sum(p.is_branch_stub for p in data.persons.values()),
        places=conn.execute("SELECT COUNT(*) FROM places").fetchone()[0] - places_before,
        warnings=list(data.warnings),
    )
