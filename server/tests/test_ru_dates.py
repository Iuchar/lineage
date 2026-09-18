import pytest

from app.gedcom.ru_dates import DateInputError, parse_input

CASES = [
    ("12 мар 1748", "12 MAR 1748", "12 марта 1748"),
    ("12 марта 1748", "12 MAR 1748", "12 марта 1748"),
    ("12.03.1748", "12 MAR 1748", "12 марта 1748"),
    ("мар 1748", "MAR 1748", "март 1748"),
    ("май 1760", "MAY 1760", "май 1760"),
    ("1748", "1748", "1748"),
    ("около 1750", "ABT 1750", "около 1750"),
    ("ок 1750", "ABT 1750", "около 1750"),
    ("ок. 1750", "ABT 1750", "около 1750"),
    ("прим. 1750", "ABT 1750", "около 1750"),
    ("до 1800", "BEF 1800", "до 1800"),
    ("после 1790", "AFT 1790", "после 1790"),
    ("между 1740 и 1745", "BET 1740 AND 1745", "между 1740 и 1745"),
    ("1740-1745", "BET 1740 AND 1745", "между 1740 и 1745"),
    ("1740 – 1745", "BET 1740 AND 1745", "между 1740 и 1745"),
    ("с 1740 по 1745", "FROM 1740 TO 1745", "с 1740 по 1745"),
    ("около 12 мар 1748", "ABT 12 MAR 1748", "около 12 марта 1748"),
    ("ABT 1750", "ABT 1750", "около 1750"),
    ("29 фев 1752", "29 FEB 1752", "29 февраля 1752"),
]


@pytest.mark.parametrize(("text", "gedcom", "ru"), CASES)
def test_russian_input_becomes_gedcom(text: str, gedcom: str, ru: str) -> None:
    parsed = parse_input(text)
    assert (parsed.gedcom, parsed.ru) == (gedcom, ru)


def test_empty_means_no_date() -> None:
    assert parse_input("  ").gedcom is None


@pytest.mark.parametrize(("text", "reason"), [
    ("32 мар 1748", "в марте 31 день"),
    ("29 фев 1751", "в феврале 1751 года 28 дней"),
    ("31 апр 1750", "в апреле 30 дней"),
    ("12 брюм 1748", "не понял месяц"),
    ("когда-то давно", "не похоже на дату"),
])
def test_nonsense_is_rejected_with_a_reason(text: str, reason: str) -> None:
    with pytest.raises(DateInputError, match=reason):
        parse_input(text)
