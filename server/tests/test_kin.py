import sqlite3
from collections.abc import Iterator
from pathlib import Path

import pytest

from app.db.clans import import_clan
from app.db.connection import connect
from app.db.editor import EditError, NewPerson, PersonFields, Relation, add_person, person_form, update_person
from app.db.journal import undo
from app.db.kin import FamilyFields, KinChanges, KinError, ParentChange, SpouseChange, family_form, update_family
from app.db.tree import clan_tree
from app.gedcom.export import export_clan
from app.gedcom.load import load_file
from conftest import source


@pytest.fixture
def conn(tmp_path: Path) -> Iterator[sqlite3.Connection]:
    c = connect(tmp_path / "t.sqlite3")
    import_clan(c, "Гленн Уриск", load_file(source("Гленн Уриск")))
    import_clan(c, "Монад Кройве", load_file(source("Монад Кройве")))
    yield c
    c.close()


def pid(conn: sqlite3.Connection, clan: int, xref: str) -> int:
    return conn.execute("SELECT id FROM persons WHERE clan_id = ? AND xref = ?", (clan, xref)).fetchone()[0]


def person(conn: sqlite3.Connection, clan: int, person_id: int):  # noqa: ANN201
    return next(p for p in clan_tree(conn, clan).persons if p.id == person_id)


def family(conn: sqlite3.Connection, clan: int, family_id: int):  # noqa: ANN201
    return next(f for f in clan_tree(conn, clan).families if f.id == family_id)


def by_name(conn: sqlite3.Connection, clan: int, given: str, parent_family: int) -> int:
    return next(p.id for p in clan_tree(conn, clan).persons if p.given == given and parent_family in p.parent_families)


def test_sibling_without_parents_gets_a_family_of_children_only(conn: sqlite3.Connection) -> None:
    duncan = pid(conn, 2, "@I575@")
    assert person(conn, 2, duncan).parent_families == []
    made = add_person(conn, 2, NewPerson(fields=PersonFields(given="Алистер", surname="Монад Кройве", sex="M"),
                                         relation=Relation(kind="sibling", person_id=duncan)))
    assert made.change.summary == "Дункан: брат — Алистер Монад Кройве"
    fam = person(conn, 2, duncan).parent_families
    assert len(fam) == 1 and person(conn, 2, made.person_id).parent_families == fam
    f = family(conn, 2, fam[0])
    assert (f.husband, f.wife, f.children) == (None, None, [duncan, made.person_id])
    # родитель встаёт над обоими
    father = add_person(conn, 2, NewPerson(fields=PersonFields(given="Нил", sex="M"),
                                           relation=Relation(kind="parent", person_id=made.person_id)))
    assert family(conn, 2, fam[0]).husband == father.person_id
    assert "0 @F" in export_clan(conn, 2)
    undo(conn, 2)
    undo(conn, 2)
    assert person(conn, 2, duncan).parent_families == []


def test_unlink_and_move_child_without_deleting(conn: sqlite3.Connection) -> None:
    murdo = pid(conn, 1, "@I1007@")
    union = person(conn, 1, murdo).spouse_families[0]
    moira = by_name(conn, 1, "Мойра", union)
    change = update_person(conn, moira, PersonFields(given="Мойра", surname="Гленн Уриск", sex="F",
                                                     birth="1787", death="1884",
                                                     kin=KinChanges(parents=[ParentChange(family_id=union, action="drop")])))
    assert change.summary == "Мойра: отвязана от родителей: Мурдо и Аина"
    assert person(conn, 1, moira).parent_families == []
    assert moira not in family(conn, 1, union).children
    undo(conn, 1)
    assert person(conn, 1, moira).parent_families == [union]
    # перенос к родителям Мурдо; к собственным детям — нельзя
    grand = person(conn, 1, murdo).parent_families[0]
    update_person(conn, moira, PersonFields(given="Мойра", surname="Гленн Уриск", sex="F", birth="1787", death="1884",
                                            kin=KinChanges(parents=[ParentChange(family_id=union, action="move", to_family_id=grand)])))
    assert person(conn, 1, moira).parent_families == [grand]
    undo(conn, 1)
    with pytest.raises(EditError, match="потомка"):
        update_person(conn, murdo, PersonFields(given="Мурдо", surname="Гленн Уриск", sex="M", birth="1748", death="1851",
                                                kin=KinChanges(parents=[ParentChange(family_id=grand, action="move", to_family_id=union)])))


def test_pedigree_is_in_the_tree(conn: sqlite3.Connection) -> None:
    murdo = pid(conn, 1, "@I1007@")
    union = person(conn, 1, murdo).spouse_families[0]
    moira = by_name(conn, 1, "Мойра", union)
    change = update_person(conn, moira, PersonFields(given="Мойра", surname="Гленн Уриск", sex="F", birth="1787", death="1884",
                                                     kin=KinChanges(parents=[ParentChange(family_id=union, pedigree="adopted")])))
    assert change.summary == "Мойра: родство с Мурдо и Аина — приёмное"
    f = family(conn, 1, union)
    assert dict(zip(f.children, f.child_pedigree, strict=True))[moira] == "adopted"
    # родные — отдельной семьёй
    made = add_person(conn, 1, NewPerson(fields=PersonFields(given="Катриона", sex="F"),
                                         relation=Relation(kind="parent", person_id=moira, separate=True)))
    assert len(person(conn, 1, moira).parent_families) == 2
    assert family(conn, 1, person(conn, 1, made.person_id).spouse_families[0]).child_pedigree == ["birth"]


def test_spouse_drop_and_replace(conn: sqlite3.Connection) -> None:
    murdo = pid(conn, 1, "@I1007@")
    union = person(conn, 1, murdo).spouse_families[0]
    moira = by_name(conn, 1, "Мойра", union)
    her_union = person(conn, 1, moira).spouse_families[0]
    other = next(p.id for p in clan_tree(conn, 1).persons if p.given == "Юна")
    fields = dict(given="Мойра", surname="Гленн Уриск", sex="F", birth="1787", death="1884")
    change = update_person(conn, moira, PersonFields(**fields, kin=KinChanges(spouses=[
        SpouseChange(family_id=her_union, action="replace", to_person_id=other)])))
    assert "Юна — заменила" in change.summary
    assert other in (family(conn, 1, her_union).husband, family(conn, 1, her_union).wife)
    assert person(conn, 1, moira).spouse_families == []
    undo(conn, 1)
    update_person(conn, moira, PersonFields(**fields, kin=KinChanges(spouses=[SpouseChange(family_id=her_union, action="drop")])))
    f = family(conn, 1, her_union)
    assert moira not in (f.husband, f.wife) and f.children  # дети остались у мужа


def test_marriage_order_by_hand(conn: sqlite3.Connection) -> None:
    aili = pid(conn, 2, "@I57@")
    ruled = person(conn, 2, aili).spouse_families
    wanted = [ruled[0], ruled[2], ruled[1]]
    base = person_form(conn, aili)
    assert not base.marriage_order_manual
    fields = dict(given=base.given, surname=base.surname, sex=base.sex, birth=base.birth.input, death=base.death.input,
                  notes=base.notes)
    change = update_person(conn, aili, PersonFields(**fields, kin=KinChanges(marriage_order=wanted)))
    assert change.summary == "Айли: очередь браков"
    assert person(conn, 2, aili).spouse_families == wanted and person_form(conn, aili).marriage_order_manual
    update_person(conn, aili, PersonFields(**fields, kin=KinChanges(marriage_order_auto=True)))
    assert person(conn, 2, aili).spouse_families == ruled
    with pytest.raises(EditError, match="не совпадает"):
        update_person(conn, aili, PersonFields(**fields, kin=KinChanges(marriage_order=ruled[:2])))


def test_family_form_marriage_divorce_children(conn: sqlite3.Connection) -> None:
    murdo = pid(conn, 1, "@I1007@")
    union = person(conn, 1, murdo).spouse_families[0]
    form = family_form(conn, union)
    assert form.marriage.gedcom is None and not form.divorced
    kids = [c.id for c in form.children]
    change = update_family(conn, union, FamilyFields(marriage="около 1780", place="Инвернесс", divorced=True,
                                                     children=list(reversed(kids))))
    assert change.summary == "Мурдо и Аина: венчание около 1780, Инвернесс, развод, порядок детей"
    form = family_form(conn, union)
    assert (form.marriage.gedcom, form.place, form.divorced) == ("ABT 1780", "Инвернесс", True)
    assert [c.id for c in form.children] == list(reversed(kids))
    assert family(conn, 1, union).divorced
    text = export_clan(conn, 1)
    assert "1 MARR\n2 DATE ABT 1780\n2 PLAC Инвернесс\n1 DIV Y" in text
    undo(conn, 1)
    assert family_form(conn, union).marriage.gedcom is None
    update_family(conn, union, FamilyFields(unlink=[kids[1]]))
    assert kids[1] not in family(conn, 1, union).children
    with pytest.raises(KinError, match="Венчание"):
        update_family(conn, union, FamilyFields(marriage="когда-то"))
