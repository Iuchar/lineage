import sqlite3
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.db.clans import import_clan
from app.db.connection import connect
from app.gedcom.load import load_file
from app.main import app, database
from conftest import source


@pytest.fixture
def client(tmp_path: Path) -> Iterator[TestClient]:
    path = tmp_path / "api.sqlite3"
    c = connect(path)
    import_clan(c, "Гленн Уриск", load_file(source("Гленн Уриск")))
    c.close()

    def test_database() -> Iterator[sqlite3.Connection]:
        conn = connect(path)
        try:
            yield conn
        finally:
            conn.close()

    app.dependency_overrides[database] = test_database
    yield TestClient(app)
    app.dependency_overrides.clear()


def murdo(client: TestClient) -> int:
    return next(p["id"] for p in client.get("/api/clans/1/tree").json()["persons"] if p["xref"] == "@I1007@")


def test_date_parse_endpoint(client: TestClient) -> None:
    assert client.get("/api/dates/parse", params={"text": "около 1750"}).json() == {
        "gedcom": "ABT 1750", "ru": "около 1750", "kind": "about"}
    bad = client.get("/api/dates/parse", params={"text": "32 мар 1748"})
    assert bad.status_code == 400 and bad.json()["detail"] == "в марте 31 день"


def test_edit_undo_redo_through_the_api(client: TestClient) -> None:
    pid = murdo(client)
    form = client.get(f"/api/persons/{pid}/form").json()
    assert (form["given"], form["birth"]["gedcom"], form["birth"]["ru"]) == ("Мурдо", "1748", "1748")
    body = {**{k: form[k] for k in ("given", "surname", "married_surname", "sex", "notes")},
            "birth": "около 1748", "death": form["death"]["gedcom"]}
    change = client.put(f"/api/persons/{pid}", json=body).json()
    assert change["summary"] == "Мурдо: рождение 1748 → около 1748"
    assert client.put(f"/api/persons/{pid}", json={**body, "birth": "32 мар 1748"}).status_code == 400
    assert [c["summary"] for c in client.get(f"/api/persons/{pid}/changes").json()] == [change["summary"]]
    assert client.post("/api/clans/1/undo").json()["undone"] is True
    assert client.get(f"/api/persons/{pid}/form").json()["birth"]["gedcom"] == "1748"
    assert client.post("/api/clans/1/redo").json()["undone"] is False
    assert client.post("/api/clans/1/redo").json() is None


def test_add_and_delete_through_the_api(client: TestClient) -> None:
    pid = murdo(client)
    created = client.post("/api/clans/1/persons", json={
        "fields": {"given": "Ангус", "surname": "Гленн Уриск", "sex": "M", "birth": "около 1785"},
        "relation": {"kind": "child", "person_id": pid, "other_id": None},
    }).json()
    assert created["change"]["summary"] == "Мурдо: сын — Ангус Гленн Уриск"
    preview = client.get(f"/api/persons/{pid}/delete-preview").json()
    assert preview["children"] == 3 and preview["branch_total"] == 30
    assert client.delete(f"/api/persons/{created['person_id']}").status_code == 200
    assert len(client.get("/api/clans/1/changes").json()) == 2
    wrong = client.post("/api/clans/1/persons", json={"relation": {"kind": "sibling", "person_id": 999999}})
    assert wrong.status_code == 400
