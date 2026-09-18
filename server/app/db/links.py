"""Межродовые связки: один человек, записанный в двух родах.

Слияния людей не существует: у каждого остаются свои данные, связка добавляет только переход и пометку
«также в …». Автоматика ничего не связывает сама — она складывает в очередь пары, у которых сошлись личное
имя и год рождения, а решает человек. «Разные люди» запоминаются, и пара больше не всплывает.
"""

from __future__ import annotations

import sqlite3
from datetime import UTC, datetime

from pydantic import BaseModel


class LinkPerson(BaseModel):
    id: int
    clan_id: int
    clan_name: str
    name: str
    born: int | None
    died: int | None


class Link(BaseModel):
    id: int
    note: str | None
    created_at: str
    a: LinkPerson
    b: LinkPerson


class ClanLink(BaseModel):
    """Для карты рода: у своего человека есть двойник в другом роду."""

    link_id: int
    person_id: int
    other: LinkPerson


class Kin(BaseModel):
    """Окружение кандидата: по нему тёзки из разных семей расходятся сразу."""

    person: LinkPerson
    parents: list[str]
    spouses: list[str]
    children: list[str]


class Candidate(BaseModel):
    a: Kin
    b: Kin


class LinkError(ValueError):
    pass


class LinkClashError(LinkError):
    """У человека в том роду уже есть двойник: связку можно только переставить."""


class LinkNotFoundError(LookupError):
    pass


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def _pair(a: int, b: int) -> tuple[int, int]:
    return (a, b) if a < b else (b, a)


_YEAR = """(SELECT e.date_year FROM events e WHERE e.person_id = p.id AND e.tag = ?
             ORDER BY e.position LIMIT 1)"""

_PERSON = f"""SELECT p.id, p.clan_id, c.name AS clan_name, p.given, p.surname, p.is_branch_stub,
                     {_YEAR.replace('?', "'BIRT'")} AS born, {_YEAR.replace('?', "'DEAT'")} AS died
                FROM persons p JOIN clans c ON c.id = p.clan_id"""


def _full_name(given: str | None, surname: str | None) -> str:
    return " ".join(part for part in (given, surname) if part) or "имя неизвестно"


def _brief(row: sqlite3.Row) -> LinkPerson:
    return LinkPerson(id=row["id"], clan_id=row["clan_id"], clan_name=row["clan_name"],
                      name=_full_name(row["given"], row["surname"]), born=row["born"], died=row["died"])


def _person(conn: sqlite3.Connection, person_id: int) -> sqlite3.Row:
    row = conn.execute(_PERSON + " WHERE p.id = ?", (person_id,)).fetchone()
    if row is None:
        raise LinkError("Такого человека нет")
    return row


def _link(conn: sqlite3.Connection, row: sqlite3.Row) -> Link:
    return Link(id=row["id"], note=row["note"], created_at=row["created_at"],
                a=_brief(_person(conn, row["a_person_id"])), b=_brief(_person(conn, row["b_person_id"])))


def list_links(conn: sqlite3.Connection) -> list[Link]:
    return [_link(conn, row) for row in conn.execute("SELECT * FROM person_links ORDER BY id")]


def clan_links(conn: sqlite3.Connection, clan_id: int) -> list[ClanLink]:
    """Связки людей рода, по одной строке на каждого двойника: у человека их может быть несколько."""
    out: list[ClanLink] = []
    for row in conn.execute(
        """SELECT l.id, l.a_person_id, l.b_person_id FROM person_links l
             JOIN persons pa ON pa.id = l.a_person_id JOIN persons pb ON pb.id = l.b_person_id
            WHERE pa.clan_id = ? OR pb.clan_id = ? ORDER BY l.id""",
        (clan_id, clan_id),
    ):
        a, b = _person(conn, row["a_person_id"]), _person(conn, row["b_person_id"])
        for own, other in ((a, b), (b, a)):
            if own["clan_id"] == clan_id:
                out.append(ClanLink(link_id=row["id"], person_id=own["id"], other=_brief(other)))
    return out


def create_link(conn: sqlite3.Connection, a_id: int, b_id: int, note: str | None = None,
                replace: bool = False) -> Link:
    """Связать двоих. Если у одного из них в роду другого уже есть двойник, это перестановка связки:
    без replace — отказ, с replace — старая связка снимается и ставится новая."""
    if a_id == b_id:
        raise LinkError("Человека нельзя связать с самим собой")
    a, b = _person(conn, a_id), _person(conn, b_id)
    if a["clan_id"] == b["clan_id"]:
        raise LinkError("Связка ставится только между разными родами")
    if a["is_branch_stub"] or b["is_branch_stub"]:
        raise LinkError("Заглушку «Ветвь» связать нельзя — это не человек, а указатель на другой род")
    low, high = _pair(a_id, b_id)
    if conn.execute("SELECT 1 FROM person_links WHERE a_person_id = ? AND b_person_id = ?", (low, high)).fetchone():
        raise LinkError("Эти двое уже связаны")

    # у человека в одном чужом роду может быть только один двойник
    clashes = [row["id"] for row in conn.execute(
        """SELECT l.id FROM person_links l
             JOIN persons pa ON pa.id = l.a_person_id JOIN persons pb ON pb.id = l.b_person_id
            WHERE (l.a_person_id = ? AND pb.clan_id = ?) OR (l.b_person_id = ? AND pa.clan_id = ?)
               OR (l.a_person_id = ? AND pb.clan_id = ?) OR (l.b_person_id = ? AND pa.clan_id = ?)""",
        (a_id, b["clan_id"], a_id, b["clan_id"], b_id, a["clan_id"], b_id, a["clan_id"]),
    )]
    if clashes and not replace:
        raise LinkClashError("У этого человека в том роду уже есть двойник — связку можно переставить")
    with conn:
        for link_id in clashes:
            conn.execute("DELETE FROM person_links WHERE id = ?", (link_id,))
        cursor = conn.execute(
            "INSERT INTO person_links (a_person_id, b_person_id, note, created_at) VALUES (?, ?, ?, ?)",
            (low, high, note or None, _now()),
        )
        # связанная пара больше не «разные люди»
        conn.execute("DELETE FROM link_rejects WHERE a_person_id = ? AND b_person_id = ?", (low, high))
    row = conn.execute("SELECT * FROM person_links WHERE id = ?", (cursor.lastrowid,)).fetchone()
    return _link(conn, row)


def delete_link(conn: sqlite3.Connection, link_id: int) -> None:
    with conn:
        if conn.execute("DELETE FROM person_links WHERE id = ?", (link_id,)).rowcount == 0:
            raise LinkNotFoundError(link_id)


def reject_pair(conn: sqlite3.Connection, a_id: int, b_id: int) -> None:
    """«Разные люди»: пара запоминается и больше не предлагается."""
    _person(conn, a_id)
    _person(conn, b_id)
    low, high = _pair(a_id, b_id)
    with conn:
        conn.execute("INSERT OR IGNORE INTO link_rejects (a_person_id, b_person_id, decided_at) VALUES (?, ?, ?)",
                     (low, high, _now()))


def _kin(conn: sqlite3.Connection, person: sqlite3.Row) -> Kin:
    def names(sql: str, *args: int) -> list[str]:
        return [_full_name(r["given"], r["surname"]) for r in conn.execute(sql, args)]

    parents = names(
        """SELECT p.given, p.surname FROM family_children fc JOIN families f ON f.id = fc.family_id
             JOIN persons p ON p.id IN (f.husband_id, f.wife_id)
            WHERE fc.person_id = ? ORDER BY p.id = f.wife_id""",
        person["id"],
    )
    spouses = names(
        """SELECT p.given, p.surname FROM spouse_families sf JOIN families f ON f.id = sf.family_id
             JOIN persons p ON p.id IN (f.husband_id, f.wife_id) AND p.id <> ?
            WHERE sf.person_id = ? ORDER BY sf.position""",
        person["id"], person["id"],
    )
    children = names(
        """SELECT p.given, p.surname FROM spouse_families sf JOIN family_children fc ON fc.family_id = sf.family_id
             JOIN persons p ON p.id = fc.person_id
            WHERE sf.person_id = ? ORDER BY sf.position, fc.position""",
        person["id"],
    )
    return Kin(person=_brief(person), parents=parents, spouses=spouses, children=children)


def candidates(conn: sqlite3.Connection) -> list[Candidate]:
    """Вероятные двойники: совпали личное имя и год рождения, роды разные. Фамилия не участвует —
    у двойников она разная по построению. Уже связанные и отвергнутые пары не предлагаются."""
    rows = conn.execute(
        f"""WITH p AS ({_PERSON} WHERE p.is_branch_stub = 0 AND p.given IS NOT NULL)
            SELECT a.id AS a_id, b.id AS b_id FROM p a JOIN p b
              ON a.given = b.given AND a.born = b.born AND a.clan_id < b.clan_id
             WHERE NOT EXISTS (SELECT 1 FROM person_links l
                                WHERE l.a_person_id = MIN(a.id, b.id) AND l.b_person_id = MAX(a.id, b.id))
               AND NOT EXISTS (SELECT 1 FROM link_rejects r
                                WHERE r.a_person_id = MIN(a.id, b.id) AND r.b_person_id = MAX(a.id, b.id))
             ORDER BY a.born, a.given, a.id, b.id"""
    ).fetchall()
    return [Candidate(a=_kin(conn, _person(conn, r["a_id"])), b=_kin(conn, _person(conn, r["b_id"]))) for r in rows]


def search_persons(conn: sqlite3.Connection, query: str, exclude_clan: int | None = None,
                   limit: int = 20) -> list[LinkPerson]:
    """Поиск по всем родам для ручной связки: по имени и фамилии, без заглушек."""
    words = [w.casefold() for w in query.split() if w]
    if not words:
        return []
    found: list[LinkPerson] = []
    for row in conn.execute(_PERSON + " WHERE p.is_branch_stub = 0 ORDER BY c.id, p.id"):
        if exclude_clan is not None and row["clan_id"] == exclude_clan:
            continue
        # SQLite не приводит кириллицу к нижнему регистру — сравнение в Python
        text = _full_name(row["given"], row["surname"]).casefold()
        if all(word in text for word in words):
            found.append(_brief(row))
            if len(found) >= limit:
                break
    return found
