"""Файл рода: пишется при загрузке, переписывается после каждой правки, живёт рядом со своей базой."""

import sqlite3
from pathlib import Path

from app.db.clans import import_clan
from app.db.connection import connect
from app.db.editor import NoteForm, PersonFields, person_form, update_person
from app.db.houses import house_file, houses_dir, save_house, translit
from app.db.journal import undo
from app.gedcom.load import load_file, load_text
from conftest import source


def test_import_writes_the_house_file(tmp_path: Path) -> None:
    conn = connect(tmp_path / "x.sqlite3")
    import_clan(conn, "Гленн Уриск", load_file(source("Гленн Уриск")), source_file="Gleann_Uruisg_tree.ged")
    path = tmp_path / "houses" / "Gleann_Uruisg_tree.ged"
    assert path.exists()
    data = load_text(path.read_text(encoding="utf-8"))
    assert len(data.persons) == 38 and not data.warnings


def test_edit_and_undo_rewrite_the_file(tmp_path: Path) -> None:
    conn = connect(tmp_path / "x.sqlite3")
    import_clan(conn, "Гленн Уриск", load_file(source("Гленн Уриск")), source_file="Gleann_Uruisg_tree.ged")
    path = tmp_path / "houses" / "Gleann_Uruisg_tree.ged"
    murdo = conn.execute("SELECT id FROM persons WHERE xref = '@I1007@'").fetchone()[0]
    form = person_form(conn, murdo)
    update_person(conn, murdo, PersonFields(given=form.given, surname=form.surname, sex=form.sex,
                                            birth=form.birth.gedcom, death=form.death.gedcom,
                                            notes=[NoteForm(text="Арендатор")]))
    assert "Арендатор" in path.read_text(encoding="utf-8")
    undo(conn, 1)
    assert "Арендатор" not in path.read_text(encoding="utf-8")


def test_name_comes_from_the_clan_when_the_file_name_is_not_plain(tmp_path: Path) -> None:
    conn = connect(tmp_path / "x.sqlite3")
    import_clan(conn, "Дом Ветра", load_file(source("О'Дувейн")), source_file="род ветра.ged")
    assert house_file(conn, 1) == "Dom_Vetra.ged"
    assert (tmp_path / "houses" / "Dom_Vetra.ged").exists()


def test_second_clan_with_the_same_name_gets_a_suffix(tmp_path: Path) -> None:
    conn = connect(tmp_path / "x.sqlite3")
    import_clan(conn, "Гленн Уриск", load_file(source("Гленн Уриск")), source_file="tree.ged")
    import_clan(conn, "Гленн Уриск — ветвь", load_file(source("О'Дувейн")), source_file="tree.ged")
    assert sorted(p.name for p in (tmp_path / "houses").iterdir()) == ["tree-2.ged", "tree.ged"]


def test_memory_base_writes_nothing() -> None:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    assert houses_dir(conn) is None
    assert save_house(conn, 1) is None


def test_translit() -> None:
    assert translit("Монад Кройве") == "Monad_Kroyve"
    assert translit("O'Dubhain") == "O_Dubhain"
    assert translit("Щукины") == "Schukiny"
