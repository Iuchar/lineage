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
    assert me == {"name": None, "guarded": False, "clans": [], "access": []}
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
    assert client.get("/api/me").json() == {"name": None, "guarded": True, "clans": [], "access": []}
    assert client.put("/api/clans/1/status", json={"status": "old"}).status_code == 401

    assert client.post("/api/login", json={"name": "Tyr", "password": "не тот"}).status_code == 401
    entered = client.post("/api/login", json={"name": "Tyr", "password": "длинный пароль"})
    # вход живёт, пока открыт браузер: у cookie нет срока, и с закрытием браузера она пропадает
    cookie = entered.headers["set-cookie"].lower()
    assert "max-age" not in cookie and "expires" not in cookie and "httponly" in cookie
    assert entered.status_code == 200 and entered.json()["name"] == "Tyr"
    assert client.get("/api/me").json() == {"name": "Tyr", "guarded": True, "clans": [], "access": []}
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

    password, salt = "пароль".encode(), "соль".encode()
    library = hashlib.pbkdf2_hmac("sha256", password, salt, 1000, 32)
    monkey = access.HAS_PBKDF2
    try:
        access.HAS_PBKDF2 = False
        assert access._pbkdf2(password, salt, 1000, 32) == library
    finally:
        access.HAS_PBKDF2 = monkey


def test_idle_session_goes_out_by_itself(conn: sqlite3.Connection) -> None:
    """Сессия, по которой полдня не было запросов, гаснет: вход не живёт вечно."""
    from datetime import UTC, datetime, timedelta

    from app.db.access import IDLE_HOURS, add_editor, editor_by_key, login

    add_editor(conn, "Tyr", "длинный пароль")
    key = login(conn, "Tyr", "длинный пароль")
    assert editor_by_key(conn, key) is not None

    def seen(hours_ago: float) -> None:
        moment = (datetime.now(UTC) - timedelta(hours=hours_ago)).isoformat(timespec="seconds")
        with conn:
            conn.execute("UPDATE sessions SET seen_at = ?", (moment,))

    seen(IDLE_HOURS - 1)
    assert editor_by_key(conn, key) is not None  # запрос продлил сессию
    seen(IDLE_HOURS + 1)
    assert editor_by_key(conn, key) is None
    assert conn.execute("SELECT count(*) FROM sessions").fetchone()[0] == 0


def test_journal_is_closed_to_strangers(tmp_path, monkeypatch) -> None:
    """Журнал — рабочий стол редактора: он помнит и прежние значения полей, и имена скрытых.

    Скрытого человека нет в дереве зрителя вовсе, и журнал не должен выдавать его с чёрного хода.
    """
    import app.config
    import app.main
    from app.db.clans import import_clan
    from app.db.connection import connect
    from app.db.editor import PersonFields, update_person
    from app.gedcom.load import load_file
    from conftest import source

    path = tmp_path / "base.sqlite3"
    monkeypatch.setattr(app.config, "DB_PATH", path)
    monkeypatch.setattr(app.main, "DB_PATH", path)
    base = connect(path)
    import_clan(base, "Гленн Уриск", load_file(source("Гленн Уриск")))
    hidden = base.execute(
        "SELECT id, given FROM persons WHERE clan_id = 1 AND given <> '' AND given IS NOT NULL ORDER BY id LIMIT 1"
    ).fetchone()
    update_person(base, hidden["id"], PersonFields(given=hidden["given"], see="hidden"))
    add_editor(base, "Tyr", "длинный пароль")
    base.close()

    stranger = TestClient(app.main.app)
    assert stranger.get("/api/clans/1/changes").status_code == 401
    assert stranger.get(f"/api/persons/{hidden['id']}/changes").status_code == 401

    editor = TestClient(app.main.app)
    editor.post("/api/login", json={"name": "Tyr", "password": "длинный пароль"})
    changes = editor.get("/api/clans/1/changes")
    assert changes.status_code == 200 and changes.json()
    assert hidden["given"] in changes.text  # редактору журнал виден целиком
    assert editor.get(f"/api/persons/{hidden['id']}/changes").status_code == 200


def test_login_does_not_say_whether_the_editor_exists(conn: sqlite3.Connection) -> None:
    """Ответ одинаков и на слово, и на секундомер: иначе имя редактора подбирается по времени."""
    import time

    from app.db import access

    add_editor(conn, "Tyr", "длинный пароль")

    def how_long(name: str) -> float:
        start = time.perf_counter()
        with pytest.raises(AccessError):
            login(conn, name, "не тот пароль")
        return time.perf_counter() - start

    access.spare_attempts(conn, "Tyr")
    access.spare_attempts(conn, "НетТакого")
    known = how_long("Tyr")
    access.spare_attempts(conn, "Tyr")
    unknown = how_long("НетТакого")
    # заведомо грубый порог: ловим разницу в разы, а не дрожание машины
    assert unknown > known / 3, f"по существующему {known * 1000:.0f} мс, по выдуманному {unknown * 1000:.0f} мс"


def test_login_slows_down_after_a_run_of_misses(conn: sqlite3.Connection) -> None:
    """Перебор упирается в задержку. Хозяин не заперт: он ждёт и входит, а правильный пароль всё снимает."""
    from app.db.access import FREE_TRIES, TooManyTries, spare_attempts

    add_editor(conn, "Tyr", "длинный пароль")
    for _ in range(FREE_TRIES):
        with pytest.raises(AccessError):
            login(conn, "Tyr", "не тот пароль")
    # следующая попытка уже не проверяет пароль, а просит подождать
    with pytest.raises(TooManyTries) as waiting:
        login(conn, "Tyr", "не тот пароль")
    assert waiting.value.seconds > 0
    # и верный пароль в эту минуту тоже не пускает: иначе отпор обходится подбором
    with pytest.raises(TooManyTries):
        login(conn, "Tyr", "длинный пароль")

    # выдуманное имя считается отдельно и тоже упирается — иначе 429 выдавал бы, кто заведён
    for _ in range(FREE_TRIES):
        with pytest.raises(AccessError):
            login(conn, "НетТакого", "не тот пароль")
    with pytest.raises(TooManyTries):
        login(conn, "НетТакого", "не тот пароль")

    # переждал — пускает, и успешный вход обнуляет счёт
    spare_attempts(conn, "Tyr")
    assert login(conn, "Tyr", "длинный пароль")
    with pytest.raises(AccessError):
        login(conn, "Tyr", "не тот пароль")  # счёт начат заново, а не продолжен


def test_api_answers_429_when_tries_run_out(tmp_path, monkeypatch) -> None:
    import app.config
    import app.main
    from app.db.access import FREE_TRIES
    from app.db.connection import connect

    path = tmp_path / "base.sqlite3"
    monkeypatch.setattr(app.config, "DB_PATH", path)
    monkeypatch.setattr(app.main, "DB_PATH", path)
    base = connect(path)
    add_editor(base, "Tyr", "длинный пароль")
    base.close()

    client = TestClient(app.main.app)
    for _ in range(FREE_TRIES):
        assert client.post("/api/login", json={"name": "Tyr", "password": "не тот"}).status_code == 401
    answer = client.post("/api/login", json={"name": "Tyr", "password": "не тот"})
    assert answer.status_code == 429
    assert answer.headers.get("retry-after")


def test_cookies_are_secure_behind_https(tmp_path, monkeypatch) -> None:
    """По шифрованному соединению cookie помечается secure, иначе ключ сессии уйдёт и по открытому.

    На http метка не ставится: без неё браузер отказался бы хранить cookie, и приложение
    перестало бы работать на localhost и в домашней сети.
    """
    import app.config
    import app.main
    from app.db.connection import connect

    path = tmp_path / "base.sqlite3"
    monkeypatch.setattr(app.config, "DB_PATH", path)
    monkeypatch.setattr(app.main, "DB_PATH", path)
    base = connect(path)
    add_editor(base, "Tyr", "длинный пароль")
    base.close()

    plain = TestClient(app.main.app, base_url="http://rodoslovnye.local")
    entered = plain.post("/api/login", json={"name": "Tyr", "password": "длинный пароль"})
    assert "secure" not in entered.headers["set-cookie"].lower()

    # за обратным прокси схема приходит заголовком — её и слушаем
    safe = TestClient(app.main.app, base_url="https://rodoslovnye.local")
    entered = safe.post("/api/login", json={"name": "Tyr", "password": "длинный пароль"},
                        headers={"X-Forwarded-Proto": "https"})
    cookie = entered.headers["set-cookie"].lower()
    assert "secure" in cookie and "httponly" in cookie and "samesite=lax" in cookie


def test_new_password_puts_out_the_old_sessions(conn: sqlite3.Connection) -> None:
    """Пароль меняют, когда он утёк. Значит и сессии, открытые прежним, должны погаснуть сразу,
    а не доживать свои двенадцать часов."""
    add_editor(conn, "Tyr", "длинный пароль")
    key = login(conn, "Tyr", "длинный пароль")
    assert editor_by_key(conn, key)

    set_password(conn, "Tyr", "совсем другой пароль")
    assert editor_by_key(conn, key) is None
    assert conn.execute("SELECT count(*) FROM sessions").fetchone()[0] == 0
    # новым паролем входят заново
    assert editor_by_key(conn, login(conn, "Tyr", "совсем другой пароль"))


def test_session_does_not_outlive_its_ceiling(conn: sqlite3.Connection, monkeypatch) -> None:
    """У сессии есть и потолок, а не только простой: иначе украденная cookie жила бы, пока ею пользуются."""
    from datetime import UTC, datetime, timedelta

    from app.db import access

    add_editor(conn, "Tyr", "длинный пароль")
    key = login(conn, "Tyr", "длинный пароль")
    # отодвинем начало сессии за потолок, а последний запрос оставим свежим
    long_ago = (datetime.now(UTC) - timedelta(days=access.LIFE_DAYS + 1)).isoformat(timespec="seconds")
    with conn:
        conn.execute("UPDATE sessions SET created_at = ?", (long_ago,))
    assert editor_by_key(conn, key) is None
    assert conn.execute("SELECT count(*) FROM sessions").fetchone()[0] == 0


def test_dead_sessions_do_not_pile_up(conn: sqlite3.Connection) -> None:
    """Погасшая сессия убирается не только при обращении по её же ключу: иначе таблица растёт без конца."""
    from datetime import UTC, datetime, timedelta

    from app.db import access

    add_editor(conn, "Tyr", "длинный пароль")
    stale = login(conn, "Tyr", "длинный пароль")
    fresh = login(conn, "Tyr", "длинный пароль")
    with conn:
        conn.execute("UPDATE sessions SET seen_at = ? WHERE fingerprint <> ?",
                     ((datetime.now(UTC) - timedelta(hours=access.IDLE_HOURS + 1)).isoformat(timespec="seconds"),
                      access._fingerprint(fresh)))
    # ходит живая сессия, а подбирается и чужая погасшая
    assert editor_by_key(conn, fresh)
    assert conn.execute("SELECT count(*) FROM sessions").fetchone()[0] == 1
    assert editor_by_key(conn, stale) is None
