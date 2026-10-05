"""Дата, набранная по-русски, → строка даты GEDCOM, и обратно — показ по-русски.

Пишут как говорят: «около 1750», «до 1800», «между 1740 и 1745», «12 мар 1748». Неточное остаётся
неточным, ничего не додумывается. Непонятное не превращается в дату — вызывающий получает причину.
Строку GEDCOM («ABT 1750») тоже можно вписать как есть.
"""

from __future__ import annotations

import calendar
import re
from dataclasses import dataclass

from app.gedcom.dates import GedDate, parse_date

_MONTHS = [
    ("JAN", ("янв",)), ("FEB", ("фев",)), ("MAR", ("мар",)), ("APR", ("апр",)), ("MAY", ("мая", "май")),
    ("JUN", ("июн",)), ("JUL", ("июл",)), ("AUG", ("авг",)), ("SEP", ("сен",)), ("OCT", ("окт",)),
    ("NOV", ("ноя",)), ("DEC", ("дек",)),
]
_GENITIVE = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября",
             "ноября", "декабря"]
_NOMINATIVE = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь",
               "ноябрь", "декабрь"]
_ABOUT = ("около", "ок", "прим", "примерно", "приблизительно", "~")


class DateInputError(ValueError):
    pass


@dataclass(frozen=True)
class ParsedInput:
    gedcom: str | None  # None — поле пустое, даты нет
    ru: str  # как поняли, по-русски
    kind: str


def _month(word: str) -> str | None:
    word = word.lower().rstrip(".")
    for code, stems in _MONTHS:
        if any(word.startswith(stem) for stem in stems):
            return code
    return None


def _point(text: str) -> str:
    """«12 мар 1748», «март 1748», «1748», «12.03.1748» → точка GEDCOM; иначе ошибка с причиной."""
    text = text.strip().strip(",")
    numeric = re.fullmatch(r"(\d{1,2})\.(\d{1,2})\.(\d{1,4})", text)
    if numeric:
        day, month, year = (int(g) for g in numeric.groups())
        if not 1 <= month <= 12:
            raise DateInputError(f"месяца {month} не бывает")
        return _checked(day, _MONTHS[month - 1][0], year)
    parts = text.split()
    if len(parts) == 1 and re.fullmatch(r"\d{1,4}", parts[0]):
        return str(int(parts[0]))
    if len(parts) == 2 and re.fullmatch(r"\d{1,4}", parts[1]):
        code = _month(parts[0])
        if code is None:
            raise DateInputError(f"не понял месяц «{parts[0]}»")
        return f"{code} {int(parts[1])}"
    if len(parts) == 3 and re.fullmatch(r"\d{1,2}", parts[0]) and re.fullmatch(r"\d{1,4}", parts[2]):
        code = _month(parts[1])
        if code is None:
            raise DateInputError(f"не понял месяц «{parts[1]}»")
        return _checked(int(parts[0]), code, int(parts[2]))
    raise DateInputError("не похоже на дату")


_IN_MONTH = ["январе", "феврале", "марте", "апреле", "мае", "июне", "июле", "августе", "сентябре", "октябре",
             "ноябре", "декабре"]


def _checked(day: int, code: str, year: int) -> str:
    month = [c for c, _ in _MONTHS].index(code) + 1
    # високосность — по григорианскому календарю, как в самих файлах
    days = calendar.monthrange(max(year, 1), month)[1]
    if not 1 <= day <= days:
        where = f"в феврале {year} года" if month == 2 else f"в {_IN_MONTH[month - 1]}"
        raise DateInputError(f"{where} {days} {'день' if days == 31 else 'дней'}")
    return f"{day} {code} {year}"


def parse_input(text: str | None) -> ParsedInput:
    """Разобрать набранное. Пустое — даты нет. Ошибка — DateInputError с причиной по-русски."""
    if text is None or not text.strip():
        return ParsedInput(gedcom=None, ru="не указана", kind="empty")
    raw = " ".join(text.strip().split())
    low = raw.lower()

    # строка GEDCOM как есть — её и сохраняем, если она разбирается
    if re.fullmatch(r"[A-Z0-9 .()/]+", raw):
        parsed = parse_date(raw)
        if parsed and parsed.kind != "unparsed":
            return ParsedInput(gedcom=raw, ru=format_ru(parsed), kind=parsed.kind)

    between = re.fullmatch(r"(?:между\s+)?(.+?)\s*(?:\s+и\s+|\s*[-–—]\s*)(.+)", low)
    if between and (low.startswith("между") or re.fullmatch(r"\d{1,4}\s*[-–—]\s*\d{1,4}", low)):
        left, right = _point(between.group(1)), _point(between.group(2))
        return _done(f"BET {left} AND {right}")
    period = re.fullmatch(r"с\s+(.+?)\s+по\s+(.+)", low)
    if period:
        return _done(f"FROM {_point(period.group(1))} TO {_point(period.group(2))}")
    for words, code in ((_ABOUT, "ABT"), (("до",), "BEF"), (("после",), "AFT")):
        for word in words:
            match = re.fullmatch(rf"{re.escape(word)}\.?\s*(.+)", low)
            if match and (word == "~" or low.startswith((word + " ", word + "."))):
                return _done(f"{code} {_point(match.group(1))}")
    return _done(_point(low))


def _done(gedcom: str) -> ParsedInput:
    parsed = parse_date(gedcom)
    assert parsed is not None and parsed.kind != "unparsed", gedcom
    return ParsedInput(gedcom=gedcom, ru=format_ru(parsed), kind=parsed.kind)


def _ru_point(point: object) -> str:
    year, month, day = point.year, point.month, point.day  # type: ignore[attr-defined]
    if day and month:
        return f"{day} {_GENITIVE[month - 1]} {year}"
    if month:
        return f"{_NOMINATIVE[month - 1]} {year}"
    return str(year)


def format_ru(date: GedDate) -> str:
    start = _ru_point(date.start) if date.start else ""
    end = _ru_point(date.end) if date.end else ""
    return {
        "exact": start, "about": f"около {start}", "calculated": f"вычислено: {start}", "estimated": f"оценка: {start}",
        "before": f"до {start}", "after": f"после {start}", "between": f"между {start} и {end}",
        "from": f"с {start}", "to": f"по {end}", "period": f"с {start} по {end}",
        "interpreted": f"{start} ({date.phrase})", "phrase": date.phrase or date.raw,
    }.get(date.kind, date.raw)
