"""Ссылки зрителям: выпуск, отзыв, вход по ссылке и список своих родов."""

import sqlite3

import pytest

from app.db.connection import migrate
from app.db.share import ShareError, enter, issue, link_of, revoke, viewer_clans


@pytest.fixture()
def conn() -> sqlite3.Connection:
    connection = sqlite3.connect(":memory:")
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    migrate(connection)
    with connection:
        connection.execute("INSERT INTO clans (id, name, imported_at) VALUES (1, 'Гленн Уриск', '2026-09-28')")
        connection.execute("INSERT INTO clans (id, name, imported_at) VALUES (2, 'Уинтерхоуп', '2026-09-28')")
    return connection


def test_link_appears_and_is_one_per_clan(conn: sqlite3.Connection) -> None:
    assert link_of(conn, 1) is None
    first = issue(conn, 1)
    assert link_of(conn, 1) is not None and link_of(conn, 1).key == first.key
    second = issue(conn, 1)
    assert second.key != first.key
    assert conn.execute("SELECT count(*) FROM share_links WHERE clan_id = 1").fetchone()[0] == 1


def test_link_for_missing_clan_is_refused(conn: sqlite3.Connection) -> None:
    with pytest.raises(ShareError):
        issue(conn, 99)


def test_viewer_becomes_own_for_clan(conn: sqlite3.Connection) -> None:
    link = issue(conn, 1)
    session, clan_id = enter(conn, link.key, None)
    assert clan_id == 1
    assert viewer_clans(conn, session) == [1]
    assert link_of(conn, 1).opened == 1


def test_second_link_adds_second_clan_to_same_session(conn: sqlite3.Connection) -> None:
    first = issue(conn, 1)
    second = issue(conn, 2)
    session, _ = enter(conn, first.key, None)
    same, _ = enter(conn, second.key, session)
    assert same == session
    assert viewer_clans(conn, session) == [1, 2]


def test_reissued_link_kills_the_old_one(conn: sqlite3.Connection) -> None:
    old = issue(conn, 1)
    issue(conn, 1)
    with pytest.raises(ShareError):
        enter(conn, old.key, None)


def test_revoke_closes_clan_for_those_who_came(conn: sqlite3.Connection) -> None:
    link = issue(conn, 1)
    session, _ = enter(conn, link.key, None)
    assert viewer_clans(conn, session) == [1]
    revoke(conn, 1)
    assert viewer_clans(conn, session) == []
    with pytest.raises(ShareError):
        enter(conn, link.key, None)


def test_unknown_session_owns_nothing(conn: sqlite3.Connection) -> None:
    assert viewer_clans(conn, None) == []
    assert viewer_clans(conn, "выдуманный ключ") == []


def test_api_issues_shows_and_revokes(tmp_path, monkeypatch) -> None:
    from fastapi.testclient import TestClient

    import app.config
    import app.main
    from app.db.connection import connect

    path = tmp_path / "base.sqlite3"
    monkeypatch.setattr(app.config, "DB_PATH", path)
    monkeypatch.setattr(app.main, "DB_PATH", path)
    base = connect(path)
    with base:
        base.execute("INSERT INTO clans (id, name, imported_at) VALUES (1, 'Гленн Уриск', '2026-09-28')")
    base.close()

    editor = TestClient(app.main.app)
    assert editor.get("/api/clans/1/link").json() is None
    made = editor.post("/api/clans/1/link").json()
    assert made["url"].startswith("http") and "/r/" in made["url"]
    assert editor.get("/api/clans/1/link").json()["url"] == made["url"]

    viewer = TestClient(app.main.app)
    key = made["url"].rsplit("/", 1)[1]
    assert viewer.get(f"/r/{key}", follow_redirects=False).status_code == 303
    assert viewer.get("/api/me").json()["clans"] == [1]
    assert editor.get("/api/clans/1/link").json()["opened"] == 1

    editor.delete("/api/clans/1/link")
    assert editor.get("/api/clans/1/link").json() is None
    assert viewer.get("/api/me").json()["clans"] == []
    # отозванная ссылка не пускает, а ведёт на страницу с оговоркой
    assert viewer.get(f"/r/{key}", follow_redirects=False).headers["location"].startswith("/?")
