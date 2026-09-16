import pytest

from app.gedcom.records import GedcomSyntaxError, Record, parse_records, split_lines
from conftest import CLANS, source


@pytest.mark.parametrize("clan", CLANS)
def test_file_assembles_back_into_the_same_lines(clan: str) -> None:
    text = source(clan).read_text(encoding="utf-8")
    records = parse_records(text)
    assert [line for r in records for line in r.to_lines()] == split_lines(text)


def test_json_keeps_the_record_whole() -> None:
    record = parse_records("0 @I1@ INDI\n1 NAME Ниалл /Гленн Уриск/\n2 _WEIRD x\n1 SEX M\n")[0]
    assert Record.from_json(record.to_json()).to_lines() == record.to_lines()


def test_line_endings_bom_and_missing_final_newline() -> None:
    records = parse_records("﻿0 HEAD\r\n1 CHAR UTF-8\r0 TRLR")
    assert [r.tag for r in records] == ["HEAD", "TRLR"]
    assert records[0].value_of("CHAR") == "UTF-8"


def test_absent_and_empty_value_differ() -> None:
    bare, spaced = parse_records("0 HEAD\n1 BIRT\n1 NOTE \n")[0].children
    assert bare.value is None and bare.to_lines() == ["1 BIRT"]
    assert spaced.value == "" and spaced.to_lines() == ["1 NOTE "]


def test_conc_and_cont_join_into_text() -> None:
    note = parse_records("0 @N1@ NOTE Ушёл из \n1 CONC рода\n1 CONT и основал свой")[0]
    assert note.text() == "Ушёл из рода\nи основал свой"


def test_level_jump_is_an_error_with_line_number() -> None:
    with pytest.raises(GedcomSyntaxError) as error:
        parse_records("0 @I1@ INDI\n2 GIVN Ниалл\n")
    assert error.value.line_no == 2


def test_malformed_line_is_an_error() -> None:
    with pytest.raises(GedcomSyntaxError):
        parse_records("0 HEAD\nне строка gedcom\n")
