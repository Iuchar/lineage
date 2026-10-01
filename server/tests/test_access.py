"""Вход редактора: пароль, сессия и запрет правок без входа."""

import sqlite3

import pytest
from fastapi.testclient import TestClient

from app.db.access import AccessError, add_editor, editor_by_key, editors_exist, list_editors, login, logout, set_password
from app.db.connection import migrate


@pytest.fixture()
def conn() -> sqlite3.Connection:
    connection = sqlite3.connect(":memory:")
    connection.row_factory = sqlite3.Row
    migrate(connection)
    return connection


def test_editor_appears_and_password_is_not_stored(conn: sqlite3.Connection) -> None:
    add_editor(conn, "Tyr", "длинный пароль")
    assert editors_exist(conn)
    assert [item.name for item in list_editors(conn)] == ["Tyr"]
    secret = conn.execute("SELECT secret FROM editors").fetchone()["secret"]
    assert "длинный пароль" not in secret
    assert secret.startswith("scrypt$")


def test_short_password_and_double_name_are_refused(conn: sqlite3.Connection) -> None:
    with pytest.raises(AccessError):
        add_editor(conn, "Tyr", "коротко")
    add_editor(conn, "Tyr", "длинный пароль")
    with pytest.raises(AccessError):
        add_editor(conn, "Tyr", "другой длинный")


def test_login_gives_session_and_logout_takes_it_back(conn: sqlite3.Connection) -> None:
    add_editor(conn, "Tyr", "длинный пароль")
    key = login(conn, "Tyr", "длинный пароль")
    editor = editor_by_key(conn, key)
    assert editor is not None and editor.name == "Tyr"
    logout(conn, key)
    assert editor_by_key(conn, key) is None


def test_wrong_password_and_unknown_name_answer_the_same(conn: sqlite3.Connection) -> None:
    add_editor(conn, "Tyr", "длинный пароль")
    with pytest.raises(AccessError) as wrong:
        login(conn, "Tyr", "не тот пароль")
    with pytest.raises(AccessError) as unknown:
        login(conn, "Эйлин", "длинный пароль")
    assert str(wrong.value) == str(unknown.value)


def test_session_key_is_not_stored_as_is(conn: sqlite3.Connection) -> None:
    add_editor(conn, "Tyr", "длинный пароль")
    key = login(conn, "Tyr", "длинный пароль")
    stored = conn.execute("SELECT fingerprint FROM sessions").fetchone()["fingerprint"]
    assert stored != key


def test_new_password_replaces_old_one(conn: sqlite3.Connection) -> None:
    add_editor(conn, "Tyr", "длинный пароль")
    set_password(conn, "Tyr", "совсем другой пароль")
    with pytest.raises(AccessError):
        login(conn, "Tyr", "длинный пароль")
    assert login(conn, "Tyr", "совсем другой пароль")


def test_api_without_editors_lets_edit(tmp_path, monkeypatch) -> None:
    """Пока редакторов нет, правка открыта: приложение работает как раньше."""
    import app.config
    import app.main

    monkeypatch.setattr(app.config, "DB_PATH", tmp_path / "base.sqlite3")
    monkeypatch.setattr(app.main, "DB_PATH", tmp_path / "base.sqlite3")
    client = TestClient(app.main.app)
    me = client.get("/api/me").json()
    assert me == {"name": None, "guarded": False, "clans": []}
    # рода нет, но ответ приходит от самого обработчика, а не от заслона
    assert client.put("/api/clans/1/status", json={"status": "old"}).status_code == 400


def test_api_with_editor_demands_login(tmp_path, monkeypatch) -> None:
    import app.config
    import app.main
    from app.db.connection import connect

    path = tmp_path / "base.sqlite3"
    monkeypatch.setattr(app.config, "DB_PATH", path)
    monkeypatch.setattr(app.main, "DB_PATH", path)
    base = connect(path)
    add_editor(base, "Tyr", "длинный пароль")
    base.close()

    client = TestClient(app.main.app)
    assert client.get("/api/me").json() == {"name": None, "guarded": True, "clans": []}
    assert client.put("/api/clans/1/status", json={"status": "old"}).status_code == 401

    assert client.post("/api/login", json={"name": "Tyr", "password": "не тот"}).status_code == 401
    entered = client.post("/api/login", json={"name": "Tyr", "password": "длинный пароль"})
    # вход живёт, пока открыт браузер: у cookie нет срока, и с закрытием браузера она пропадает
    cookie = entered.headers["set-cookie"].lower()
    assert "max-age" not in cookie and "expires" not in cookie and "httponly" in cookie
    assert entered.status_code == 200 and entered.json()["name"] == "Tyr"
    assert client.get("/api/me").json() == {"name": "Tyr", "guarded": True, "clans": []}
    # вошли: заслон пропускает, дальше отвечает сам обработчик
    assert client.put("/api/clans/1/status", json={"status": "old"}).status_code == 400

    client.post("/api/logout")
    assert client.get("/api/me").json()["name"] is None
    assert client.put("/api/clans/1/status", json={"status": "old"}).status_code == 401


def test_password_works_without_scrypt(conn: sqlite3.Connection, monkeypatch) -> None:
    """В браузерной сборке Python нет scrypt — пароль считается pbkdf2, и вход всё равно работает."""
    import app.db.access as access

    monkeypatch.setattr(access, "HAS_SCRYPT", False)
    add_editor(conn, "Эйлин", "длинный пароль")
    secret = conn.execute("SELECT secret FROM editors WHERE name = 'Эйлин'").fetchone()["secret"]
    assert secret.startswith("pbkdf2$")
    assert login(conn, "Эйлин", "длинный пароль")
    with pytest.raises(AccessError):
        login(conn, "Эйлин", "не тот пароль")


def test_scrypt_password_still_opens_when_scrypt_is_there(conn: sqlite3.Connection) -> None:
    add_editor(conn, "Tyr", "длинный пароль")
    secret = conn.execute("SELECT secret FROM editors WHERE name = 'Tyr'").fetchone()["secret"]
    assert secret.startswith("scrypt$")
    assert login(conn, "Tyr", "длинный пароль")


def test_password_works_on_bare_hashlib(conn: sqlite3.Connection, monkeypatch) -> None:
    """Совсем урезанный hashlib: ни scrypt, ни pbkdf2 — счёт идёт вручную через hmac."""
    import app.db.access as access

    monkeypatch.setattr(access, "HAS_SCRYPT", False)
    monkeypatch.setattr(access, "HAS_PBKDF2", False)
    add_editor(conn, "Мойра", "длинный пароль")
    assert login(conn, "Мойра", "длинный пароль")
    with pytest.raises(AccessError):
        login(conn, "Мойра", "не тот пароль")


def test_hand_counted_pbkdf2_matches_the_library_one() -> None:
    """Ручной счёт должен совпадать с библиотечным, иначе пароли с сервера не откроются в браузере."""
    import hashlib

    import app.db.access as access

    password, salt = "пароль".encode("utf-8"), "соль".encode("utf-8")
    library = hashlib.pbkdf2_hmac("sha256", password, salt, 1000, 32)
    monkey = access.HAS_PBKDF2
    try:
        access.HAS_PBKDF2 = False
        assert access._pbkdf2(password, salt, 1000, 32) == library
    finally:
        access.HAS_PBKDF2 = monkey
