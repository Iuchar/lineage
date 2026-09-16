"""Чтение рода для холста: люди, семьи и всё, что нужно раскладке и карточкам."""

from __future__ import annotations

import sqlite3
from typing import Literal

from pydantic import BaseModel


class ClanSummary(BaseModel):
    id: int
    name: str
    persons: int
    families: int


class LifeDate(BaseModel):
    raw: str | None
    kind: str | None
    year: int | None
    month: int | None
    day: int | None
    end_year: int | None
    end_month: int | None
    end_day: int | None
    phrase: str | None


class TreePerson(BaseModel):
    id: int
    xref: str
    given: str | None
    surname: str | None
    married_surname: str | None
    sex: Literal["M", "F", "U"] | None
    is_branch_stub: bool
    birth: LifeDate | None
    death: LifeDate | None
    parent_families: list[int]
    spouse_families: list[int]  # в порядке браков


class TreeFamily(BaseModel):
    id: int
    xref: str
    husband: int | None
    wife: int | None
    children: list[int]  # в порядке файла


class ClanTree(BaseModel):
    clan: ClanSummary
    persons: list[TreePerson]
    families: list[TreeFamily]


class ClanNotFoundError(LookupError):
    pass


_SUMMARY = """SELECT c.id, c.name,
                  (SELECT COUNT(*) FROM persons p WHERE p.clan_id = c.id) AS persons,
                  (SELECT COUNT(*) FROM families f WHERE f.clan_id = c.id) AS families
             FROM clans c"""


def list_clans(conn: sqlite3.Connection) -> list[ClanSummary]:
    return [ClanSummary(**dict(row)) for row in conn.execute(_SUMMARY + " ORDER BY c.id")]


def _life_dates(conn: sqlite3.Connection, clan_id: int, tag: str) -> dict[int, LifeDate]:
    # берётся первое событие своего тега у человека
    rows = conn.execute(
        """SELECT e.person_id, e.date_raw, e.date_kind, e.date_year, e.date_month, e.date_day,
                  e.date_end_year, e.date_end_month, e.date_end_day, e.date_phrase
             FROM events e JOIN persons p ON p.id = e.person_id
            WHERE p.clan_id = ? AND e.tag = ?
            ORDER BY e.person_id, e.position""",
        (clan_id, tag),
    )
    dates: dict[int, LifeDate] = {}
    for row in rows:
        if row["person_id"] in dates:
            continue
        dates[row["person_id"]] = LifeDate(
            raw=row["date_raw"], kind=row["date_kind"],
            year=row["date_year"], month=row["date_month"], day=row["date_day"],
            end_year=row["date_end_year"], end_month=row["date_end_month"], end_day=row["date_end_day"],
            phrase=row["date_phrase"],
        )
    return dates


def clan_tree(conn: sqlite3.Connection, clan_id: int) -> ClanTree:
    summary = conn.execute(_SUMMARY + " WHERE c.id = ?", (clan_id,)).fetchone()
    if summary is None:
        raise ClanNotFoundError(clan_id)

    births = _life_dates(conn, clan_id, "BIRT")
    deaths = _life_dates(conn, clan_id, "DEAT")

    parents: dict[int, list[int]] = {}
    for row in conn.execute(
        """SELECT fc.person_id, fc.family_id FROM family_children fc
             JOIN families f ON f.id = fc.family_id WHERE f.clan_id = ? ORDER BY fc.family_id""",
        (clan_id,),
    ):
        parents.setdefault(row["person_id"], []).append(row["family_id"])

    spouses: dict[int, list[int]] = {}
    for row in conn.execute(
        """SELECT sf.person_id, sf.family_id FROM spouse_families sf
             JOIN persons p ON p.id = sf.person_id WHERE p.clan_id = ? ORDER BY sf.person_id, sf.position""",
        (clan_id,),
    ):
        spouses.setdefault(row["person_id"], []).append(row["family_id"])

    children: dict[int, list[int]] = {}
    for row in conn.execute(
        """SELECT fc.family_id, fc.person_id FROM family_children fc
             JOIN families f ON f.id = fc.family_id WHERE f.clan_id = ? ORDER BY fc.family_id, fc.position""",
        (clan_id,),
    ):
        children.setdefault(row["family_id"], []).append(row["person_id"])

    persons = [
        TreePerson(
            id=row["id"], xref=row["xref"], given=row["given"], surname=row["surname"],
            married_surname=row["married_surname"], sex=row["sex"], is_branch_stub=bool(row["is_branch_stub"]),
            birth=births.get(row["id"]), death=deaths.get(row["id"]),
            parent_families=parents.get(row["id"], []), spouse_families=spouses.get(row["id"], []),
        )
        for row in conn.execute(
            """SELECT id, xref, given, surname, married_surname, sex, is_branch_stub
                 FROM persons WHERE clan_id = ? ORDER BY id""",
            (clan_id,),
        )
    ]
    families = [
        TreeFamily(
            id=row["id"], xref=row["xref"], husband=row["husband_id"], wife=row["wife_id"],
            children=children.get(row["id"], []),
        )
        for row in conn.execute(
            "SELECT id, xref, husband_id, wife_id FROM families WHERE clan_id = ? ORDER BY id", (clan_id,)
        )
    ]
    return ClanTree(clan=ClanSummary(**dict(summary)), persons=persons, families=families)
