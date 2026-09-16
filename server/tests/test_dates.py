import pytest

from app.gedcom.dates import DatePoint, parse_date


@pytest.mark.parametrize(
    ("raw", "kind", "start", "end"),
    [
        ("12 MAR 1748", "exact", DatePoint(1748, 3, 12), None),
        ("MAR 1748", "exact", DatePoint(1748, 3), None),
        ("1748", "exact", DatePoint(1748), None),
        ("ABT 1748", "about", DatePoint(1748), None),
        ("CAL 1748", "calculated", DatePoint(1748), None),
        ("EST 1748", "estimated", DatePoint(1748), None),
        ("BEF 1748", "before", DatePoint(1748), None),
        ("AFT 2 FEB 1748", "after", DatePoint(1748, 2, 2), None),
        ("BET 1740 AND 1750", "between", DatePoint(1740), DatePoint(1750), ),
        ("FROM 1740 TO MAY 1750", "period", DatePoint(1740), DatePoint(1750, 5)),
        ("FROM 1740", "from", DatePoint(1740), None),
        ("TO 1750", "to", None, DatePoint(1750)),
        ("abt 1748", "about", DatePoint(1748), None),
        ("1748/49", "exact", DatePoint(1748), None),
        ("44 B.C.", "exact", DatePoint(-44), None),
    ],
)
def test_all_precisions(raw: str, kind: str, start: DatePoint | None, end: DatePoint | None) -> None:
    date = parse_date(raw)
    assert date is not None
    assert (date.kind, date.start, date.end, date.raw) == (kind, start, end, raw)


def test_empty_is_no_date() -> None:
    assert parse_date(None) is None
    assert parse_date("   ") is None


@pytest.mark.parametrize("raw", ["весной 1748", "32 MAR 1748", "MRZ 1748", "BET 1740", "12 1748"])
def test_unrecognised_keeps_the_original(raw: str) -> None:
    date = parse_date(raw)
    assert date is not None and date.kind == "unparsed" and date.raw == raw and date.start is None


def test_phrase_and_interpreted() -> None:
    phrase = parse_date("(во время чумы)")
    assert phrase is not None and phrase.kind == "phrase" and phrase.phrase == "во время чумы"
    interpreted = parse_date("INT 1748 (по записи в Библии)")
    assert interpreted is not None and interpreted.kind == "interpreted"
    assert interpreted.start == DatePoint(1748) and interpreted.phrase == "по записи в Библии"


def test_sort_year_uses_whichever_end_is_known() -> None:
    assert parse_date("BET 1740 AND 1750").sort_year == 1740  # type: ignore[union-attr]
    assert parse_date("TO 1750").sort_year == 1750  # type: ignore[union-attr]
