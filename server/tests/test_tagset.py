import sqlite3
from collections.abc import Iterator
from pathlib import Path

import pytest

from app.db.clans import import_clan
from app.db.connection import connect
from app.db.editor import PersonFields, update_person
from app.db.journal import undo
from app.db.tagset import TagChange, TagError, delete_tag, tag_usage, update_tag
from app.db.tree import clan_tree
from app.gedcom.load import load_file
from conftest import source


@pytest.fixture
def conn(tmp_path: Path) -> Iterator[sqlite3.Connection]:
    c = connect(tmp_path / "t.sqlite3")
    import_clan(c, "Гленн Уриск", load_file(source("Гленн Уриск")))
    yield c
    c.close()


def tag(conn: sqlite3.Connection, xref: str, *names: str, new: dict[str, str] | None = None) -> int:
    pid = conn.execute("SELECT id FROM persons WHERE xref = ?", (xref,)).fetchone()[0]
    update_person(conn, pid, PersonFields(tags=list(names), new_tags=new or {}))
    return pid


def tags_of(conn: sqlite3.Connection) -> dict[int, list[str]]:
    return {p.id: p.tags for p in clan_tree(conn, 1).persons if p.tags}


def test_rename_and_recolor_keep_place_and_holders(conn: sqlite3.Connection) -> None:
    a = tag(conn, "@I1007@", "Тест", "Военный", new={"Тест": "охра", "Военный": "винный"})
    b = tag(conn, "@I1001@", "Тест")
    change = update_tag(conn, 1, "Тест", TagChange(name="Переселенец", color="синий"))
    assert change.summary == "Метка «Тест» → «Переселенец»"
    assert [(t.name, t.color) for t in clan_tree(conn, 1).tags] == [("Переселенец", "синий"), ("Военный", "винный")]
    assert tags_of(conn) == {a: ["Переселенец", "Военный"], b: ["Переселенец"]}
    with pytest.raises(TagError, match="уже есть"):
        update_tag(conn, 1, "Переселенец", TagChange(name="Военный", color="синий"))
    undo(conn, 1)
    assert tags_of(conn) == {a: ["Тест", "Военный"], b: ["Тест"]}


def test_delete_takes_it_off_everyone_and_undo_brings_it_back(conn: sqlite3.Connection) -> None:
    a = tag(conn, "@I1007@", "Тест", new={"Тест": "охра"})
    b = tag(conn, "@I1001@", "Тест")
    assert tag_usage(conn, 1, "Тест") == 2
    change = delete_tag(conn, 1, "Тест")
    assert change.summary == "Удалена метка «Тест» — снята с 2"
    assert clan_tree(conn, 1).tags == [] and tags_of(conn) == {}
    undo(conn, 1)
    assert [t.name for t in clan_tree(conn, 1).tags] == ["Тест"] and tags_of(conn) == {a: ["Тест"], b: ["Тест"]}


def test_unused_tag_can_be_deleted_too(conn: sqlite3.Connection) -> None:
    pid = tag(conn, "@I1007@", "Тест", new={"Тест": "охра"})
    update_person(conn, pid, PersonFields(tags=[]))  # сняли с человека — в наборе осталась
    assert [t.name for t in clan_tree(conn, 1).tags] == ["Тест"]
    assert delete_tag(conn, 1, "Тест").summary == "Удалена метка «Тест»"
    assert clan_tree(conn, 1).tags == []
