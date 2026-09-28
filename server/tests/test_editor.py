import json
import sqlite3
from collections.abc import Iterator
from pathlib import Path

import pytest

from app.db.clans import import_clan
from app.db.connection import connect
from app.db.editor import (EditError, NoteForm, NewPerson, PersonFields, Relation, add_person, delete_person, delete_preview,
                           person_form, update_person)
from app.db.journal import RevertConflictError, clan_changes, person_changes, redo, revert, undo, undo_to
from app.db.links import create_link
from app.db.tree import clan_tree
from app.gedcom.load import load_file
from conftest import source


@pytest.fixture
def conn(tmp_path: Path) -> Iterator[sqlite3.Connection]:
    c = connect(tmp_path / "edit.sqlite3")
    import_clan(c, "Гленн Уриск", load_file(source("Гленн Уриск")))
    import_clan(c, "Уинтерхоуп", load_file(source("Уинтерхоуп")))
    yield c
    c.close()


def pid(conn: sqlite3.Connection, xref: str, clan: int = 1) -> int:
    return conn.execute("SELECT id FROM persons WHERE xref = ? AND clan_id = ?", (xref, clan)).fetchone()[0]


def snapshot(conn: sqlite3.Connection) -> str:
    """Всё, что видно снаружи: дерево рода и сырые записи — для сравнения «до» и «после отката»."""
    raws = [tuple(r) for r in conn.execute("SELECT id, raw FROM persons ORDER BY id")]
    fams = [tuple(r) for r in conn.execute("SELECT id, raw FROM families ORDER BY id")]
    return json.dumps([clan_tree(conn, 1).model_dump(), raws, fams], ensure_ascii=False, sort_keys=True)


def fields(conn: sqlite3.Connection, person_id: int, **changes: object) -> PersonFields:
    form = person_form(conn, person_id)
    data = {"given": form.given, "surname": form.surname, "married_surname": form.married_surname,
            "sex": form.sex, "birth": form.birth.gedcom, "death": form.death.gedcom, "notes": form.notes}
    data.update(changes)
    return PersonFields(**data)


MURDO = "@I1007@"


def aina_id(conn: sqlite3.Connection) -> int:
    return next(p.id for p in clan_tree(conn, 1).persons if p.given == "Аина")


def test_edit_birth_and_undo_redo(conn: sqlite3.Connection) -> None:
    murdo = pid(conn, MURDO)
    before = snapshot(conn)
    change = update_person(conn, murdo, fields(conn, murdo, birth="около 1748"))
    assert change.summary == "Мурдо: рождение 1748 → около 1748"
    person = next(p for p in clan_tree(conn, 1).persons if p.id == murdo)
    assert (person.birth.kind, person.birth.year, person.birth.raw) == ("about", 1748, "ABT 1748")
    undo(conn, 1)
    assert snapshot(conn) == before
    redo(conn, 1)
    assert person_form(conn, murdo).birth.gedcom == "ABT 1748"


def test_unknown_tags_survive_an_edit(conn: sqlite3.Connection) -> None:
    murdo = pid(conn, MURDO)
    raw_before = conn.execute("SELECT raw FROM persons WHERE id = ?", (murdo,)).fetchone()[0]
    tags_before = [c["t"] for c in json.loads(raw_before)["c"]]
    update_person(conn, murdo, fields(conn, murdo, notes=[NoteForm(text="Арендатор")]))
    raw_after = json.loads(conn.execute("SELECT raw FROM persons WHERE id = ?", (murdo,)).fetchone()[0])
    tags_after = [c["t"] for c in raw_after["c"]]
    assert tags_after[: len(tags_before)] == tags_before
    assert raw_after["c"][-1] == {"t": "EVEN", "v": "Арендатор", "c": [{"t": "TYPE", "v": "Comment"}]}
    assert [(n.text, n.see) for n in person_form(conn, murdo).notes] == [("Арендатор", "clan")]


def test_bad_date_is_refused(conn: sqlite3.Connection) -> None:
    murdo = pid(conn, MURDO)
    with pytest.raises(EditError, match="в марте 31 день"):
        update_person(conn, murdo, fields(conn, murdo, birth="32 мар 1748"))
    assert clan_changes(conn, 1) == []


def child_names(conn: sqlite3.Connection, person_id: int) -> list[list[str]]:
    tree = clan_tree(conn, 1)
    persons = {p.id: p for p in tree.persons}
    families = {f.id: f for f in tree.families}
    return [[persons[c].given or "" for c in families[f].children] for f in persons[person_id].spouse_families]


def test_child_with_wife_or_with_unknown_mother(conn: sqlite3.Connection) -> None:
    murdo = pid(conn, MURDO)
    before = snapshot(conn)
    add_person(conn, 1, NewPerson(fields=PersonFields(given="Ангус", surname="Гленн Уриск", sex="M"),
                                  relation=Relation(kind="child", person_id=murdo, other_id=aina_id(conn))))
    assert child_names(conn, murdo) == [["Дэрмид", "Мойра", "Ангус"]]
    created = add_person(conn, 1, NewPerson(fields=PersonFields(given="Коннор", sex="M"),
                                            relation=Relation(kind="child", person_id=murdo, other_id=None)))
    assert child_names(conn, murdo) == [["Дэрмид", "Мойра", "Ангус"], ["Коннор"]]
    assert created.change.summary == "Мурдо: сын — Коннор"
    assert created.person_id in created.change.persons and murdo in created.change.persons
    undo(conn, 1)
    undo(conn, 1)
    assert snapshot(conn) == before


def test_parents_for_someone_without_them(conn: sqlite3.Connection) -> None:
    aina = aina_id(conn)
    add_person(conn, 1, NewPerson(fields=PersonFields(given="Иэн", surname="Драммонд", sex="M"),
                                  relation=Relation(kind="parent", person_id=aina)))
    add_person(conn, 1, NewPerson(fields=PersonFields(given="Флора", sex="F"),
                                  relation=Relation(kind="parent", person_id=aina)))
    tree = clan_tree(conn, 1)
    persons = {p.id: p for p in tree.persons}
    family = next(f for f in tree.families if f.id == persons[aina].parent_families[0])
    assert (persons[family.husband].given, persons[family.wife].given) == ("Иэн", "Флора")
    with pytest.raises(EditError, match="отец уже записан"):
        add_person(conn, 1, NewPerson(fields=PersonFields(given="Ещё", sex="M"),
                                      relation=Relation(kind="parent", person_id=aina)))


def test_siblings_full_and_half(conn: sqlite3.Connection) -> None:
    murdo = pid(conn, MURDO)
    full = add_person(conn, 1, NewPerson(fields=PersonFields(given="Шона", sex="F"),
                                         relation=Relation(kind="sibling", person_id=murdo, parents="both")))
    half = add_person(conn, 1, NewPerson(fields=PersonFields(given="Дугал", sex="M"),
                                         relation=Relation(kind="sibling", person_id=murdo, parents="father")))
    tree = clan_tree(conn, 1)
    persons = {p.id: p for p in tree.persons}
    assert persons[full.person_id].parent_families == persons[murdo].parent_families
    family = next(f for f in tree.families if f.id == persons[half.person_id].parent_families[0])
    father = next(f for f in tree.families if f.id == persons[murdo].parent_families[0]).husband
    assert (family.husband, family.wife) == (father, None)
    assert half.change.summary == "Мурдо: брат — Дугал"


def test_new_spouse_and_linking_an_existing_person(conn: sqlite3.Connection) -> None:
    murdo = pid(conn, MURDO)
    add_person(conn, 1, NewPerson(fields=PersonFields(given="Кэтрин", sex="F"),
                                  relation=Relation(kind="spouse", person_id=murdo)))
    assert len(next(p for p in clan_tree(conn, 1).persons if p.id == murdo).spouse_families) == 2
    orphan = add_person(conn, 1, NewPerson(fields=PersonFields(given="Найдёныш", sex="M"),
                                           relation=Relation(kind="spouse", person_id=murdo)))
    before = len(clan_tree(conn, 1).persons)
    add_person(conn, 1, NewPerson(existing_id=orphan.person_id,
                                  relation=Relation(kind="child", person_id=murdo, pedigree="adopted")))
    assert len(clan_tree(conn, 1).persons) == before  # никто не создан — привязан записанный
    raw = json.loads(conn.execute("SELECT raw FROM persons WHERE id = ?", (orphan.person_id,)).fetchone()[0])
    famc = next(c for c in raw["c"] if c["t"] == "FAMC")
    assert famc["c"] == [{"t": "PEDI", "v": "adopted"}]


def test_delete_preview_counts_the_branch(conn: sqlite3.Connection) -> None:
    preview = delete_preview(conn, pid(conn, MURDO))
    assert (preview.children, preview.descendants, preview.inlaws, preview.stubs, preview.branch_total) == (2, 13, 10, 5, 29)


def test_delete_alone_and_with_branch_are_undone_exactly(conn: sqlite3.Connection) -> None:
    murdo = pid(conn, MURDO)
    sorha = pid(conn, "@I1035@")
    twin = conn.execute("SELECT id FROM persons WHERE clan_id = 2 AND given = 'Сорха'").fetchone()[0]
    create_link(conn, sorha, twin)
    before = snapshot(conn)
    links_before = conn.execute("SELECT COUNT(*) FROM person_links").fetchone()[0]

    delete_person(conn, murdo)
    tree = clan_tree(conn, 1)
    assert murdo not in {p.id for p in tree.persons}
    assert len(tree.persons) == 37
    undo(conn, 1)
    assert snapshot(conn) == before

    change = delete_person(conn, murdo, branch=True)
    assert len(clan_tree(conn, 1).persons) == 38 - 29
    assert conn.execute("SELECT COUNT(*) FROM person_links").fetchone()[0] == links_before - 1  # Сорха ушла
    assert "ещё 28" in change.summary
    undo(conn, 1)
    assert snapshot(conn) == before
    assert conn.execute("SELECT COUNT(*) FROM person_links").fetchone()[0] == links_before


def test_new_change_cuts_the_redo_tail(conn: sqlite3.Connection) -> None:
    murdo = pid(conn, MURDO)
    update_person(conn, murdo, fields(conn, murdo, birth="около 1748"))
    undo(conn, 1)
    update_person(conn, murdo, fields(conn, murdo, death="1852"))
    assert redo(conn, 1) is None
    assert [c.summary for c in clan_changes(conn, 1)] == ["Мурдо: смерть 1851 → 1852"]


def test_undo_to_takes_back_this_and_everything_after(conn: sqlite3.Connection) -> None:
    murdo = pid(conn, MURDO)
    before = snapshot(conn)
    first = update_person(conn, murdo, fields(conn, murdo, birth="около 1748"))
    update_person(conn, murdo, fields(conn, murdo, death="1852"))
    assert len(undo_to(conn, first.id)) == 2
    assert snapshot(conn) == before


def test_revert_from_person_history(conn: sqlite3.Connection) -> None:
    murdo = pid(conn, MURDO)
    birth = update_person(conn, murdo, fields(conn, murdo, birth="около 1748"))
    death = update_person(conn, murdo, fields(conn, murdo, death="1852"))
    with pytest.raises(RevertConflictError):
        revert(conn, birth.id)  # запись Мурдо после этого меняли ещё раз
    back = revert(conn, death.id)
    assert person_form(conn, murdo).death.gedcom == "1851"
    assert back.reverts == death.id and back.summary.startswith("Вернуть:")
    assert [c.id for c in person_changes(conn, murdo)][0] == back.id
