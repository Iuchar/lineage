"""Новый род с нуля: имя рода и первый человек.

Род собирается тем же путём, что и загруженный файл: из набранного складывается самый малый GEDCOM
и уходит в общую загрузку. Отдельного способа создания нет — значит, нет и отдельных ошибок.
"""

from __future__ import annotations

import sqlite3
from typing import Literal

from pydantic import BaseModel

from app.db.clans import import_clan
from app.gedcom.load import load_text
from app.gedcom.meta import DEFAULT_STATUS, STATUS_NAMES
from app.gedcom.ru_dates import DateInputError, parse_input


class FirstPerson(BaseModel):
    given: str = ""
    surname: str = ""
    sex: Literal["M", "F", "U"] = "U"
    birth: str = ""  # как набрано: «1748», «около 1750», «12 марта 1748»


class ClanStart(BaseModel):
    name: str
    status: str = DEFAULT_STATUS
    person: FirstPerson


class NewClanError(ValueError):
    """Причина по-русски — её видит человек в окне."""


def _line(value: str) -> str:
    # набранное идёт в строку GEDCOM: перевод строки начал бы новую запись, косая черта сломала бы имя
    return " ".join(value.replace("/", " ").split())


def start_clan(conn: sqlite3.Connection, start: ClanStart) -> int:
    """Создать род из одного человека и вернуть его номер."""
    name = _line(start.name)
    if not name:
        raise NewClanError("У рода должно быть имя.")
    if start.status not in STATUS_NAMES:
        raise NewClanError("Такого титула нет.")
    given = _line(start.person.given)
    surname = _line(start.person.surname)
    if not given and not surname:
        raise NewClanError("У первого человека нужно имя или фамилия.")
    try:
        birth = parse_input(start.person.birth).gedcom
    except DateInputError as error:
        raise NewClanError(f"Год рождения: {error}") from None

    lines = ["0 HEAD", "1 GEDC", "2 VERS 5.5.1", "2 FORM LINEAGE-LINKED", "1 CHAR UTF-8"]
    if start.status != DEFAULT_STATUS:
        lines.append(f"1 _STATUS {start.status}")
    lines.append("0 @I1@ INDI")
    lines.append(f"1 NAME {given} /{surname}/".rstrip() if surname else f"1 NAME {given}")
    if given:
        lines.append(f"2 GIVN {given}")
    if surname:
        lines.append(f"2 SURN {surname}")
    if start.person.sex != "U":
        lines.append(f"1 SEX {start.person.sex}")
    if birth:
        lines += ["1 BIRT", f"2 DATE {birth}"]
    lines.append("0 TRLR")

    report = import_clan(conn, name, load_text("\n".join(lines) + "\n"))
    return report.clan_id
