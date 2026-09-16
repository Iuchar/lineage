import pytest

from app.gedcom.load import load_file, load_text
from conftest import CLANS, source


@pytest.mark.parametrize("clan", CLANS)
def test_counts_match_the_design_document(clan: str) -> None:
    _, persons, families, stubs = CLANS[clan]
    data = load_file(source(clan))
    assert len(data.persons) == persons
    assert len(data.families) == families
    assert sum(p.is_branch_stub for p in data.persons.values()) == stubs
    assert data.warnings == []


def test_maiden_and_married_surnames_are_kept_apart() -> None:
    isabella = load_file(source("Монад Кройве")).persons["@I52@"]
    assert isabella.name_raw == "Изабелла /Монад Кройве/"
    assert (isabella.given, isabella.surname, isabella.married_surname) == ("Изабелла", "Стюарт", "Монад Кройве")


def test_marriage_order_follows_the_file() -> None:
    data = load_file(source("Монад Кройве"))
    malcolm = data.persons["@I538@"]
    wives = [data.persons[data.families[f].wife or ""].given for f in malcolm.spouse_families]
    assert wives == ["Иона", "Финнула", "Элспет"]


def test_namesakes_inside_one_clan_stay_separate_people() -> None:
    data = load_file(source("Гленн Уриск"))
    kennachs = [p for p in data.persons.values() if p.given == "Кеннах"]
    assert sorted(p.event("BIRT").date.sort_year for p in kennachs) == [1755, 1928]  # type: ignore[union-attr]


def test_years_and_notes_are_read() -> None:
    hamish = load_file(source("Монад Кройве")).persons["@I51@"]
    assert hamish.event("BIRT").date.sort_year == 1798  # type: ignore[union-attr]
    assert hamish.event("DEAT").date.sort_year == 1920  # type: ignore[union-attr]
    note = hamish.event("EVEN")
    assert note is not None and (note.type, note.value) == ("Comment", "Основатель рода")


def test_name_without_givn_and_surn_is_split_from_name_line() -> None:
    person = load_text("0 @I1@ INDI\n1 NAME Сорха /Гленн Уриск/\n").persons["@I1@"]
    assert (person.given, person.surname) == ("Сорха", "Гленн Уриск")


def test_pedigree_place_and_family_events() -> None:
    data = load_text(
        "0 @I1@ INDI\n1 NAME Кормак /О'Дувейн/\n1 FAMC @F1@\n2 PEDI adopted\n"
        "0 @F1@ FAM\n1 CHIL @I1@\n1 MARR\n2 DATE ABT 1790\n2 PLAC Эттрик\n"
    )
    assert data.persons["@I1@"].parent_families[0].pedigree == "adopted"
    marriage = data.families["@F1@"].events[0]
    assert (marriage.tag, marriage.date.kind, marriage.place) == ("MARR", "about", "Эттрик")  # type: ignore[union-attr]


def test_dangling_pointers_warn_instead_of_failing() -> None:
    data = load_text("0 @I1@ INDI\n1 FAMS @F9@\n0 @F1@ FAM\n1 HUSB @I7@\n")
    assert len(data.warnings) == 2


def test_unknown_top_level_records_are_kept() -> None:
    data = load_text("0 HEAD\n0 @N1@ NOTE текст\n0 @S1@ SOUR\n1 TITL Приходская книга\n0 TRLR\n")
    assert [r.tag for r in data.extras] == ["NOTE", "SOUR"]
