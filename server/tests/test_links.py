import sqlite3
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.db.clans import import_clan
from app.db.connection import connect
from app.db.links import (LinkClashError, LinkError, candidates, clan_links, create_link, delete_link, reject_pair,
                          search_persons)
from app.gedcom.load import load_file
from app.main import app, database
from conftest import CLANS, source


@pytest.fixture
def conn(tmp_path: Path) -> Iterator[sqlite3.Connection]:
    c = connect(tmp_path / "links.sqlite3")
    for clan in CLANS:
        import_clan(c, clan, load_file(source(clan)))
    yield c
    c.close()


def person(conn: sqlite3.Connection, clan: str, given: str, born: int) -> int:
    row = conn.execute(
        """SELECT p.id FROM persons p JOIN clans c ON c.id = p.clan_id
             JOIN events e ON e.person_id = p.id AND e.tag = 'BIRT'
            WHERE c.name = ? AND p.given = ? AND e.date_year = ?""",
        (clan, given, born),
    ).fetchone()
    return row["id"]


def pairs(conn: sqlite3.Connection) -> list[tuple[str, int, str, str]]:
    return [(c.a.person.name.split()[0], c.a.person.born or 0, c.a.person.clan_name, c.b.person.clan_name)
            for c in candidates(conn)]


def test_candidates_are_the_seven_seams_between_clans(conn: sqlite3.Connection) -> None:
    # имя + год рождения; в четырёх родах это ровно семь швов из проектного документа
    assert sorted(pairs(conn)) == sorted([
        ("Ниалл", 1683, "Гленн Уриск", "Уинтерхоуп"),
        ("Мор", 1691, "Гленн Уриск", "Уинтерхоуп"),
        ("Эоган", 1719, "Гленн Уриск", "Уинтерхоуп"),
        ("Сорха", 1962, "Гленн Уриск", "Уинтерхоуп"),
        ("Эдвин", 1958, "Гленн Уриск", "Уинтерхоуп"),
        ("Ниав", 1908, "Уинтерхоуп", "О'Дувейн"),
        ("Кормак", 1934, "Уинтерхоуп", "О'Дувейн"),
    ])


def test_candidate_carries_surroundings(conn: sqlite3.Connection) -> None:
    eogan = next(c for c in candidates(conn) if c.a.person.name.startswith("Эоган"))
    names = lambda people: [k.name for k in people]  # noqa: E731
    assert names(eogan.a.parents) == names(eogan.b.parents) == ["Ниалл Гленн Уриск", "Мор Кинкейд"]
    assert names(eogan.b.spouses) == ["Хэрриет Ноублс"]
    assert "Уилфред Уинтерхоуп" in names(eogan.b.children)
    assert all(k.linked is None for k in eogan.a.parents)


def test_linked_relative_is_marked_in_the_queue(conn: sqlite3.Connection) -> None:
    # мать Кормака Ниав связана — в очереди у Кормака она «связан · О'Дувейн»
    niav = person(conn, "Уинтерхоуп", "Ниав", 1908), person(conn, "О'Дувейн", "Ниав", 1908)
    create_link(conn, *niav)
    kormak = next(c for c in candidates(conn) if c.a.person.name.startswith("Кормак"))
    mother = next(k for k in kormak.a.parents if k.name.startswith("Ниав"))
    assert mother.id == niav[0] and mother.linked is not None and mother.linked.clan_name == "О'Дувейн"


def test_linked_and_rejected_pairs_leave_the_queue(conn: sqlite3.Connection) -> None:
    sorha = person(conn, "Гленн Уриск", "Сорха", 1962), person(conn, "Уинтерхоуп", "Сорха", 1962)
    edwin = person(conn, "Гленн Уриск", "Эдвин", 1958), person(conn, "Уинтерхоуп", "Эдвин", 1958)
    create_link(conn, *sorha)
    reject_pair(conn, *edwin)
    left = {name for name, *_ in pairs(conn)}
    assert "Сорха" not in left and "Эдвин" not in left
    assert len(left) == 5


def test_clan_links_show_the_twin_from_each_side(conn: sqlite3.Connection) -> None:
    a, b = person(conn, "Гленн Уриск", "Сорха", 1962), person(conn, "Уинтерхоуп", "Сорха", 1962)
    link = create_link(conn, b, a, note="одна и та же Сорха")
    assert (link.a.id, link.b.id) == (min(a, b), max(a, b))  # пара хранится упорядоченной
    glenn = conn.execute("SELECT clan_id FROM persons WHERE id = ?", (a,)).fetchone()[0]
    [mine] = clan_links(conn, glenn)
    assert (mine.person_id, mine.other.id, mine.other.clan_name) == (a, b, "Уинтерхоуп")


def test_second_twin_in_the_same_clan_needs_replace(conn: sqlite3.Connection) -> None:
    sorha = person(conn, "Гленн Уриск", "Сорха", 1962)
    right = person(conn, "Уинтерхоуп", "Сорха", 1962)
    wrong = person(conn, "Уинтерхоуп", "Эдвин", 1958)
    first = create_link(conn, sorha, wrong)  # ошиблись двойником
    with pytest.raises(LinkClashError):
        create_link(conn, sorha, right)
    fixed = create_link(conn, sorha, right, replace=True)
    ids = [row[0] for row in conn.execute("SELECT id FROM person_links")]
    assert ids == [fixed.id] and first.id not in ids


def test_rules_of_a_link(conn: sqlite3.Connection) -> None:
    a = person(conn, "Гленн Уриск", "Сорха", 1962)
    same_clan = person(conn, "Гленн Уриск", "Эдвин", 1958)
    stub = conn.execute("SELECT id FROM persons WHERE is_branch_stub = 1 AND clan_id <> "
                        "(SELECT clan_id FROM persons WHERE id = ?)", (a,)).fetchone()[0]
    for other in (a, same_clan, stub):
        with pytest.raises(LinkError):
            create_link(conn, a, other)


def test_unlinking_keeps_both_people(conn: sqlite3.Connection) -> None:
    a, b = person(conn, "Уинтерхоуп", "Кормак", 1934), person(conn, "О'Дувейн", "Кормак", 1934)
    before = conn.execute("SELECT COUNT(*) FROM persons").fetchone()[0]
    link = create_link(conn, a, b)
    delete_link(conn, link.id)
    assert conn.execute("SELECT COUNT(*) FROM person_links").fetchone()[0] == 0
    assert conn.execute("SELECT COUNT(*) FROM persons").fetchone()[0] == before
    # снятая связка снова в очереди: её не отвергали, просто сняли
    assert "Кормак" in {name for name, *_ in pairs(conn)}


def test_search_across_clans(conn: sqlite3.Connection) -> None:
    found = search_persons(conn, "сорха")
    assert {p.clan_name for p in found} == {"Гленн Уриск", "Уинтерхоуп"}
    glenn = found[0].clan_id
    assert all(p.clan_id != glenn for p in search_persons(conn, "Сорха", exclude_clan=glenn))
    assert search_persons(conn, "   ") == []


def test_links_api(tmp_path: Path) -> None:
    path = tmp_path / "api.sqlite3"
    c = connect(path)
    for clan in ("Гленн Уриск", "Уинтерхоуп"):
        import_clan(c, clan, load_file(source(clan)))
    a, b = person(c, "Гленн Уриск", "Сорха", 1962), person(c, "Уинтерхоуп", "Сорха", 1962)
    wrong = person(c, "Уинтерхоуп", "Эдвин", 1958)
    c.close()

    def test_database() -> Iterator[sqlite3.Connection]:
        conn = connect(path)
        try:
            yield conn
        finally:
            conn.close()

    app.dependency_overrides[database] = test_database
    try:
        client = TestClient(app)
        assert len(client.get("/api/links/candidates").json()) == 5
        link = client.post("/api/links", json={"a": a, "b": wrong}).json()
        assert client.post("/api/links", json={"a": a, "b": b}).status_code == 409
        replaced = client.post("/api/links", json={"a": a, "b": b, "replace": True}).json()
        assert replaced["id"] != link["id"]
        assert client.post("/api/links", json={"a": a, "b": a}).status_code == 400
        glenn = replaced["a"]["clan_id"] if replaced["a"]["id"] == a else replaced["b"]["clan_id"]
        assert [x["other"]["id"] for x in client.get(f"/api/clans/{glenn}/links").json()] == [b]
        assert client.delete(f"/api/links/{replaced['id']}").status_code == 204
        assert client.delete(f"/api/links/{replaced['id']}").status_code == 404
        assert client.post("/api/links/reject", json={"a": a, "b": b}).status_code == 204
        assert len(client.get("/api/links/candidates").json()) == 4
        assert [p["clan_name"] for p in client.get("/api/persons", params={"q": "Сорха"}).json()] == [
            "Гленн Уриск", "Уинтерхоуп"]
    finally:
        app.dependency_overrides.clear()
