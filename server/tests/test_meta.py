import json
import sqlite3
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import app.config
from app.db.clans import import_clan
from app.db.connection import connect
from app.db.editor import EditError, PersonFields, person_form, update_person
from app.db.journal import undo
from app.db.photos import remove_photo, save_photo
from app.db.tree import clan_tree
from app.gedcom.export import export_clan
from app.gedcom.load import load_file, load_text
from app.main import app as web, database
from conftest import source

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32


@pytest.fixture
def conn(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[sqlite3.Connection]:
    path = tmp_path / "meta.sqlite3"
    monkeypatch.setattr(app.config, "DB_PATH", path)  # снимки — рядом с этой базой, не с рабочей
    c = connect(path)
    import_clan(c, "Гленн Уриск", load_file(source("Гленн Уриск")))
    yield c
    c.close()


def murdo(conn: sqlite3.Connection) -> int:
    return conn.execute("SELECT id FROM persons WHERE xref = '@I1007@'").fetchone()[0]


def person(conn: sqlite3.Connection, pid: int):  # noqa: ANN201
    return next(p for p in clan_tree(conn, 1).persons if p.id == pid)


def test_tags_states_and_heir_are_stored_in_the_record(conn: sqlite3.Connection) -> None:
    pid = murdo(conn)
    change = update_person(conn, pid, PersonFields(
        given="Мурдо", surname="Гленн Уриск", sex="M", birth="1748", death="1851",
        tags=["Переселенец"], new_tags={"Переселенец": "синий"}, burnt=True, heir=True))
    assert "метка «Переселенец»" in change.summary and "выжжен из рода" in change.summary
    p = person(conn, pid)
    assert (p.tags, p.burnt, p.see, p.heir) == (["Переселенец"], True, "all", True)
    assert [(t.name, t.color) for t in clan_tree(conn, 1).tags] == [("Переселенец", "синий")]
    undo(conn, 1)
    p = person(conn, pid)
    assert (p.tags, p.burnt, p.heir) == ([], False, False)
    assert clan_tree(conn, 1).tags == []  # набор меток рода откатился той же правкой


def test_partial_form_keeps_what_it_does_not_send(conn: sqlite3.Connection) -> None:
    pid = murdo(conn)
    update_person(conn, pid, PersonFields(given="Мурдо", surname="Гленн Уриск", sex="M", birth="1748", death="1851",
                                          tags=["Проверить"], see="hidden"))
    update_person(conn, pid, PersonFields(given="Мурдо", surname="Гленн Уриск", sex="M", birth="около 1748", death="1851"))
    form = person_form(conn, pid)
    assert (form.tags, form.see, form.birth.gedcom) == (["Проверить"], "hidden", "ABT 1748")


def test_meta_goes_into_the_file_and_back(conn: sqlite3.Connection) -> None:
    pid = murdo(conn)
    update_person(conn, pid, PersonFields(given="Мурдо", surname="Гленн Уриск", sex="M", birth="1748", death="1851",
                                          tags=["Военный"], new_tags={"Военный": "винный"}, portrait="none"))
    text = export_clan(conn, 1)
    assert "1 _TAG Военный" in text and "1 _TAGDEF Военный\n2 _COLOR винный" in text and "1 _PORTRAIT none" in text
    assert not load_text(text).warnings


def test_photo_upload_remove_and_undo(conn: sqlite3.Connection) -> None:
    pid = murdo(conn)
    with pytest.raises(EditError, match="не снимок"):
        save_photo(conn, pid, b"hello")
    change = save_photo(conn, pid, PNG, "image/png")
    assert change.summary == "Мурдо: снимок"
    url = person(conn, pid).photo
    assert url and url.startswith("/api/photos/1/") and url.endswith(".png")
    assert (Path(app.config.DB_PATH).parent / url.removeprefix("/api/")).read_bytes() == PNG
    raw = json.loads(conn.execute("SELECT raw FROM persons WHERE id = ?", (pid,)).fetchone()[0])
    obje = next(c for c in raw["c"] if c["t"] == "OBJE")
    assert obje["c"][0]["t"] == "FILE" and obje["c"][0]["v"].startswith("photos/1/")
    remove_photo(conn, pid)
    assert person(conn, pid).photo is None
    undo(conn, 1)
    assert person(conn, pid).photo == url  # откат вернул ссылку, файл на месте


def test_photo_endpoints(conn: sqlite3.Connection) -> None:
    path = Path(app.config.DB_PATH)

    def test_database() -> Iterator[sqlite3.Connection]:
        c = connect(path)
        try:
            yield c
        finally:
            c.close()

    web.dependency_overrides[database] = test_database
    try:
        client = TestClient(web)
        pid = murdo(conn)
        assert client.post(f"/api/persons/{pid}/photo", content=b"nope").status_code == 400
        assert client.post(f"/api/persons/{pid}/photo", content=PNG, headers={"content-type": "image/png"}).status_code == 200
        url = next(p for p in client.get("/api/clans/1/tree").json()["persons"] if p["id"] == pid)["photo"]
        served = client.get(url)
        assert served.status_code == 200 and served.content == PNG
        assert client.get("/api/photos/1/../../secret.png").status_code == 404
        assert client.delete(f"/api/persons/{pid}/photo").status_code == 200
        assert client.delete(f"/api/persons/{pid}/photo").status_code == 400
    finally:
        web.dependency_overrides.clear()
