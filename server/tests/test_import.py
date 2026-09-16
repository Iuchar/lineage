import json
import sqlite3
from pathlib import Path

import pytest

from app.db.clans import ClanExistsError, import_clan
from app.db.connection import connect, migrate
from app.gedcom.load import load_file, load_text
from app.gedcom.records import Record, parse_records
from conftest import CLANS, source


@pytest.fixture
def conn(tmp_path: Path) -> sqlite3.Connection:
    return connect(tmp_path / "test.sqlite3")


def count(conn: sqlite3.Connection, sql: str, *args: object) -> int:
    return conn.execute(sql, args).fetchone()[0]


def test_all_four_clans_land_in_the_database(conn: sqlite3.Connection) -> None:
    for clan, (file, persons, families, stubs) in CLANS.items():
        report = import_clan(conn, clan, load_file(source(clan)), source_file=file)
        assert (report.persons, report.families, report.branch_stubs) == (persons, families, stubs)
        assert count(conn, "SELECT COUNT(*) FROM persons WHERE clan_id = ?", report.clan_id) == persons
        assert count(conn, "SELECT COUNT(*) FROM families WHERE clan_id = ?", report.clan_id) == families
    assert count(conn, "SELECT COUNT(*) FROM clans") == 4
    assert count(conn, "SELECT COUNT(*) FROM persons") == 201


def test_raw_record_restores_the_original_lines(conn: sqlite3.Connection) -> None:
    text = source("Монад Кройве").read_text(encoding="utf-8")
    import_clan(conn, "Монад Кройве", load_text(text))
    original = {r.xref: r.to_lines() for r in parse_records(text) if r.xref}
    for xref, raw in conn.execute("SELECT xref, raw FROM persons UNION ALL SELECT xref, raw FROM families"):
        assert Record.from_json(json.loads(raw)).to_lines() == original[xref]


def test_same_ids_in_two_clans_are_different_people(conn: sqlite3.Connection) -> None:
    data = load_file(source("О'Дувейн"))
    first = import_clan(conn, "О'Дувейн", data)
    second = import_clan(conn, "Копия О'Дувейн", data)
    assert first.clan_id != second.clan_id
    assert count(conn, "SELECT COUNT(*) FROM persons WHERE xref = '@I3001@'") == 2


def test_upload_never_goes_into_an_existing_clan_silently(conn: sqlite3.Connection) -> None:
    data = load_file(source("О'Дувейн"))
    import_clan(conn, "О'Дувейн", data)
    with pytest.raises(ClanExistsError):
        import_clan(conn, "О'Дувейн", data)
    assert count(conn, "SELECT COUNT(*) FROM persons") == 17


def test_marriage_order_and_children_are_stored(conn: sqlite3.Connection) -> None:
    import_clan(conn, "Монад Кройве", load_file(source("Монад Кройве")))
    wives = [
        row[0]
        for row in conn.execute(
            """SELECT w.given FROM spouse_families sf
               JOIN persons m ON m.id = sf.person_id AND m.xref = '@I538@'
               JOIN families f ON f.id = sf.family_id
               JOIN persons w ON w.id = f.wife_id
               ORDER BY sf.position"""
        )
    ]
    assert wives == ["Иона", "Финнула", "Элспет"]
    assert count(conn, "SELECT COUNT(*) FROM family_children") == len(
        [c for f in load_file(source("Монад Кройве")).families.values() for c in f.children]
    )


def test_events_keep_date_and_place(conn: sqlite3.Connection) -> None:
    import_clan(
        conn,
        "Проба",
        load_text("0 @I1@ INDI\n1 BIRT\n2 DATE BET 1740 AND 1750\n2 PLAC Эттрик\n1 DEAT\n2 PLAC Эттрик\n"),
    )
    rows = conn.execute(
        "SELECT tag, date_kind, date_year, date_end_year, p.name FROM events e LEFT JOIN places p ON p.id = e.place_id"
    ).fetchall()
    assert [tuple(r) for r in rows] == [("BIRT", "between", 1740, 1750, "Эттрик"), ("DEAT", None, None, None, "Эттрик")]
    assert count(conn, "SELECT COUNT(*) FROM places") == 1


def test_migrations_apply_once(conn: sqlite3.Connection) -> None:
    assert migrate(conn) == []
    assert count(conn, "SELECT COUNT(*) FROM schema_migrations") == 1
