import sqlite3
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.db.clans import import_clan
from app.db.connection import connect
from app.gedcom.load import load_file
from app.main import app, database
from conftest import CLANS, source


@pytest.fixture
def client(tmp_path: Path) -> Iterator[TestClient]:
    path = tmp_path / "api.sqlite3"
    conn = connect(path)
    for clan in ("Гленн Уриск", "Монад Кройве"):
        import_clan(conn, clan, load_file(source(clan)))
    conn.close()

    def test_database() -> Iterator[sqlite3.Connection]:
        c = connect(path)
        try:
            yield c
        finally:
            c.close()

    app.dependency_overrides[database] = test_database
    yield TestClient(app)
    app.dependency_overrides.clear()


def test_clans_are_listed_with_counts(client: TestClient) -> None:
    clans = client.get("/api/clans").json()
    assert [(c["name"], c["persons"], c["families"]) for c in clans] == [
        ("Гленн Уриск", 38, 14),
        ("Монад Кройве", 84, 36),
    ]


def test_tree_holds_the_whole_clan(client: TestClient) -> None:
    monadh = next(c for c in client.get("/api/clans").json() if c["name"] == "Монад Кройве")
    tree = client.get(f"/api/clans/{monadh['id']}/tree").json()
    _, persons, families, stubs = CLANS["Монад Кройве"]
    assert len(tree["persons"]) == persons and len(tree["families"]) == families
    assert sum(p["is_branch_stub"] for p in tree["persons"]) == stubs

    by_id = {p["id"]: p for p in tree["persons"]}
    fams = {f["id"]: f for f in tree["families"]}
    malcolm = next(p for p in tree["persons"] if p["xref"] == "@I538@")
    assert [by_id[fams[f]["wife"]]["given"] for f in malcolm["spouse_families"]] == ["Иона", "Финнула", "Элспет"]

    hamish = next(p for p in tree["persons"] if p["xref"] == "@I51@")
    assert (hamish["birth"]["year"], hamish["death"]["year"], hamish["birth"]["kind"]) == (1798, 1920, "exact")


def test_links_never_point_outside_the_clan(client: TestClient) -> None:
    for clan in client.get("/api/clans").json():
        tree = client.get(f"/api/clans/{clan['id']}/tree").json()
        persons = {p["id"] for p in tree["persons"]}
        families = {f["id"] for f in tree["families"]}
        for p in tree["persons"]:
            assert set(p["parent_families"]) | set(p["spouse_families"]) <= families
        for f in tree["families"]:
            assert {x for x in (f["husband"], f["wife"]) if x} | set(f["children"]) <= persons


def test_unknown_clan_is_404(client: TestClient) -> None:
    assert client.get("/api/clans/9999/tree").status_code == 404


def test_person_details_carry_notes_and_marriages(client: TestClient) -> None:
    monadh = next(c for c in client.get("/api/clans").json() if c["name"] == "Монад Кройве")
    tree = client.get(f"/api/clans/{monadh['id']}/tree").json()
    hamish = next(p for p in tree["persons"] if p["xref"] == "@I51@")
    details = client.get(f"/api/persons/{hamish['id']}").json()
    assert details["clan_id"] == monadh["id"]
    assert [e["tag"] for e in details["events"]] == ["BIRT", "DEAT", "EVEN"]
    assert details["events"][2]["value"] == "Основатель рода"
    assert [m["family_id"] for m in details["marriages"]] == hamish["spouse_families"]

    malcolm = next(p for p in tree["persons"] if p["xref"] == "@I538@")
    assert len(client.get(f"/api/persons/{malcolm['id']}").json()["marriages"]) == 3


def test_unknown_person_is_404(client: TestClient) -> None:
    assert client.get("/api/persons/999999").status_code == 404
