"""Правка рода: поля человека, новый человек на нужном месте, удаление. Всё идёт через журнал.

Правка меняет запись GEDCOM так, как её поменяла бы другая программа: имя в NAME, пол в SEX, даты в DATE
у BIRT и DEAT, заметки — события EVEN с TYPE Comment, как в исходных файлах. Остальные теги записи
не трогаются — они уйдут в экспорт такими же, какими пришли.
"""

from __future__ import annotations

import json
import sqlite3
from typing import Literal

from pydantic import BaseModel

from app.db.journal import ChangeInfo, Edit, JournalError
from app.db.kin import DateValue, KinChanges, KinError, apply_kin, manual_order
from app.gedcom.convert import _person
from app.gedcom.dates import parse_date
from app.gedcom.meta import (DEFAULT_SEE_NOTE, SEE_NAMES, TAG_COLORS, PersonMeta, See, add_tag_def, read_meta,
                             read_note_see, write_meta, write_note_see)
from app.gedcom.records import Record
from app.gedcom.ru_dates import DateInputError, format_ru, parse_input

Sex = Literal["M", "F", "U"]
Pedigree = Literal["birth", "adopted", "foster"]


class NoteForm(BaseModel):
    """Заметка человека со своим уровнем видимости."""

    text: str
    see: See = DEFAULT_SEE_NOTE


class PersonForm(BaseModel):
    """Что показывает форма правки."""

    id: int
    clan_id: int
    given: str | None
    surname: str | None
    married_surname: str | None
    sex: Sex | None
    birth: DateValue
    death: DateValue
    notes: list[NoteForm]
    tags: list[str]
    burnt: bool
    see: See  # человек целиком
    see_dates: See
    see_portrait: See
    heir: bool
    portrait: Literal["auto", "silhouette", "none"]
    photo: str | None
    marriage_order_manual: bool = False  # очередь браков задана вручную, а не правилом


class PersonFields(BaseModel):
    """Что форма присылает. Даты — как набраны, по-русски или строкой GEDCOM."""

    given: str | None = None
    surname: str | None = None
    married_surname: str | None = None
    sex: Sex | None = None
    birth: str | None = None
    death: str | None = None
    notes: list[NoteForm] = []
    # служебное: метки (новые — с цветом), состояния, главная линия, портрет
    # не прислано (None) — остаётся как было: частичная форма ничего не стирает
    tags: list[str] | None = None
    new_tags: dict[str, str] = {}  # имя → цвет; метки, которых ещё нет в наборе рода
    burnt: bool | None = None
    see: See | None = None
    see_dates: See | None = None
    see_portrait: See | None = None
    heir: bool | None = None
    portrait: Literal["auto", "silhouette", "none"] | None = None
    kin: KinChanges | None = None  # правка родни — той же правкой журнала


class Relation(BaseModel):
    """Куда встаёт человек. kind: child, parent, spouse, sibling.

    child — к person_id; other_id — второй родитель (None — неизвестен), new_union — отдельный союз.
    parent — к person_id, роль по полу нового человека; separate — отдельной семьёй (родные при приёмных).
    spouse — новый союз с person_id.
    sibling — к person_id; parents: both, father, mother.
    """

    kind: Literal["child", "parent", "spouse", "sibling"]
    person_id: int
    other_id: int | None = None
    parents: Literal["both", "father", "mother"] = "both"
    pedigree: Pedigree = "birth"
    separate: bool = False


class NewPerson(BaseModel):
    fields: PersonFields = PersonFields()
    relation: Relation
    existing_id: int | None = None  # «выбрать уже записанного»: не создавать, а привязать


class Created(BaseModel):
    person_id: int
    change: ChangeInfo


class DeletePreview(BaseModel):
    name: str
    children: int
    descendants: int  # потомки без пометок «Ветвь»
    inlaws: int  # их супруги, пришедшие в род через брак
    stubs: int
    branch_total: int  # всё, что уйдёт вместе с веткой, включая самого человека


class EditError(ValueError):
    pass


# ── записи GEDCOM: мелкие правки ──

def _set_child(record: Record, tag: str, value: str | None) -> None:
    """Задать или убрать единственный подтег."""
    child = record.first(tag)
    if value in (None, ""):
        if child is not None:
            record.children.remove(child)
        return
    if child is None:
        record.children.append(Record(level=record.level + 1, tag=tag, value=value))
    else:
        child.value = value


def _text_record(level: int, tag: str, text: str) -> Record:
    """Многострочное значение по стандарту: первая строка в значении, остальные — CONT."""
    lines = text.split("\n")
    record = Record(level=level, tag=tag, value=lines[0])
    record.children = [Record(level=level + 1, tag="CONT", value=line) for line in lines[1:]]
    return record


def _date(text: str | None, label: str) -> str | None:
    try:
        return parse_input(text).gedcom
    except DateInputError as error:
        raise EditError(f"{label}: {error}") from None


def _set_event_date(record: Record, tag: str, gedcom: str | None) -> None:
    event = record.first(tag)
    if gedcom is None:
        if event is None:
            return
        _set_child(event, "DATE", None)
        # событие без даты и без всего прочего — пустая строка в файле, убираем
        if not event.children and event.value in (None, "", "Y"):
            record.children.remove(event)
        return
    if event is None:
        event = Record(level=1, tag=tag)
        # рождение ставится перед смертью, обе — сразу после имени и пола, как пишут программы
        anchor = max((i for i, c in enumerate(record.children) if c.tag in ("NAME", "SEX", "BIRT")), default=-1)
        record.children.insert(anchor + 1, event)
    _set_child(event, "DATE", gedcom)


def _notes(record: Record) -> list[Record]:
    return [c for c in record.children if c.tag == "EVEN" and c.value_of("TYPE") == "Comment"]


def _apply_fields(record: Record, fields: PersonFields) -> None:
    given = (fields.given or "").strip()
    surname = (fields.surname or "").strip()
    name = record.first("NAME")
    value = f"{given} /{surname}/".strip() if surname else given
    if name is None:
        name = Record(level=1, tag="NAME", value=value)
        record.children.insert(0, name)
    else:
        name.value = value
    if name.first("GIVN") is not None or name.first("SURN") is not None:
        _set_child(name, "GIVN", given or None)
        _set_child(name, "SURN", surname or None)
    _set_child(name, "_MARNM", (fields.married_surname or "").strip() or None)
    _set_child(record, "SEX", fields.sex)
    if record.first("SEX") is not None:  # пол — сразу после имени
        sex = record.first("SEX")
        record.children.remove(sex)  # type: ignore[arg-type]
        record.children.insert(record.children.index(name) + 1, sex)  # type: ignore[arg-type]
    _set_event_date(record, "BIRT", _date(fields.birth, "Рождение"))
    _set_event_date(record, "DEAT", _date(fields.death, "Смерть"))

    was = read_meta(record)
    write_meta(record, PersonMeta(
        tags=was.tags if fields.tags is None else fields.tags,
        burnt=was.burnt if fields.burnt is None else fields.burnt,
        see=was.see if fields.see is None else fields.see,
        see_dates=was.see_dates if fields.see_dates is None else fields.see_dates,
        see_portrait=was.see_portrait if fields.see_portrait is None else fields.see_portrait,
        heir=was.heir if fields.heir is None else fields.heir,
        portrait=was.portrait if fields.portrait is None else fields.portrait,
        photo=was.photo,
    ))

    old = _notes(record)
    fresh_notes = [n for n in fields.notes if n.text.strip()]
    for note, want in zip(old, fresh_notes, strict=False):
        keep = [c for c in note.children if c.tag not in ("CONT", "CONC")]
        made = _text_record(1, "EVEN", want.text.strip())
        note.value, note.children = made.value, made.children + keep
        write_note_see(note, want.see)
    for note in old[len(fresh_notes):]:
        record.children.remove(note)
    for want in fresh_notes[len(old):]:
        note = _text_record(1, "EVEN", want.text.strip())
        note.children.append(Record(level=2, tag="TYPE", value="Comment"))
        write_note_see(note, want.see)
        record.children.append(note)


def _name(record: Record) -> str:
    person = _person(record)
    return " ".join(p for p in (person.given, person.surname) if p) or "без имени"


def _first_name(record: Record) -> str:
    return _person(record).given or "без имени"


def _date_ru(record: Record, tag: str) -> str:
    event = record.first(tag)
    parsed = parse_date(event.value_of("DATE")) if event else None
    return format_ru(parsed) if parsed else "—"


def _clan(conn: sqlite3.Connection, person_id: int) -> int:
    row = conn.execute("SELECT clan_id FROM persons WHERE id = ?", (person_id,)).fetchone()
    if row is None:
        raise EditError("Такого человека нет")
    return row[0]


def _raw(conn: sqlite3.Connection, person_id: int) -> Record:
    return Record.from_json(json.loads(conn.execute("SELECT raw FROM persons WHERE id = ?", (person_id,)).fetchone()[0]))


# ── форма ──

def date_value(raw: str | None) -> DateValue:
    """Дата для поля формы: по-русски, если это читается обратно в ту же дату, иначе строка GEDCOM."""
    parsed = parse_date(raw)
    ru = format_ru(parsed) if parsed else ""
    try:
        back = parse_input(ru).gedcom if ru else None
    except DateInputError:
        back = None
    return DateValue(gedcom=raw, ru=ru, input=ru if back == raw else (raw or ""))


def _date_ru_value(event: Record | None) -> str:
    parsed = parse_date(event.value_of("DATE")) if event else None
    return format_ru(parsed) if parsed else "—"


def person_form(conn: sqlite3.Connection, person_id: int) -> PersonForm:
    clan_id = _clan(conn, person_id)
    record = _raw(conn, person_id)
    person = _person(record)
    meta = read_meta(record)

    def date(tag: str) -> DateValue:
        event = record.first(tag)
        return date_value(event.value_of("DATE") if event else None)

    return PersonForm(
        id=person_id, clan_id=clan_id, given=person.given, surname=person.surname,
        married_surname=person.married_surname, sex=person.sex,  # type: ignore[arg-type]
        birth=date("BIRT"), death=date("DEAT"),
        notes=[NoteForm(text=n.text(), see=read_note_see(n)) for n in _notes(record)],
        tags=meta.tags, burnt=meta.burnt, see=meta.see, see_dates=meta.see_dates,
        see_portrait=meta.see_portrait, heir=meta.heir, portrait=meta.portrait,
        photo=f"/api/{meta.photo}" if meta.photo else None, marriage_order_manual=manual_order(record),
    )


def update_person(conn: sqlite3.Connection, person_id: int, fields: PersonFields) -> ChangeInfo:
    edit = Edit(conn, _clan(conn, person_id))
    record = edit.person(person_id)
    before = Record.from_json(record.to_json())
    _apply_fields(record, fields)
    _new_tags(edit, fields)
    try:
        kin = apply_kin(edit, conn, person_id, fields.kin) if fields.kin else []
    except KinError as error:
        raise EditError(str(error)) from None
    edit.summary = _describe(before, record, kin)
    try:
        return edit.commit()
    except JournalError as error:
        raise EditError(str(error)) from None


def _new_tags(edit: Edit, fields: PersonFields) -> None:
    """Новые метки попадают в набор рода — в заголовок файла, той же правкой."""
    for name, color in fields.new_tags.items():
        if name.strip() and name in (fields.tags or []):
            add_tag_def(edit.header(), name.strip(), color if color in TAG_COLORS else TAG_COLORS[0])


def _describe(before: Record, after: Record, extra: list[str] | None = None) -> str:
    """«Мурдо: рождение 1748 → около 1748»; несколько полей — перечислением."""
    was, now = _person(before), _person(after)
    parts = []
    if (was.given, was.surname) != (now.given, now.surname):
        parts.append(f"имя {_name(before)} → {_name(after)}")
    if was.married_surname != now.married_surname:
        parts.append("фамилия по мужу")
    if was.sex != now.sex:
        parts.append("пол")
    for tag, label in (("BIRT", "рождение"), ("DEAT", "смерть")):
        if _date_ru(before, tag) != _date_ru(after, tag):
            parts.append(f"{label} {_date_ru(before, tag)} → {_date_ru(after, tag)}")
    if [(n.text(), read_note_see(n)) for n in _notes(before)] != [(n.text(), read_note_see(n)) for n in _notes(after)]:
        parts.append("заметки")
    mb, ma = read_meta(before), read_meta(after)
    for tag in ma.tags:
        if tag not in mb.tags:
            parts.append(f"метка «{tag}»")
    for tag in mb.tags:
        if tag not in ma.tags:
            parts.append(f"снята метка «{tag}»")
    for flag, on, off in (("burnt", "выжжен из рода", "снова в роду"),
                          ("heir", "продолжатель линии", "не продолжатель линии")):
        if getattr(mb, flag) != getattr(ma, flag):
            parts.append(on if getattr(ma, flag) else off)
    for level, what in (("see", "человек"), ("see_dates", "даты жизни"), ("see_portrait", "портрет")):
        if getattr(mb, level) != getattr(ma, level):
            parts.append(f"{what}: {SEE_NAMES[getattr(ma, level)]}")
    if mb.portrait != ma.portrait:
        parts.append({"auto": "портрет включён", "silhouette": "портрет — заглушка", "none": "портрет выключен"}[ma.portrait])
    parts += extra or []
    return f"{_first_name(after)}: {', '.join(parts) or 'правка'}"


# ── новый человек на нужном месте ──

def _link(record: Record, tag: str, pointer: str, pedigree: str | None = None) -> None:
    if any(c.value == pointer for c in record.all(tag)):
        return
    link = Record(level=1, tag=tag, value=pointer)
    if pedigree and pedigree != "birth":
        link.children.append(Record(level=2, tag="PEDI", value=pedigree))
    record.children.append(link)


def _families_of(conn: sqlite3.Connection, person_id: int, role: str) -> list[int]:
    if role == "spouse":
        return [r[0] for r in conn.execute(
            "SELECT family_id FROM spouse_families WHERE person_id = ? ORDER BY position", (person_id,))]
    return [r[0] for r in conn.execute("SELECT family_id FROM family_children WHERE person_id = ?", (person_id,))]


def _slot(sex: str | None, fallback: str = "HUSB") -> str:
    return "WIFE" if sex == "F" else "HUSB" if sex == "M" else fallback


def _union(edit: Edit, conn: sqlite3.Connection, a: int, b: int | None) -> int:
    """Семья, где a и b — пара (b=None — a один, без второго родителя). Нет такой — завести новую."""
    for family_id in _families_of(conn, a, "spouse"):
        row = conn.execute("SELECT husband_id, wife_id FROM families WHERE id = ?", (family_id,)).fetchone()
        members = {row[0], row[1]} - {None}
        if members == ({a, b} - {None}):
            return family_id
    family_id, family = edit.new_family()
    for pid in [a, b]:
        if pid is None:
            continue
        person = edit.person(pid)
        other_sex = _person(edit.person(a if pid == b else b)).sex if b is not None else None
        slot = _slot(_person(person).sex, "WIFE" if other_sex == "M" else "HUSB")
        if family.first(slot) is not None:
            slot = "WIFE" if slot == "HUSB" else "HUSB"
        family.children.append(Record(level=1, tag=slot, value=edit.xref_of("INDI", pid)))
        _link(person, "FAMS", family.xref or "")
    return family_id


def _add_child(edit: Edit, family_id: int, child_id: int, pedigree: str) -> None:
    family = edit.family(family_id)
    pointer = edit.xref_of("INDI", child_id)
    if not any(c.value == pointer for c in family.all("CHIL")):
        family.children.append(Record(level=1, tag="CHIL", value=pointer))
    _link(edit.person(child_id), "FAMC", family.xref or "", pedigree)


def add_person(conn: sqlite3.Connection, clan_id: int, body: NewPerson) -> Created:
    relation = body.relation
    if _clan(conn, relation.person_id) != clan_id:
        raise EditError("Человек из другого рода")
    edit = Edit(conn, clan_id)
    if body.existing_id is not None:
        if _clan(conn, body.existing_id) != clan_id:
            raise EditError("Привязать можно только человека этого рода")
        if body.existing_id == relation.person_id:
            raise EditError("Человек не может быть родственником самому себе")
        new_id = body.existing_id
        record = edit.person(new_id)
    else:
        new_id, record = edit.new_person()
        _apply_fields(record, body.fields)
        _new_tags(edit, body.fields)
    anchor = edit.person(relation.person_id)
    who, anchor_name = _name(record), _first_name(anchor)

    if relation.kind == "child":
        family_id = _union(edit, conn, relation.person_id, relation.other_id)
        _add_child(edit, family_id, new_id, relation.pedigree)
        word = {"M": "сын", "F": "дочь"}.get(_person(record).sex or "", "ребёнок")
        edit.summary = f"{anchor_name}: {word} — {who}"
    elif relation.kind == "spouse":
        _union(edit, conn, relation.person_id, new_id)
        edit.summary = f"{anchor_name}: новый союз — {who}"
    elif relation.kind == "parent":
        families = [] if relation.separate else _families_of(conn, relation.person_id, "child")
        slot = _slot(_person(record).sex)
        if families:
            family = edit.family(families[0])
            if family.first(slot) is not None:
                taken = "отец" if slot == "HUSB" else "мать"
                raise EditError(f"У {anchor_name} {taken} уже записан")
            family.children.insert(0, Record(level=1, tag=slot, value=edit.xref_of("INDI", new_id)))
            _link(record, "FAMS", family.xref or "")
        else:
            family_id, family = edit.new_family()
            family.children.append(Record(level=1, tag=slot, value=edit.xref_of("INDI", new_id)))
            _link(record, "FAMS", family.xref or "")
            _add_child(edit, family_id, relation.person_id, relation.pedigree)
        edit.summary = f"{anchor_name}: {'отец' if slot == 'HUSB' else 'мать'} — {who}"
    else:  # sibling
        families = _families_of(conn, relation.person_id, "child")
        if not families:
            if relation.parents != "both":
                raise EditError(f"У {anchor_name} не записаны родители")
            family_id, _ = edit.new_family()
            _add_child(edit, family_id, relation.person_id, "birth")
            families = [family_id]
            row = (None, None)
        else:
            row = conn.execute("SELECT husband_id, wife_id FROM families WHERE id = ?", (families[0],)).fetchone()
        if relation.parents == "both":
            family_id = families[0]
        else:
            parent = row[0] if relation.parents == "father" else row[1]
            if parent is None:
                raise EditError(f"У {anchor_name} {'отец' if relation.parents == 'father' else 'мать'} не записан(а)")
            family_id = _union(edit, conn, parent, None)
        _add_child(edit, family_id, new_id, relation.pedigree)
        word = {"M": "брат", "F": "сестра"}.get(_person(record).sex or "", "брат или сестра")
        edit.summary = f"{anchor_name}: {word} — {who}"
    edit.persons.add(relation.person_id)
    try:
        return Created(person_id=new_id, change=edit.commit())
    except JournalError as error:
        raise EditError(str(error)) from None


# ── удаление ──

def _branch(conn: sqlite3.Connection, person_id: int) -> tuple[set[int], set[int], set[int]]:
    """Потомки, их пришлые супруги и пометки «Ветвь» — всё, что уходит вместе с веткой."""
    descendants: set[int] = set()
    stack = [person_id]
    while stack:
        pid = stack.pop()
        for family_id in _families_of(conn, pid, "spouse"):
            for (child,) in conn.execute("SELECT person_id FROM family_children WHERE family_id = ?", (family_id,)):
                if child not in descendants:
                    descendants.add(child)
                    stack.append(child)
    stubs = {pid for pid in descendants
             if conn.execute("SELECT is_branch_stub FROM persons WHERE id = ?", (pid,)).fetchone()[0]}
    inlaws: set[int] = set()
    for pid in descendants:
        for family_id in _families_of(conn, pid, "spouse"):
            row = conn.execute("SELECT husband_id, wife_id FROM families WHERE id = ?", (family_id,)).fetchone()
            for spouse in (row[0], row[1]):
                if spouse is not None and spouse not in descendants and spouse != person_id \
                        and not _families_of(conn, spouse, "child"):
                    inlaws.add(spouse)
    return descendants, inlaws, stubs


def delete_preview(conn: sqlite3.Connection, person_id: int) -> DeletePreview:
    _clan(conn, person_id)
    descendants, inlaws, stubs = _branch(conn, person_id)
    children = sum(len([1 for _ in conn.execute("SELECT 1 FROM family_children WHERE family_id = ?", (f,))])
                   for f in _families_of(conn, person_id, "spouse"))
    return DeletePreview(name=_name(_raw(conn, person_id)), children=children,
                         descendants=len(descendants - stubs), inlaws=len(inlaws), stubs=len(stubs),
                         branch_total=1 + len(descendants) + len(inlaws))


def delete_person(conn: sqlite3.Connection, person_id: int, branch: bool = False) -> ChangeInfo:
    clan_id = _clan(conn, person_id)
    edit = Edit(conn, clan_id)
    gone = {person_id}
    if branch:
        descendants, inlaws, _ = _branch(conn, person_id)
        gone |= descendants | inlaws
    name = _name(edit.person(person_id))
    # связки с другими родами уходят вместе с людьми — журнал их запомнит, откат вернёт
    for pid in gone:
        edit.links += [dict(r) for r in conn.execute(
            "SELECT * FROM person_links WHERE a_person_id = ? OR b_person_id = ?", (pid, pid))]
    families = {f for pid in gone for f in _families_of(conn, pid, "spouse") + _families_of(conn, pid, "child")}
    for family_id in families:
        family = edit.family(family_id)
        pointers = {edit.xref_of("INDI", pid) for pid in gone}
        family.children = [c for c in family.children if not (c.tag in ("HUSB", "WIFE", "CHIL") and c.value in pointers)]
        members = [c for c in family.children if c.tag in ("HUSB", "WIFE", "CHIL")]
        # семья, где остался один супруг без детей, смысла не имеет — уходит, у супруга снимается ссылка
        if len(members) <= 1 and not family.all("CHIL"):
            for member in members:
                other = conn.execute("SELECT id FROM persons WHERE clan_id = ? AND xref = ?",
                                     (clan_id, member.value)).fetchone()
                if other and other[0] not in gone:
                    survivor = edit.person(other[0])
                    survivor.children = [c for c in survivor.children
                                         if not (c.tag in ("FAMS", "FAMC") and c.value == family.xref)]
            edit.drop("FAM", family_id)
    for pid in gone:
        edit.person(pid)
        edit.drop("INDI", pid)
    edit.summary = f"Удаление: {name}" + (f" вместе с веткой, ещё {len(gone) - 1}" if branch and len(gone) > 1 else "")
    try:
        return edit.commit()
    except JournalError as error:
        raise EditError(str(error)) from None
