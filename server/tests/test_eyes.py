"""Что видно зрителю: скрытых нет вовсе, у чужого рода нет дат, дети скрытого остаются."""

import sqlite3

import pytest

from app.db.clans import import_clan
from app.db.connection import migrate
from app.db.editor import PersonFields, update_person
from app.db.eyes import Eyes, sift
from app.db.tree import clan_tree
from app.gedcom.load import load_file
from tests.conftest import source


@pytest.fixture()
def conn() -> sqlite3.Connection:
    connection = sqlite3.connect(":memory:")
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    migrate(connection)
    import_clan(connection, "Гленн Уриск", load_file(source("Гленн Уриск")), source_file="Gleann.ged")
    return connection


def someone(conn: sqlite3.Connection) -> int:
    """Любой человек рода: имена в файлах разные, а проверяем мы уровни, а не имя."""
    row = conn.execute("SELECT id FROM persons ORDER BY id LIMIT 1").fetchone()
    assert row is not None
    return int(row["id"])


def test_editor_sees_everything(conn: sqlite3.Connection) -> None:
    whole = clan_tree(conn, 1)
    same = sift(clan_tree(conn, 1), Eyes(editor=True))
    assert len(same.persons) == len(whole.persons)


def test_hidden_person_is_absent_for_viewer(conn: sqlite3.Connection) -> None:
    pid = someone(conn)
    update_person(conn, pid, PersonFields(see="hidden"))
    seen = sift(clan_tree(conn, 1), Eyes(editor=False, clans=frozenset({1})))
    assert pid not in {p.id for p in seen.persons}
    # никаких следов: ни в родителях семьи, ни в детях
    assert all(family.husband != pid and family.wife != pid for family in seen.families)
    assert all(pid not in family.children for family in seen.families)


def test_children_of_hidden_stay_in_the_tree(conn: sqlite3.Connection) -> None:
    whole = clan_tree(conn, 1)
    father = next(p for p in whole.persons if any(
        f.husband == p.id and f.children for f in whole.families))
    kids = [child for f in whole.families if f.husband == father.id for child in f.children]
    update_person(conn, father.id, PersonFields(see="hidden"))

    seen = sift(clan_tree(conn, 1), Eyes(editor=False, clans=frozenset({1})))
    left = {p.id for p in seen.persons}
    assert set(kids) <= left
    # семья осталась без отца: на карте это знак «родители не записаны»
    family = next(f for f in seen.families if set(kids) & set(f.children))
    assert family.husband is None


def test_dates_hide_from_stranger_but_stay_for_own(conn: sqlite3.Connection) -> None:
    own = sift(clan_tree(conn, 1), Eyes(editor=False, clans=frozenset({1})))
    stranger = sift(clan_tree(conn, 1), Eyes(editor=False, clans=frozenset()))
    assert any(p.birth or p.death for p in own.persons)
    assert all(p.birth is None and p.death is None for p in stranger.persons)
    # имена и место в дереве остаются: по документу это общий слой
    assert {p.id for p in stranger.persons} == {p.id for p in own.persons}


def test_clan_level_person_is_hidden_from_stranger(conn: sqlite3.Connection) -> None:
    pid = someone(conn)
    update_person(conn, pid, PersonFields(see="clan"))
    own = sift(clan_tree(conn, 1), Eyes(editor=False, clans=frozenset({1})))
    stranger = sift(clan_tree(conn, 1), Eyes(editor=False, clans=frozenset()))
    assert pid in {p.id for p in own.persons}
    assert pid not in {p.id for p in stranger.persons}


def test_portrait_level_takes_the_photo_away(conn: sqlite3.Connection) -> None:
    pid = someone(conn)
    update_person(conn, pid, PersonFields(see_portrait="hidden"))
    seen = sift(clan_tree(conn, 1), Eyes(editor=False, clans=frozenset({1})))
    person = next(p for p in seen.persons if p.id == pid)
    assert person.photo is None and person.portrait == "silhouette"


def test_note_level_hides_the_note_from_stranger(conn: sqlite3.Connection) -> None:
    """Заметка уровнем «родовое» уходит только своим, «скрытая» — никому, кроме редактора."""
    from app.db.editor import NoteForm, person_form
    from app.db.eyes import sift_person
    from app.db.person import person_details

    pid = someone(conn)
    form = person_form(conn, pid)
    update_person(conn, pid, PersonFields(
        given=form.given, surname=form.surname, sex=form.sex,
        birth=form.birth.gedcom, death=form.death.gedcom,
        notes=[NoteForm(text="Своим", see="clan"), NoteForm(text="Никому", see="hidden"),
               NoteForm(text="Всем", see="all")],
    ))

    def notes(eyes: Eyes) -> list[str]:
        seen = sift_person(person_details(conn, pid), eyes)
        return [e.value or "" for e in seen.events if e.tag == "EVEN" and e.type == "Comment"]

    assert notes(Eyes(editor=True)) == ["Своим", "Никому", "Всем"]
    assert notes(Eyes(editor=False, clans=frozenset({1}))) == ["Своим", "Всем"]
    assert notes(Eyes(editor=False, clans=frozenset())) == ["Всем"]


def test_hidden_link_is_not_shown_to_viewer(conn: sqlite3.Connection) -> None:
    from app.db.eyes import sift_links
    from app.db.links import ClanLink, LinkPerson

    other = LinkPerson(id=2, clan_id=2, clan_name="Уинтерхоуп", name="Ниалл", born=1683, died=1751)
    links = [
        ClanLink(link_id=1, person_id=1, see="all", other=other),
        ClanLink(link_id=2, person_id=1, see="clan", other=other),
        ClanLink(link_id=3, person_id=1, see="hidden", other=other),
    ]
    assert [l.link_id for l in sift_links(links, Eyes(editor=True), 1)] == [1, 2, 3]
    assert [l.link_id for l in sift_links(links, Eyes(editor=False, clans=frozenset({1})), 1)] == [1, 2]
    assert [l.link_id for l in sift_links(links, Eyes(editor=False, clans=frozenset()), 1)] == [1]
