"""Подробности о человеке для панели: события и заметки, события его браков."""

from __future__ import annotations

import sqlite3

from pydantic import BaseModel

from app.db.tree import LifeDate


class PersonEvent(BaseModel):
    tag: str
    type: str | None
    value: str | None
    date: LifeDate | None
    place: str | None


class MarriageDetails(BaseModel):
    family_id: int
    events: list[PersonEvent]


class PersonDetails(BaseModel):
    id: int
    clan_id: int
    xref: str
    name_raw: str | None
    events: list[PersonEvent]  # в порядке файла
    marriages: list[MarriageDetails]  # в порядке браков


class PersonNotFoundError(LookupError):
    pass


_EVENT_COLUMNS = """e.tag, e.type, e.value, e.date_raw, e.date_kind, e.date_year, e.date_month, e.date_day,
                    e.date_end_year, e.date_end_month, e.date_end_day, e.date_phrase, pl.name AS place"""


def _event(row: sqlite3.Row) -> PersonEvent:
    date = None
    if row["date_raw"] is not None:
        date = LifeDate(
            raw=row["date_raw"], kind=row["date_kind"],
            year=row["date_year"], month=row["date_month"], day=row["date_day"],
            end_year=row["date_end_year"], end_month=row["date_end_month"], end_day=row["date_end_day"],
            phrase=row["date_phrase"],
        )
    return PersonEvent(tag=row["tag"], type=row["type"], value=row["value"], date=date, place=row["place"])


def person_details(conn: sqlite3.Connection, person_id: int) -> PersonDetails:
    person = conn.execute("SELECT id, clan_id, xref, name_raw FROM persons WHERE id = ?", (person_id,)).fetchone()
    if person is None:
        raise PersonNotFoundError(person_id)

    events = [
        _event(row)
        for row in conn.execute(
            f"""SELECT {_EVENT_COLUMNS} FROM events e LEFT JOIN places pl ON pl.id = e.place_id
                 WHERE e.person_id = ? ORDER BY e.position""",
            (person_id,),
        )
    ]
    marriages = []
    for family in conn.execute(
        "SELECT family_id FROM spouse_families WHERE person_id = ? ORDER BY position", (person_id,)
    ):
        marriages.append(
            MarriageDetails(
                family_id=family["family_id"],
                events=[
                    _event(row)
                    for row in conn.execute(
                        f"""SELECT {_EVENT_COLUMNS} FROM events e LEFT JOIN places pl ON pl.id = e.place_id
                             WHERE e.family_id = ? ORDER BY e.position""",
                        (family["family_id"],),
                    )
                ],
            )
        )
    return PersonDetails(
        id=person["id"], clan_id=person["clan_id"], xref=person["xref"], name_raw=person["name_raw"],
        events=events, marriages=marriages,
    )
