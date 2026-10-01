"""Выгрузка по глазам: редактор получает всё, свой для рода — общее и родовое, прочий зритель — только общее."""

import sqlite3
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.db.clans import import_clan
from app.db.connection import connect
from app.db.eyes import Eyes
from app.gedcom.export import export_clan
from app.gedcom.load import load_text
from app.main import app, database

FILE = """0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Тормод /Гленн/
1 SEX M
1 BIRT
2 DATE 1700
1 FAMS @F1@
0 @I2@ INDI
1 NAME Аилса /Мензис/
1 SEX F
1 _SEE hidden
1 FAMS @F1@
0 @I3@ INDI
1 NAME Мурдо /Гленн/
1 SEX M
1 BIRT
2 DATE 1730
2 PLAC Гленн Уриск
1 _SEE dates all
1 EVEN Арендатор
2 TYPE Comment
1 EVEN Про долги
2 TYPE Comment
2 _SEE hidden
1 EVEN Известен всем
2 TYPE Comment
2 _SEE all
1 FAMC @F1@
0 @I4@ INDI
1 NAME Тайный /Гость/
1 _SEE hidden
1 FAMS @F2@
0 @I5@ INDI
1 NAME Вторая /Тайная/
1 _HIDDEN Y
1 FAMS @F2@
0 @F1@ FAM
1 HUSB @I1@
1 WIFE @I2@
1 CHIL @I3@
0 @F2@ FAM
1 HUSB @I4@
1 WIFE @I5@
0 TRLR
"""


@pytest.fixture
def conn(tmp_path: Path) -> Iterator[sqlite3.Connection]:
    c = connect(tmp_path / "eyes.sqlite3")
    import_clan(c, "Гленн", load_text(FILE))
    yield c
    c.close()


def as_seen(conn: sqlite3.Connection, eyes: Eyes) -> str:
    return export_clan(conn, 1, None if eyes.editor else (lambda level: eyes.allows(level, 1)))


def test_editor_gets_everything(conn: sqlite3.Connection) -> None:
    text = as_seen(conn, Eyes(editor=True))
    for line in ("1 NAME Аилса /Мензис/", "1 _SEE hidden", "1 EVEN Про долги", "0 @F2@ FAM", "2 DATE 1700"):
        assert line in text


def test_stranger_gets_only_the_common_layer(conn: sqlite3.Connection) -> None:
    text = as_seen(conn, Eyes(editor=False))
    # скрытых нет вовсе, и ничто на них не ссылается
    assert "Аилса" not in text and "Тайный" not in text and "Вторая" not in text
    assert "@I2@" not in text and "@I4@" not in text and "@I5@" not in text
    # союз, в котором никого не осталось, пропал вместе со ссылками на него
    assert "@F2@" not in text
    assert "0 @F1@ FAM" in text and "1 HUSB @I1@" in text and "1 CHIL @I3@" in text
    # даты жизни по умолчанию родовые: чужому их нет; у Мурдо они открыты всем
    assert "2 DATE 1700" not in text and "2 DATE 1730" in text
    # событие, от которого осталась одна дата, ушло целиком; место рождения осталось
    assert text.count("1 BIRT") == 1 and "2 PLAC Гленн Уриск" in text
    # заметки: родовая и скрытая не видны, общая видна
    assert "Арендатор" not in text and "Про долги" not in text and "Известен всем" in text
    # разметки доступа в чужом файле нет
    assert "_SEE" not in text and "_HIDDEN" not in text
    assert load_text(text).warnings == []


def test_clan_member_gets_the_clan_layer_too(conn: sqlite3.Connection) -> None:
    text = as_seen(conn, Eyes(editor=False, clans=frozenset({1})))
    assert "2 DATE 1700" in text and "Арендатор" in text
    assert "Про долги" not in text and "Аилса" not in text and "@F2@" not in text
    # свой для другого рода здесь — чужой
    other = as_seen(conn, Eyes(editor=False, clans=frozenset({7})))
    assert "2 DATE 1700" not in other and "Арендатор" not in other


def test_editor_can_look_as_either_viewer(tmp_path: Path) -> None:
    """Редактор смотрит чужими глазами: 0 — общий зритель, номер рода — родовой."""
    path = tmp_path / "api.sqlite3"
    c = connect(path)
    import_clan(c, "Гленн", load_text(FILE))
    c.close()

    def test_database() -> Iterator[sqlite3.Connection]:
        cc = connect(path)
        try:
            yield cc
        finally:
            cc.close()

    app.dependency_overrides[database] = test_database
    try:
        client = TestClient(app)

        def born(as_viewer: str) -> dict[str, int | None]:
            tree = client.get(f"/api/clans/1/tree{as_viewer}").json()
            return {p["given"]: (p["birth"] or {}).get("year") for p in tree["persons"]}

        assert born("") == {"Тормод": 1700, "Аилса": None, "Мурдо": 1730, "Тайный": None, "Вторая": None}
        # родовой зритель: скрытых нет, даты рода видны
        assert born("?as_viewer=1") == {"Тормод": 1700, "Мурдо": 1730}
        # общий зритель: скрытых нет, родовые даты закрыты, открытые всем — видны
        assert born("?as_viewer=0") == {"Тормод": None, "Мурдо": 1730}
        common = client.get("/api/clans/1/export?as_viewer=0").text
        assert "2 DATE 1700" not in common and "Арендатор" not in common
        assert "2 DATE 1700" in client.get("/api/clans/1/export?as_viewer=1").text
    finally:
        app.dependency_overrides.clear()
