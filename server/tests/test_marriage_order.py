"""Очередь браков: попарно — дата венчания, год первого ребёнка, смерть бездетного супруга раньше детей другого брака,
год рождения супругов; сравнить нечем — порядок файла."""

import re

from app.db.clans import import_clan
from app.db.connection import connect
from app.db.person import person_details
from app.db.tree import clan_tree
from app.gedcom.load import load_file, load_text
from conftest import CLANS, source


def test_order_matches_notes_in_all_clans() -> None:
    conn = connect(":memory:")
    checked = 0
    for name in CLANS:
        tree = clan_tree(conn, import_clan(conn, name, load_file(source(name))).clan_id)
        persons = {p.id: p for p in tree.persons}
        families = {f.id: f for f in tree.families}
        for person in tree.persons:
            if len(person.spouse_families) < 2:
                continue
            numbers = []
            for fid in person.spouse_families:
                family = families[fid]
                spouse = family.wife if family.husband == person.id else family.husband
                notes = [e.value for e in person_details(conn, persons[spouse].id).events if e.tag == "EVEN" and e.value]
                found = next((int(m.group(1)) for n in notes if (m := re.search(r"(\d)-(?:я жена|й муж)", n))), None)
                numbers.append(found)
            if all(n is not None for n in numbers):
                assert numbers == sorted(numbers), (name, person.given, numbers)
                checked += 1
    assert checked == 12  # у Родерика из Уинтерхоупа заметок об очереди нет


def gedcom(people: dict[str, tuple[int | None, int | None]], families: list[tuple[str, str, list[str]]]) -> str:
    """people: xref → (год рождения, год смерти); families: (муж, жена, дети) в порядке записи браков в файле."""
    lines = ["0 HEAD", "1 CHAR UTF-8"]
    for xref, (born, died) in people.items():
        lines += [f"0 @{xref}@ INDI", f"1 NAME {xref} /Проба/"]
        if born:
            lines += ["1 BIRT", f"2 DATE {born}"]
        if died:
            lines += ["1 DEAT", f"2 DATE {died}"]
        lines += [f"1 FAMS @F{i}@" for i, (h, w, _) in enumerate(families) if xref in (h, w)]
        lines += [f"1 FAMC @F{i}@" for i, (_, _, kids) in enumerate(families) if xref in kids]
    for i, (h, w, kids) in enumerate(families):
        lines += [f"0 @F{i}@ FAM", f"1 HUSB @{h}@", f"1 WIFE @{w}@", *[f"1 CHIL @{k}@" for k in kids]]
    return "\n".join([*lines, "0 TRLR"]) + "\n"


def wives(people, families) -> list[str]:
    conn = connect(":memory:")
    tree = clan_tree(conn, import_clan(conn, "Проба", load_text(gedcom(people, families))).clan_id)
    persons = {p.id: p for p in tree.persons}
    fams = {f.id: f for f in tree.families}
    man = next(p for p in tree.persons if p.xref == "@H@")
    return [persons[fams[f].wife].xref.strip("@") for f in man.spouse_families]


def test_childless_first_marriage_then_child_at_fifty() -> None:
    people = {"H": (1950, None), "W1": (1948, None), "W2": (1975, None), "K": (2000, None)}
    # в файле браки записаны наоборот
    assert wives(people, [("H", "W2", ["K"]), ("H", "W1", [])]) == ["W1", "W2"]


def test_widowhood_puts_childless_marriage_first_even_with_younger_spouse() -> None:
    # бездетная жена моложе второй, но умерла до рождения детей во втором браке
    people = {"H": (1900, None), "W1": (1915, 1930), "W2": (1905, None), "K": (1935, None)}
    assert wives(people, [("H", "W2", ["K"]), ("H", "W1", [])]) == ["W1", "W2"]


def test_divorce_is_not_caught_by_death_and_falls_to_spouse_birth() -> None:
    # бездетная жена пережила второй брак (развод) — сравниваются годы рождения жён: 1880 раньше 1905
    people = {"H": (1900, None), "W1": (1880, 1990), "W2": (1905, None), "K": (1935, None)}
    assert wives(people, [("H", "W2", ["K"]), ("H", "W1", [])]) == ["W1", "W2"]


def test_no_key_for_one_marriage_keeps_file_order() -> None:
    people = {"H": (1900, None), "W1": (None, None), "W2": (1905, None), "K": (1935, None)}
    assert wives(people, [("H", "W2", ["K"]), ("H", "W1", [])]) == ["W2", "W1"]


def test_childless_later_marriage_with_slightly_younger_spouse() -> None:
    # как у Тристрама из Уинтерхоупа: первая жена 1968 с ребёнком 1998, вторая 1974 без детей
    people = {"H": (1970, None), "W1": (1968, None), "W2": (1974, None), "K": (1998, None)}
    assert wives(people, [("H", "W2", []), ("H", "W1", ["K"])]) == ["W1", "W2"]
