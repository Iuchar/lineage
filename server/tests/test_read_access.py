"""Что отдаётся на чтение и кому.

Правка закрыта заслоном, а чтение — нет: оно разбирается по глазам. Здесь проверяется, что
рабочие столы редактора закрыты целиком, а то, что нужно и зрителю, просеивается, а не отдаётся
как есть. Пока в базе нет ни одного редактора, открыто всё: приложение на одном компьютере.
"""

from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.db.access import add_editor
from app.db.clans import import_clan
from app.db.connection import connect
from app.db.editor import PersonFields, update_person
from app.gedcom.load import load_file
from conftest import source

# рабочие столы редактора: зритель на них не заглядывает ни в каком виде
EDITOR_ONLY = [
    "/api/persons?q=а",
    "/api/persons/{person}/form",
    "/api/persons/{person}/delete-preview",
    "/api/links",
    "/api/links/candidates",
    "/api/clans/{clan}/tags/Воин/usage",
    "/api/dates/parse?text=1920",
]


@pytest.fixture()
def world(tmp_path: Path, monkeypatch) -> Iterator[dict]:
    import app.config
    import app.main

    path = tmp_path / "base.sqlite3"
    monkeypatch.setattr(app.config, "DB_PATH", path)
    monkeypatch.setattr(app.main, "DB_PATH", path)
    conn = connect(path)
    import_clan(conn, "Гленн Уриск", load_file(source("Гленн Уриск")))
    family = next(
        row for row in conn.execute("SELECT id FROM families WHERE clan_id = 1")
        if conn.execute("SELECT count(*) FROM family_children WHERE family_id = ?", (row["id"],)).fetchone()[0] > 1
    )["id"]
    kid = conn.execute(
        "SELECT person_id FROM family_children WHERE family_id = ? ORDER BY position", (family,)
    ).fetchone()[0]
    name = conn.execute("SELECT given, surname FROM persons WHERE id = ?", (kid,)).fetchone()
    update_person(conn, kid, PersonFields(given=name["given"], surname=name["surname"], see="hidden"))
    add_editor(conn, "Tyr", "длинный пароль")
    conn.close()

    editor = TestClient(app.main.app)
    editor.post("/api/login", json={"name": "Tyr", "password": "длинный пароль"})
    yield {"editor": editor, "guest": TestClient(app.main.app), "family": family, "hidden": kid,
           "other": next(p["id"] for p in editor.get("/api/clans/1/tree").json()["persons"] if p["id"] != kid)}


def test_editor_desks_are_closed_to_a_guest(world: dict) -> None:
    for pattern in EDITOR_ONLY:
        url = pattern.format(person=world["other"], clan=1)
        assert world["guest"].get(url).status_code == 401, f"{url} открыт постороннему"
        assert world["editor"].get(url).status_code != 401, f"{url} закрылся и от редактора"


def test_family_card_hides_the_hidden_child(world: dict) -> None:
    """Карточка союза нужна и зрителю — он открывает её щелчком. Но скрытого ребёнка в ней быть не должно:
    иначе зритель узнаёт, что у пары есть кто-то ещё, кого ему не показывают."""
    at_editor = world["editor"].get(f"/api/families/{world['family']}/form").json()
    assert world["hidden"] in [c["id"] for c in at_editor["children"]]

    answer = world["guest"].get(f"/api/families/{world['family']}/form")
    assert answer.status_code == 200, "зритель должен открывать карточку союза"
    kids = [c["id"] for c in answer.json()["children"]]
    assert world["hidden"] not in kids
    assert len(kids) == len(at_editor["children"]) - 1
    # родство оставшихся не съехало вместе с вычеркнутым
    assert [c["pedigree"] for c in answer.json()["children"]] == \
           [c["pedigree"] for c in at_editor["children"] if c["id"] != world["hidden"]]


def test_hidden_spouse_leaves_the_family_card(world: dict, tmp_path: Path) -> None:
    """Скрытый супруг так же уходит из карточки союза: союз остаётся, человека в нём нет."""
    import app.main

    tree = world["editor"].get("/api/clans/1/tree").json()
    family = next(f for f in tree["families"] if f["husband"] is not None and f["wife"] is not None)
    husband = next(p for p in tree["persons"] if p["id"] == family["husband"])
    conn = connect(app.main.DB_PATH)
    update_person(conn, husband["id"],
                  PersonFields(given=husband["given"], surname=husband["surname"], see="hidden"))
    conn.close()

    at_guest = world["guest"].get(f"/api/families/{family['id']}/form").json()
    assert at_guest["husband"] is None
    assert at_guest["wife"] == family["wife"]


def test_clan_list_and_photos_stay_open(world: dict) -> None:
    """Список родословных и снимки нужны любому: зритель видит общий слой каждого рода."""
    assert world["guest"].get("/api/clans").status_code == 200
    assert world["guest"].get("/api/health").status_code == 200


def test_api_description_is_for_the_editor(world: dict) -> None:
    """Описание API само по себе не данные, но показывает всю поверхность приложения разом.
    Постороннему оно ни к чему, а редактору пригождается."""
    for url in ("/api/docs", "/api/openapi.json"):
        assert world["guest"].get(url).status_code == 401, f"{url} открыт постороннему"
        assert world["editor"].get(url).status_code == 200, f"{url} закрылся и от редактора"
