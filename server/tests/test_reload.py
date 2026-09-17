"""Перезалив файла в существующий род: свои по идентификатору, пропавшие без спроса не удаляются."""

import re
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.db.clans import import_clan
from app.db.connection import connect
from app.db.person import person_details
from app.db.reload import clan_matches, preview_reload, reload_clan, suggested_name
from app.db.tree import clan_tree
from app.gedcom.load import load_file, load_text
from app.main import app, database
from conftest import source

GLEANN = "Гленн Уриск"


def edited_gleann() -> str:
    """Юна родилась в 1751, у Кеннаха и Кирсти двое новых детей, Кеннах сын Тормода пропал из файла."""
    text = source(GLEANN).read_bytes().decode("utf-8-sig").replace("\r\n", "\n")
    text = text.replace("0 @I1008@ INDI\n1 NAME Юна /Гленн Уриск/\n2 GIVN Юна\n2 SURN Гленн Уриск\n1 SEX F\n1 BIRT\n2 DATE 1752",
                        "0 @I1008@ INDI\n1 NAME Юна /Гленн Уриск/\n2 GIVN Юна\n2 SURN Гленн Уриск\n1 SEX F\n1 BIRT\n2 DATE 1751")
    text = re.sub(r"0 @I1009@ INDI\n(?:[1-9] .*\n)*", "", text)
    text = text.replace("1 CHIL @I1009@\n", "")
    text = text.replace("0 @F1012@ FAM\n1 HUSB @I1029@\n1 WIFE @I1032@\n1 CHIL @I1035@\n1 CHIL @I1036@\n",
                        "0 @F1012@ FAM\n1 HUSB @I1029@\n1 WIFE @I1032@\n1 CHIL @I1035@\n1 CHIL @I1036@\n1 CHIL @I1039@\n1 CHIL @I1040@\n")
    new = ("0 @I1039@ INDI\n1 NAME Мэри /Гленн Уриск/\n1 SEX F\n1 BIRT\n2 DATE 1962\n1 FAMC @F1012@\n"
           "0 @I1040@ INDI\n1 NAME Калум /Гленн Уриск/\n1 SEX M\n1 BIRT\n2 DATE 1966\n1 FAMC @F1012@\n")
    return text.replace("0 @F1001@ FAM", new + "0 @F1001@ FAM", 1)


@pytest.fixture
def conn(tmp_path: Path):
    c = connect(tmp_path / "reload.sqlite3")
    import_clan(c, GLEANN, load_file(source(GLEANN)))
    import_clan(c, "Монад Кройве", load_file(source("Монад Кройве")))
    yield c
    c.close()


def test_edited_file_is_what_the_test_says() -> None:
    data = load_text(edited_gleann())
    assert "@I1009@" not in data.persons and {"@I1039@", "@I1040@"} <= set(data.persons)
    assert data.warnings == []


def test_matches_point_to_own_clan(conn) -> None:
    data = load_text(edited_gleann())
    matches = {m.name: m.matched for m in clan_matches(conn, data)}
    assert matches[GLEANN] == 37
    assert suggested_name(data) == GLEANN


def test_preview_lists_added_changed_missing_without_touching_base(conn) -> None:
    gleann = clan_tree(conn, 1)
    preview = preview_reload(conn, 1, load_text(edited_gleann()))

    assert [(p.name, p.where) for p in preview.added] == [
        ("Мэри Гленн Уриск", "дочь Кеннаха и Кирсти"), ("Калум Гленн Уриск", "сын Кеннаха и Кирсти")]
    assert [(p.name, [(c.label, c.was, c.now) for c in p.changes]) for p in preview.changed] == [
        ("Юна Гленн Уриск", [("Рождение", "1752", "1751")])]
    assert [(p.name, p.where) for p in preview.missing] == [("Кеннах Гленн Уриск", "сын Тормода и Аилсы")]
    # пропавший на карте разбора остаётся на своём месте
    tree = preview.tree
    kennah = next(p for p in tree.persons if p.xref == "@I1009@")
    assert kennah.parent_families and len(tree.persons) == 40
    # база не тронута
    assert clan_tree(conn, 1) == gleann


def test_reload_keeps_ids_and_missing_unless_asked(conn) -> None:
    before = {p.xref: p.id for p in clan_tree(conn, 1).persons}
    report = reload_clan(conn, 1, load_text(edited_gleann()), delete=set())
    assert (report.added, report.changed, report.deleted, report.kept) == (2, 1, 0, 1)

    after = clan_tree(conn, 1)
    assert {p.xref: p.id for p in after.persons if p.xref in before} == before
    yuna = person_details(conn, before["@I1008@"])
    assert next(e.date for e in yuna.events if e.tag == "BIRT").raw == "1751"
    kennah = next(p for p in after.persons if p.xref == "@I1009@")
    tormod_family = next(f for f in after.families if kennah.id in f.children)
    assert tormod_family.xref == "@F1002@"
    # Монад Кройве не задет
    assert len(clan_tree(conn, 2).persons) == 84


def test_reload_deletes_only_confirmed(conn) -> None:
    kennah = next(p.id for p in clan_tree(conn, 1).persons if p.xref == "@I1009@")
    report = reload_clan(conn, 1, load_text(edited_gleann()), delete={kennah})
    assert (report.deleted, report.kept) == (1, 0)
    assert all(p.xref != "@I1009@" for p in clan_tree(conn, 1).persons)


def test_same_file_twice_changes_nothing(conn) -> None:
    before = clan_tree(conn, 1)
    preview = preview_reload(conn, 1, load_file(source(GLEANN)))
    assert (preview.added, preview.changed, preview.missing) == ([], [], [])
    reload_clan(conn, 1, load_file(source(GLEANN)), delete=set())
    assert clan_tree(conn, 1) == before


@pytest.fixture
def client(tmp_path: Path) -> Iterator[TestClient]:
    path = tmp_path / "api.sqlite3"
    c = connect(path)
    import_clan(c, GLEANN, load_file(source(GLEANN)))
    c.close()

    def test_database():
        d = connect(path)
        try:
            yield d
        finally:
            d.close()

    app.dependency_overrides[database] = test_database
    yield TestClient(app)
    app.dependency_overrides.clear()


def test_upload_flow_over_api(client: TestClient) -> None:
    info = client.post("/api/uploads", params={"file_name": "Gleann.ged"}, content=edited_gleann().encode()).json()
    assert info["suggested_name"] == GLEANN and info["clans"][0]["matched"] == 37

    preview = client.get(f"/api/uploads/{info['token']}/reload/1").json()
    assert len(preview["added"]) == 2 and len(preview["missing"]) == 1

    report = client.post(f"/api/uploads/{info['token']}/reload/1", json={"delete": []}).json()
    assert report == {"added": 2, "changed": 1, "deleted": 0, "kept": 1}
    # файл залит — второй раз им не воспользоваться
    assert client.get(f"/api/uploads/{info['token']}/reload/1").status_code == 404


def test_new_clan_over_api_and_name_clash(client: TestClient) -> None:
    body = source("О'Дувейн").read_bytes()
    token = client.post("/api/uploads", content=body).json()["token"]
    assert client.post(f"/api/uploads/{token}/clan", json={"name": GLEANN}).status_code == 409
    created = client.post(f"/api/uploads/{token}/clan", json={"name": "О'Дувейн"}).json()
    assert (created["name"], created["persons"]) == ("О'Дувейн", 17)


def test_upload_rejects_garbage(client: TestClient) -> None:
    assert client.post("/api/uploads", content="просто текст".encode("cp1251")).status_code == 400
    assert client.post("/api/uploads", content=b"not gedcom").status_code == 400
