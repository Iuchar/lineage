"""Дерево записей GEDCOM → общая модель рода.

Модель не зависит от формата: любой будущий преобразователь (CSV, GEDCOM X) должен выдавать
её же, и только она пишется в базу. Известные теги раскладываются по полям, запись целиком
остаётся при человеке или семье — для экспорта без потерь.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from app.gedcom.dates import GedDate, parse_date
from app.gedcom.records import Record

PERSON_EVENT_TAGS = {
    "BIRT", "CHR", "BAPM", "DEAT", "BURI", "CREM", "ADOP", "EVEN", "RESI", "OCCU", "TITL",
    "EDUC", "RELI", "NATI", "EMIG", "IMMI", "CENS", "PROB", "WILL", "GRAD", "RETI",
}
FAMILY_EVENT_TAGS = {"MARR", "DIV", "DIVF", "ENGG", "MARB", "MARC", "MARL", "MARS", "ANUL", "CENS", "EVEN"}

# заглушка «ветка уходит дальше» — не человек, а маркер продолжения
BRANCH_STUB_GIVEN = "Ветвь"


@dataclass
class Event:
    tag: str
    type: str | None
    value: str | None
    date: GedDate | None
    place: str | None


@dataclass
class ParentLink:
    family: str
    pedigree: str | None  # PEDI: birth, adopted, foster, sealing — как в файле


@dataclass
class Person:
    xref: str
    record: Record
    name_raw: str | None
    given: str | None
    surname: str | None
    married_surname: str | None
    sex: str | None
    uid: str | None
    events: list[Event] = field(default_factory=list)
    spouse_families: list[str] = field(default_factory=list)  # порядок FAMS — порядок браков
    parent_families: list[ParentLink] = field(default_factory=list)

    @property
    def is_branch_stub(self) -> bool:
        return self.given == BRANCH_STUB_GIVEN

    def event(self, tag: str) -> Event | None:
        return next((e for e in self.events if e.tag == tag), None)


@dataclass
class Family:
    xref: str
    record: Record
    uid: str | None
    husband: str | None
    wife: str | None
    children: list[str] = field(default_factory=list)
    events: list[Event] = field(default_factory=list)


@dataclass
class ClanData:
    header: Record | None
    persons: dict[str, Person]
    families: dict[str, Family]
    extras: list[Record]  # прочие записи верхнего уровня: NOTE, SOUR, OBJE, REPO, SUBM…
    warnings: list[str]


def _event(record: Record) -> Event:
    return Event(
        tag=record.tag,
        type=record.value_of("TYPE"),
        value=record.text() if record.value is not None else None,
        date=parse_date(record.value_of("DATE")),
        place=record.value_of("PLAC"),
    )


def _split_name(name: str | None) -> tuple[str | None, str | None]:
    """«Хэмиш /Монад Кройве/» → («Хэмиш», «Монад Кройве»)."""
    if not name:
        return None, None
    match = re.match(r"^(.*?)\s*/(.*?)/\s*(.*)$", name)
    if match is None:
        return name.strip() or None, None
    given = " ".join(part for part in (match.group(1), match.group(3)) if part).strip()
    return given or None, match.group(2).strip() or None


def _pointer(value: str | None) -> str | None:
    return value.strip() if value and value.strip().startswith("@") else None


def _person(record: Record) -> Person:
    name = record.first("NAME")
    given, surname = _split_name(name.value if name else None)
    if name is not None:
        given = name.value_of("GIVN") or given
        surname = name.value_of("SURN") or surname
    sex = record.value_of("SEX")
    return Person(
        xref=record.xref or "",
        record=record,
        name_raw=name.value if name else None,
        given=given,
        surname=surname,
        married_surname=name.value_of("_MARNM") if name else None,
        sex=sex if sex in ("M", "F", "U") else None,
        uid=record.value_of("_UID"),
        events=[_event(c) for c in record.children if c.tag in PERSON_EVENT_TAGS],
        spouse_families=[p for c in record.all("FAMS") if (p := _pointer(c.value))],
        parent_families=[
            ParentLink(family=p, pedigree=c.value_of("PEDI"))
            for c in record.all("FAMC") if (p := _pointer(c.value))
        ],
    )


def _family(record: Record) -> Family:
    return Family(
        xref=record.xref or "",
        record=record,
        uid=record.value_of("_UID"),
        husband=_pointer(record.value_of("HUSB")),
        wife=_pointer(record.value_of("WIFE")),
        children=[p for c in record.all("CHIL") if (p := _pointer(c.value))],
        events=[_event(c) for c in record.children if c.tag in FAMILY_EVENT_TAGS],
    )


def convert(records: list[Record]) -> ClanData:
    header: Record | None = None
    persons: dict[str, Person] = {}
    families: dict[str, Family] = {}
    extras: list[Record] = []
    warnings: list[str] = []

    for record in records:
        if record.tag == "HEAD":
            header = record
        elif record.tag == "TRLR":
            continue
        elif record.tag == "INDI" and record.xref:
            persons[record.xref] = _person(record)
        elif record.tag == "FAM" and record.xref:
            families[record.xref] = _family(record)
        else:
            extras.append(record)

    # висячие ссылки не роняют разбор: запоминаем и едем дальше
    for person in persons.values():
        for xref in person.spouse_families + [link.family for link in person.parent_families]:
            if xref not in families:
                warnings.append(f"{person.xref} ссылается на несуществующую семью {xref}")
    for family in families.values():
        for role, xref in (("муж", family.husband), ("жена", family.wife)):
            if xref and xref not in persons:
                warnings.append(f"{family.xref}: {role} {xref} не найден")
        for xref in family.children:
            if xref not in persons:
                warnings.append(f"{family.xref}: ребёнок {xref} не найден")

    return ClanData(header=header, persons=persons, families=families, extras=extras, warnings=warnings)
