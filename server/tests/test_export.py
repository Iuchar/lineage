import re
import sqlite3
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.db.clans import import_clan
from app.db.connection import connect
from app.db.editor import NoteForm, NewPerson, PersonFields, Relation, add_person, update_person
from app.db.editor import person_form
from app.gedcom.export import export_clan
from app.gedcom.load import load_file, load_text
from app.main import app, database
from conftest import CLANS, source


def lines(text: str) -> list[str]:
    return [line for line in re.split(r"\r\n|\r|\n", text.removeprefix("﻿")) if line.strip()]


@pytest.mark.parametrize("clan", list(CLANS))
def test_fresh_clan_exports_back_to_the_same_file(tmp_path: Path, clan: str) -> None:
    conn = connect(tmp_path / "x.sqlite3")
    report = import_clan(conn, clan, load_file(source(clan)))
    original = source(clan).read_text(encoding="utf-8-sig")
    assert lines(export_clan(conn, report.clan_id)) == lines(original)


@pytest.fixture
def conn(tmp_path: Path) -> Iterator[sqlite3.Connection]:
    c = connect(tmp_path / "e.sqlite3")
    import_clan(c, "Гленн Уриск", load_file(source("Гленн Уриск")))
    yield c
    c.close()


def test_edits_go_into_the_file_and_read_back(conn: sqlite3.Connection) -> None:
    murdo = conn.execute("SELECT id FROM persons WHERE xref = '@I1007@'").fetchone()[0]
    form = person_form(conn, murdo)
    update_person(conn, murdo, PersonFields(given=form.given, surname=form.surname, sex=form.sex,
                                            birth="около 1748", death=form.death.gedcom, notes=[NoteForm(text="Арендатор")]))
    add_person(conn, 1, NewPerson(fields=PersonFields(given="Ангус", surname="Гленн Уриск", sex="M", birth="около 1785"),
                                  relation=Relation(kind="child", person_id=murdo, other_id=None)))
    text = export_clan(conn, 1)
    data = load_text(text)  # файл читается нашим же разбором — значит, валиден по форме
    assert not data.warnings
    person = data.persons["@I1007@"]
    assert person.event("BIRT").date.raw == "ABT 1748"  # type: ignore[union-attr]
    # в роду уже есть свой Ангус (1893) — новый узнаётся по дате
    angus = next(p for p in data.persons.values() if p.given == "Ангус" and p.event("BIRT") and p.event("BIRT").date.raw == "ABT 1785")  # type: ignore[union-attr]
    family = data.families[angus.parent_families[0].family]
    assert (family.husband, family.wife, family.children) == ("@I1007@", None, [angus.xref])
    assert "@I1007@" in [p.xref for p in data.persons.values() if family.xref in p.spouse_families]
    assert text.startswith("0 HEAD\n") and text.endswith("0 TRLR\n")


def test_export_endpoint(tmp_path: Path) -> None:
    path = tmp_path / "api.sqlite3"
    c = connect(path)
    import_clan(c, "Гленн Уриск", load_file(source("Гленн Уриск")))
    c.close()

    def test_database() -> Iterator[sqlite3.Connection]:
        cc = connect(path)
        try:
            yield cc
        finally:
            cc.close()

    app.dependency_overrides[database] = test_database
    try:
        response = TestClient(app).get("/api/clans/1/export")
        assert response.status_code == 200
        assert "filename*=UTF-8''" in response.headers["content-disposition"]
        assert lines(response.text) == lines(source("Гленн Уриск").read_text(encoding="utf-8-sig"))
        assert TestClient(app).get("/api/clans/99/export").status_code == 404
    finally:
        app.dependency_overrides.clear()
