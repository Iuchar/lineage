"""Чтение рода для холста: люди, семьи и всё, что нужно раскладке и карточкам."""

from __future__ import annotations

import json
import sqlite3
from typing import Literal

from pydantic import BaseModel

from app.db.kin import manual_order
from app.gedcom.meta import See, read_meta, read_status, read_tag_defs
from app.gedcom.records import Record


class ClanSummary(BaseModel):
    id: int
    name: str
    persons: int
    families: int
    status: str = "plain"  # титул рода: titled, old, plain (app/gedcom/meta.py)


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
    # место по старшинству среди людей рода — зрителю вместо года: раскладке нужен порядок, а не сама дата
    birth_rank: int | None = None
    parent_families: list[int]
    spouse_families: list[int]  # в порядке браков
    # служебные теги приложения из записи человека (app/gedcom/meta.py)
    tags: list[str] = []
    burnt: bool = False
    see: See = "all"  # человек целиком: общее, родовое, скрытое
    see_dates: See = "clan"
    see_portrait: See = "all"
    heir: bool = False
    portrait: Literal["auto", "silhouette", "none"] = "auto"
    photo: str | None = None  # адрес снимка, если он есть


class TreeFamily(BaseModel):
    id: int
    xref: str
    husband: int | None
    wife: int | None
    children: list[int]  # в порядке файла
    child_pedigree: list[str] = []  # тип родства каждого ребёнка: birth, adopted, foster
    divorced: bool = False


class TagDef(BaseModel):
    name: str
    color: str


class ClanTree(BaseModel):
    clan: ClanSummary
    persons: list[TreePerson]
    families: list[TreeFamily]
    tags: list[TagDef] = []  # набор меток рода с цветами


class ClanNotFoundError(LookupError):
    pass


_SUMMARY = """SELECT c.id, c.name, c.header_raw,
                  (SELECT COUNT(*) FROM persons p WHERE p.clan_id = c.id) AS persons,
                  (SELECT COUNT(*) FROM families f WHERE f.clan_id = c.id) AS families
             FROM clans c"""


def _summary(row: sqlite3.Row) -> ClanSummary:
    data = dict(row)
    header = data.pop("header_raw", None)
    return ClanSummary(**data, status=read_status(Record.from_json(json.loads(header)) if header else None))


def list_clans(conn: sqlite3.Connection) -> list[ClanSummary]:
    return [_summary(row) for row in conn.execute(_SUMMARY + " ORDER BY c.id")]


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


def _marriage_order(conn: sqlite3.Connection, clan_id: int, spouses: dict[int, list[int]],
                    births: dict[int, LifeDate], deaths: dict[int, LifeDate], children: dict[int, list[int]],
                    manual: set[int]) -> None:
    """Очередь браков. Браки сравниваются попарно одинаковыми признаками, от надёжного к слабому:
    у обоих дата венчания — по ней; у обоих дети — по году первого ребёнка; один бездетный, и его супруг умер раньше
    первого ребёнка в другом браке — бездетный раньше (развод этот признак не ловит); иначе — по году рождения супругов.
    Если хоть одну пару сравнить нечем — порядок файла. В базе остаётся порядок файла, чтобы выгрузка вернула его целым.
    У кого очередь задана вручную (_MORDER), правило не применяется."""
    marr: dict[int, int] = {}
    for row in conn.execute(
        """SELECT e.family_id, e.date_year FROM events e JOIN families f ON f.id = e.family_id
            WHERE f.clan_id = ? AND e.tag = 'MARR' AND e.date_year IS NOT NULL ORDER BY e.family_id, e.position""",
        (clan_id,),
    ):
        marr.setdefault(row["family_id"], row["date_year"])
    couples = {row["id"]: (row["husband_id"], row["wife_id"])
               for row in conn.execute("SELECT id, husband_id, wife_id FROM families WHERE clan_id = ?", (clan_id,))}

    def year(dates: dict[int, LifeDate], pid: int | None) -> int | None:
        return dates[pid].year if pid is not None and pid in dates else None

    for person, families in spouses.items():
        if len(families) < 2 or person in manual:
            continue
        spouse = {f: (couples[f][1] if couples[f][0] == person else couples[f][0]) for f in families}
        first_child = {f: min((y for k in children.get(f, []) if (y := year(births, k)) is not None), default=None)
                       for f in families}

        def compare(a: int, b: int) -> int | None:
            if a in marr and b in marr:
                return marr[a] - marr[b]
            ca, cb = first_child[a], first_child[b]
            if ca is not None and cb is not None:
                return ca - cb
            for childless, other, sign in ((a, b, -1), (b, a, 1)):
                died = year(deaths, spouse[childless])
                if first_child[childless] is None and first_child[other] is not None and died is not None                         and died < first_child[other]:
                    return sign
            sa, sb = year(births, spouse[a]), year(births, spouse[b])
            return None if sa is None or sb is None else sa - sb

        pairs = [compare(a, b) for i, a in enumerate(families) for b in families[i + 1:]]
        if any(c is None for c in pairs):
            continue
        # вставками: устойчиво и не требует от попарного сравнения строгой транзитивности
        ordered: list[int] = []
        for family in families:
            at = len(ordered)
            while at > 0 and (compare(ordered[at - 1], family) or 0) > 0:
                at -= 1
            ordered.insert(at, family)
        families[:] = ordered


def clan_tree(conn: sqlite3.Connection, clan_id: int, file_order: bool = False) -> ClanTree:
    """file_order — очередь браков как в файле, без правила; так строились раскладки стенда, с которыми сверяются тесты."""
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
    pedigrees: dict[int, list[str]] = {}
    for row in conn.execute(
        """SELECT fc.family_id, fc.person_id, fc.pedigree FROM family_children fc
             JOIN families f ON f.id = fc.family_id WHERE f.clan_id = ? ORDER BY fc.family_id, fc.position""",
        (clan_id,),
    ):
        children.setdefault(row["family_id"], []).append(row["person_id"])
        kind = (row["pedigree"] or "birth").lower()
        pedigrees.setdefault(row["family_id"], []).append(kind if kind in ("adopted", "foster") else "birth")
    divorced = {row[0] for row in conn.execute(
        "SELECT DISTINCT e.family_id FROM events e JOIN families f ON f.id = e.family_id WHERE f.clan_id = ? AND e.tag = 'DIV'",
        (clan_id,))}
    raws = {row["id"]: Record.from_json(json.loads(row["raw"]))
            for row in conn.execute("SELECT id, raw FROM persons WHERE clan_id = ?", (clan_id,))}
    if not file_order:
        manual = {pid for pid, record in raws.items() if manual_order(record)}
        _marriage_order(conn, clan_id, spouses, births, deaths, children, manual)

    def person(row: sqlite3.Row) -> TreePerson:
        meta = read_meta(raws[row["id"]])
        return TreePerson(
            id=row["id"], xref=row["xref"], given=row["given"], surname=row["surname"],
            married_surname=row["married_surname"], sex=row["sex"], is_branch_stub=bool(row["is_branch_stub"]),
            birth=births.get(row["id"]), death=deaths.get(row["id"]),
            parent_families=parents.get(row["id"], []), spouse_families=spouses.get(row["id"], []),
            tags=meta.tags, burnt=meta.burnt, see=meta.see, see_dates=meta.see_dates,
            see_portrait=meta.see_portrait, heir=meta.heir, portrait=meta.portrait,
            photo=f"/api/{meta.photo}" if meta.photo else None,
        )

    persons = [
        person(row)
        for row in conn.execute(
            """SELECT id, xref, given, surname, married_surname, sex, is_branch_stub, raw
                 FROM persons WHERE clan_id = ? ORDER BY id""",
            (clan_id,),
        )
    ]
    families = [
        TreeFamily(
            id=row["id"], xref=row["xref"], husband=row["husband_id"], wife=row["wife_id"],
            children=children.get(row["id"], []), child_pedigree=pedigrees.get(row["id"], []),
            divorced=row["id"] in divorced,
        )
        for row in conn.execute(
            "SELECT id, xref, husband_id, wife_id FROM families WHERE clan_id = ? ORDER BY id", (clan_id,)
        )
    ]
    header = conn.execute("SELECT header_raw FROM clans WHERE id = ?", (clan_id,)).fetchone()[0]
    tags = read_tag_defs(Record.from_json(json.loads(header)) if header else None)
    return ClanTree(clan=_summary(summary), persons=persons, families=families,
                    tags=[TagDef(name=t.name, color=t.color) for t in tags])
