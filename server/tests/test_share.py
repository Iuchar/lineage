"""Ссылки зрителям: выпуск, отзыв, вход по ссылке и список своих родов."""

import sqlite3

import pytest

from app.db.connection import migrate
from datetime import UTC, datetime, timedelta

from app.db.share import DEFAULT_TERM, TERMS, ShareError, enter, issue, link_of, revoke, viewer_access, viewer_clans


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
    # срок виден обоим: редактору — у ссылки, гостю — у его доступа
    assert viewer.get("/api/me").json()["access"] == [{"clan_id": 1, "until": made["expires_at"]}]
    year = editor.post("/api/clans/1/link", json={"days": 365}).json()
    assert year["expires_at"] > made["expires_at"]
    assert editor.post("/api/clans/1/link", json={"days": 7}).status_code == 400
    made = editor.get("/api/clans/1/link").json()
    key = made["url"].rsplit("/", 1)[1]
    assert viewer.get(f"/r/{key}", follow_redirects=False).status_code == 303

    editor.delete("/api/clans/1/link")
    assert editor.get("/api/clans/1/link").json() is None
    assert viewer.get("/api/me").json()["clans"] == []
    # отозванная ссылка не пускает, а ведёт на страницу с оговоркой
    assert viewer.get(f"/r/{key}", follow_redirects=False).headers["location"].startswith("/?")


def _days_left(iso: str) -> float:
    return (datetime.fromisoformat(iso) - datetime.now(UTC)).total_seconds() / 86400


def test_link_has_a_term_and_no_eternal_one(conn: sqlite3.Connection) -> None:
    assert TERMS == (30, 90, 180, 365) and DEFAULT_TERM == 90
    assert 89.9 < _days_left(issue(conn, 1).expires_at) <= 90
    assert 364.9 < _days_left(issue(conn, 1, 365).expires_at) <= 365
    for days in (0, 7, 1000):
        with pytest.raises(ShareError, match="срока"):
            issue(conn, 1, days)


def test_guest_is_own_until_the_day_of_the_link(conn: sqlite3.Connection) -> None:
    link = issue(conn, 1, 30)
    session, _ = enter(conn, link.key, None)
    access = viewer_access(conn, session)
    assert [a.clan_id for a in access] == [1] and access[0].until == link.expires_at


def test_expired_link_does_not_open_and_access_ends(conn: sqlite3.Connection) -> None:
    link = issue(conn, 1, 30)
    session, _ = enter(conn, link.key, None)
    past = (datetime.now(UTC) - timedelta(minutes=1)).isoformat(timespec="seconds")
    with conn:
        conn.execute("UPDATE share_links SET expires_at = ?", (past,))
        conn.execute("UPDATE viewer_clans SET until = ?", (past,))
    with pytest.raises(ShareError, match="Срок"):
        enter(conn, link.key, None)
    assert viewer_clans(conn, session) == [] and viewer_access(conn, session) == []
    # редактор по-прежнему видит ссылку — и то, что срок вышел
    assert link_of(conn, 1) is not None and link_of(conn, 1).expires_at == past


def test_new_link_extends_the_guest_who_opens_it(conn: sqlite3.Connection) -> None:
    session, _ = enter(conn, issue(conn, 1, 30).key, None)
    longer = issue(conn, 1, 365)
    enter(conn, longer.key, session)
    assert viewer_access(conn, session)[0].until == longer.expires_at


def test_link_is_not_given_away_to_a_stranger(tmp_path, monkeypatch) -> None:
    """Ссылка — это и есть доступ к роду: кто её прочитал, тот вошёл. Отдавать её можно только редактору."""
    from fastapi.testclient import TestClient

    import app.config
    import app.main
    from app.db.access import add_editor
    from app.db.connection import connect

    path = tmp_path / "base.sqlite3"
    monkeypatch.setattr(app.config, "DB_PATH", path)
    monkeypatch.setattr(app.main, "DB_PATH", path)
    base = connect(path)
    with base:
        base.execute("INSERT INTO clans (id, name, imported_at) VALUES (1, 'Гленн Уриск', '2026-09-28')")
    add_editor(base, "Tyr", "длинный пароль")
    base.close()

    editor = TestClient(app.main.app)
    editor.post("/api/login", json={"name": "Tyr", "password": "длинный пароль"})
    made = editor.post("/api/clans/1/link").json()
    assert "/r/" in made["url"]

    stranger = TestClient(app.main.app)
    assert stranger.get("/api/clans/1/link").status_code == 401
    # и род не достаётся обходом: без ссылки он чужой
    assert stranger.get("/api/me").json()["clans"] == []

    # зритель, вошедший по ссылке, тоже не читает её заново: он свой для рода, но не редактор
    viewer = TestClient(app.main.app)
    viewer.get(f"/r/{made['url'].rsplit('/', 1)[1]}", follow_redirects=False)
    assert viewer.get("/api/me").json()["clans"] == [1]
    assert viewer.get("/api/clans/1/link").status_code == 401

    # редактор свою ссылку видит целиком — её для того и выпускают
    assert editor.get("/api/clans/1/link").json()["url"] == made["url"]
