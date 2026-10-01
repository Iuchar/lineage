"""Новый род с нуля: имя рода и первый человек."""

from collections.abc import Iterator
from pathlib import Path
import sqlite3

import pytest
from fastapi.testclient import TestClient

from app.db.connection import connect
from app.db.newclan import ClanStart, FirstPerson, NewClanError, start_clan
from app.db.tree import clan_tree, list_clans
from app.gedcom.export import export_clan
from app.main import app, database


@pytest.fixture
def conn(tmp_path: Path) -> Iterator[sqlite3.Connection]:
    c = connect(tmp_path / "n.sqlite3")
    yield c
    c.close()


def test_clan_starts_with_one_person(conn: sqlite3.Connection, tmp_path: Path) -> None:
    clan_id = start_clan(conn, ClanStart(name="Маклауд", status="old",
                                         person=FirstPerson(given="Торквил", surname="Маклауд", sex="M", birth="около 1310")))
    tree = clan_tree(conn, clan_id)
    assert [(p.given, p.surname, p.sex) for p in tree.persons] == [("Торквил", "Маклауд", "M")]
    assert tree.persons[0].birth and tree.persons[0].birth.year == 1310
    assert list_clans(conn)[0].status == "old"
    text = export_clan(conn, clan_id)
    assert "1 _STATUS old" in text and "2 DATE ABT 1310" in text
    # род сразу лёг своим файлом рядом с базой
    assert (tmp_path / "houses" / "Maklaud.ged").exists()


def test_typed_line_breaks_do_not_become_records(conn: sqlite3.Connection) -> None:
    clan_id = start_clan(conn, ClanStart(name="Род\n0 @I9@ INDI", person=FirstPerson(given="Анна\n1 SEX M", surname="a/b")))
    tree = clan_tree(conn, clan_id)
    assert len(tree.persons) == 1
    assert tree.persons[0].given == "Анна 1 SEX M" and tree.persons[0].surname == "a b"


@pytest.mark.parametrize(("start", "reason"), [
    (ClanStart(name="  ", person=FirstPerson(given="Анна")), "имя"),
    (ClanStart(name="Род", person=FirstPerson()), "имя или фамилия"),
    (ClanStart(name="Род", status="king", person=FirstPerson(given="Анна")), "титула"),
    (ClanStart(name="Род", person=FirstPerson(given="Анна", birth="вчера")), "Год рождения"),
])
def test_refusals_are_explained(conn: sqlite3.Connection, start: ClanStart, reason: str) -> None:
    with pytest.raises(NewClanError, match=reason):
        start_clan(conn, start)
    assert list_clans(conn) == []


def test_endpoint(tmp_path: Path) -> None:
    path = tmp_path / "api.sqlite3"

    def test_database() -> Iterator[sqlite3.Connection]:
        c = connect(path)
        try:
            yield c
        finally:
            c.close()

    app.dependency_overrides[database] = test_database
    try:
        client = TestClient(app)
        made = client.post("/api/clans", json={"name": "Маклауд", "person": {"given": "Торквил", "sex": "M"}})
        assert made.status_code == 200 and made.json()["persons"] == 1
        again = client.post("/api/clans", json={"name": "Маклауд", "person": {"given": "Торквил"}})
        assert again.status_code == 409
        empty = client.post("/api/clans", json={"name": "Другой", "person": {}})
        assert empty.status_code == 400
    finally:
        app.dependency_overrides.clear()
