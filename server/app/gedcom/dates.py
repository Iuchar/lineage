"""Даты GEDCOM во всех точностях: полная, месяц с годом, год, около, до, после, между, период.

Неточное остаётся неточным: разбор ничего не додумывает, а всё, что не распознано,
сохраняется исходной строкой.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

MONTHS = {
    "JAN": 1, "FEB": 2, "MAR": 3, "APR": 4, "MAY": 5, "JUN": 6,
    "JUL": 7, "AUG": 8, "SEP": 9, "OCT": 10, "NOV": 11, "DEC": 12,
}

_POINT = re.compile(r"^(?:(\d{1,2}) )?(?:([A-Z]{3}) )?(\d{1,4})(?:/\d{1,2})?( B\.C\.)?$")
_SINGLE = {"ABT": "about", "CAL": "calculated", "EST": "estimated", "BEF": "before", "AFT": "after"}


@dataclass(frozen=True)
class DatePoint:
    year: int
    month: int | None = None
    day: int | None = None


@dataclass(frozen=True)
class GedDate:
    raw: str
    # exact, about, calculated, estimated, before, after, between, from, to, period,
    # interpreted, phrase, unparsed
    kind: str
    start: DatePoint | None = None
    end: DatePoint | None = None
    phrase: str | None = None

    @property
    def sort_year(self) -> int | None:
        point = self.start or self.end
        return point.year if point else None


def _point(text: str) -> DatePoint | None:
    match = _POINT.match(text.strip())
    if match is None:
        return None
    day, month_name, year, bc = match.groups()
    month = MONTHS.get(month_name) if month_name else None
    if month_name and month is None:
        return None
    if day and month is None:
        return None
    if day and not 1 <= int(day) <= 31:
        return None
    value = int(year)
    return DatePoint(year=-value if bc else value, month=month, day=int(day) if day else None)


def parse_date(raw: str | None) -> GedDate | None:
    if raw is None or not raw.strip():
        return None
    text = " ".join(raw.strip().split()).upper()

    def unparsed() -> GedDate:
        return GedDate(raw=raw, kind="unparsed")

    if text.startswith("(") and text.endswith(")"):
        return GedDate(raw=raw, kind="phrase", phrase=raw.strip()[1:-1])

    if text.startswith("INT "):
        match = re.match(r"^INT (.+?) \((.*)\)$", raw.strip(), flags=re.IGNORECASE)
        point = _point(match.group(1).upper()) if match else None
        if point is None or match is None:
            return unparsed()
        return GedDate(raw=raw, kind="interpreted", start=point, phrase=match.group(2))

    if text.startswith("BET "):
        left, sep, right = text[4:].partition(" AND ")
        start, end = _point(left), _point(right)
        return GedDate(raw=raw, kind="between", start=start, end=end) if sep and start and end else unparsed()

    if text.startswith("FROM "):
        left, sep, right = text[5:].partition(" TO ")
        start = _point(left)
        if start is None:
            return unparsed()
        if not sep:
            return GedDate(raw=raw, kind="from", start=start)
        end = _point(right)
        return GedDate(raw=raw, kind="period", start=start, end=end) if end else unparsed()

    if text.startswith("TO "):
        end = _point(text[3:])
        return GedDate(raw=raw, kind="to", end=end) if end else unparsed()

    keyword, _, rest = text.partition(" ")
    if keyword in _SINGLE:
        point = _point(rest)
        return GedDate(raw=raw, kind=_SINGLE[keyword], start=point) if point else unparsed()

    point = _point(text)
    return GedDate(raw=raw, kind="exact", start=point) if point else unparsed()
