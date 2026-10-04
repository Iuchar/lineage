"""Редакторы и их сессии.

Пароль хранится отпечатком scrypt, ключ сессии — отпечатком sha256: из базы нельзя ни узнать пароль,
ни войти по чужой сессии. Пока не заведён ни один редактор, правка открыта: так приложение работает
на одном компьютере до того, как понадобится раздавать доступ.
"""

import hashlib
import hmac
import secrets
import sqlite3
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

SCRYPT_N = 2 ** 14
SCRYPT_R = 8
SCRYPT_P = 1
KEY_BYTES = 32
# В сборке Python для браузера hashlib урезан: нет ни scrypt, ни pbkdf2 — только sha256 и hmac.
# Поэтому способ выбирается по тому, что есть под рукой, а сам отпечаток говорит, чем он сделан.
HAS_SCRYPT = hasattr(hashlib, "scrypt")
HAS_PBKDF2 = hasattr(hashlib, "pbkdf2_hmac")
PBKDF2_ROUNDS = 200_000  # быстрая реализация на месте
SLOW_ROUNDS = 20_000  # счёт вручную, иначе вход в браузере занимал бы секунды
IDLE_HOURS = 12  # столько сессия редактора живёт без единого запроса
FREE_TRIES = 5  # столько промахов подряд проходят без задержки: человек ошибается, и это нормально
# дальше каждая неудача отодвигает следующую попытку. Запирать имя насовсем нельзя: тогда любой
# прохожий закрыл бы редактору вход, просто набирая чепуху. Поэтому не запрет, а ожидание.
WAIT_STEPS = (5, 15, 45, 120, 300)  # секунды; дальше держится последняя
TRIES_FORGOTTEN_HOURS = 12  # давний промах не в счёт: счёт неудач подряд, а не за всю жизнь


def _pbkdf2(password: bytes, salt: bytes, rounds: int, length: int) -> bytes:
    """Тот же pbkdf2, но руками: нужен там, где hashlib собран без него."""
    if HAS_PBKDF2:
        return hashlib.pbkdf2_hmac("sha256", password, salt, rounds, length)
    out = b""
    block = 1
    while len(out) < length:
        piece = hmac.new(password, salt + block.to_bytes(4, "big"), hashlib.sha256).digest()
        mixed = piece
        for _ in range(rounds - 1):
            piece = hmac.new(password, piece, hashlib.sha256).digest()
            mixed = bytes(a ^ b for a, b in zip(mixed, piece, strict=True))
        out += mixed
        block += 1
    return out[:length]


class AccessError(Exception):
    """Вход не удался или имя занято."""


class TooManyTries(AccessError):
    """Промахов подряд слишком много: следующую попытку принимают не сразу."""

    def __init__(self, seconds: int) -> None:
        self.seconds = seconds
        super().__init__(f"Слишком много попыток. Повторите через {_russian_wait(seconds)}.")


def _russian_wait(seconds: int) -> str:
    if seconds < 60:
        return f"{seconds} с"
    minutes = -(-seconds // 60)
    tail = minutes % 10
    word = "минуту" if tail == 1 and minutes != 11 else "минуты" if 2 <= tail <= 4 and minutes not in (12, 13, 14) else "минут"
    return f"{minutes} {word}"


@dataclass(frozen=True)
class Editor:
    id: int
    name: str


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def _secret(password: str) -> str:
    salt = secrets.token_bytes(16)
    if HAS_SCRYPT:
        key = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P,
                             dklen=KEY_BYTES)
        return f"scrypt${SCRYPT_N}${SCRYPT_R}${SCRYPT_P}${salt.hex()}${key.hex()}"
    rounds = PBKDF2_ROUNDS if HAS_PBKDF2 else SLOW_ROUNDS
    key = _pbkdf2(password.encode("utf-8"), salt, rounds, KEY_BYTES)
    return f"pbkdf2${rounds}${salt.hex()}${key.hex()}"


def _matches(secret: str, password: str) -> bool:
    """Отпечаток сам говорит, чем он сделан: так пароли, заведённые на сервере, работают и в браузере."""
    try:
        parts = secret.split("$")
        if parts[0] == "scrypt":
            _, n, r, p, salt, key = parts
            made = hashlib.scrypt(password.encode("utf-8"), salt=bytes.fromhex(salt),
                                  n=int(n), r=int(r), p=int(p), dklen=len(bytes.fromhex(key)))
        elif parts[0] == "pbkdf2":
            _, rounds, salt, key = parts
            made = _pbkdf2(password.encode("utf-8"), bytes.fromhex(salt), int(rounds), len(bytes.fromhex(key)))
        else:
            return False
    except (ValueError, TypeError):
        return False
    return secrets.compare_digest(made.hex(), key)


def _fingerprint(key: str) -> str:
    return hashlib.sha256(key.encode("utf-8")).hexdigest()


_decoy: str | None = None


def _decoy_secret() -> str:
    """Отпечаток ни от чьего пароля. Нужен, чтобы вход под выдуманным именем считался столько же,
    сколько под заведённым: иначе имена редакторов подбираются по секундомеру, а не по ответу."""
    global _decoy
    if _decoy is None:
        _decoy = _secret(secrets.token_urlsafe(32))
    return _decoy


def _tries(conn: sqlite3.Connection, name: str) -> tuple[int, str | None]:
    row = conn.execute("SELECT misses, last_at, open_at FROM login_tries WHERE name = ?", (name,)).fetchone()
    if row is None:
        return 0, None
    # давние промахи забываются: считаем неудачи подряд, а не за всю жизнь
    if datetime.now(UTC) - datetime.fromisoformat(row["last_at"]) > timedelta(hours=TRIES_FORGOTTEN_HOURS):
        return 0, None
    return int(row["misses"]), row["open_at"]


def _check_tries(conn: sqlite3.Connection, name: str) -> None:
    _, open_at = _tries(conn, name)
    if open_at is None:
        return
    left = (datetime.fromisoformat(open_at) - datetime.now(UTC)).total_seconds()
    if left > 0:
        raise TooManyTries(int(left) + 1)


def _count_miss(conn: sqlite3.Connection, name: str) -> None:
    misses = _tries(conn, name)[0] + 1
    # пятый промах подряд уже отодвигает шестую попытку: свободных ровно FREE_TRIES
    wait = WAIT_STEPS[min(misses - FREE_TRIES, len(WAIT_STEPS) - 1)] if misses >= FREE_TRIES else 0
    now = datetime.now(UTC)
    open_at = (now + timedelta(seconds=wait)).isoformat(timespec="seconds") if wait else None
    with conn:
        conn.execute(
            "INSERT INTO login_tries (name, misses, last_at, open_at) VALUES (?, ?, ?, ?)"
            " ON CONFLICT(name) DO UPDATE SET misses = excluded.misses, last_at = excluded.last_at,"
            " open_at = excluded.open_at",
            (name, misses, now.isoformat(timespec="seconds"), open_at),
        )


def spare_attempts(conn: sqlite3.Connection, name: str) -> None:
    """Счёт промахов начинается заново: так делает удачный вход, и так же снимают ожидание вручную."""
    with conn:
        conn.execute("DELETE FROM login_tries WHERE name = ?", (name,))


def editors_exist(conn: sqlite3.Connection) -> bool:
    return conn.execute("SELECT 1 FROM editors LIMIT 1").fetchone() is not None


def add_editor(conn: sqlite3.Connection, name: str, password: str) -> Editor:
    name = name.strip()
    if not name:
        raise AccessError("У редактора должно быть имя.")
    if len(password) < 8:
        raise AccessError("Пароль короче восьми знаков.")
    with conn:
        try:
            cursor = conn.execute(
                "INSERT INTO editors (name, secret, created_at) VALUES (?, ?, ?)",
                (name, _secret(password), _now()),
            )
        except sqlite3.IntegrityError as error:
            raise AccessError(f"Редактор «{name}» уже заведён.") from error
    return Editor(id=int(cursor.lastrowid or 0), name=name)


def set_password(conn: sqlite3.Connection, name: str, password: str) -> None:
    if len(password) < 8:
        raise AccessError("Пароль короче восьми знаков.")
    with conn:
        changed = conn.execute("UPDATE editors SET secret = ? WHERE name = ?", (_secret(password), name)).rowcount
    if not changed:
        raise AccessError(f"Редактора «{name}» нет.")


def list_editors(conn: sqlite3.Connection) -> list[Editor]:
    rows = conn.execute("SELECT id, name FROM editors ORDER BY name")
    return [Editor(id=row["id"], name=row["name"]) for row in rows]


def login(conn: sqlite3.Connection, name: str, password: str) -> str:
    """Проверяет пароль и заводит сессию. Возвращает ключ, который уходит в cookie."""
    name = name.strip()
    # промахи считаются и по выдуманному имени: иначе отказ «подождите» сам говорил бы, кто заведён
    _check_tries(conn, name)
    row = conn.execute("SELECT id, name, secret FROM editors WHERE name = ?", (name,)).fetchone()
    # одинаковый ответ на «нет такого» и «пароль не тот» — и по слову, и по времени: под выдуманным
    # именем пароль сверяется с подставным отпечатком, чтобы счёт занял столько же
    if not _matches(row["secret"] if row else _decoy_secret(), password) or row is None:
        _count_miss(conn, name)
        raise AccessError("Имя или пароль не подходят.")
    spare_attempts(conn, name)
    key = secrets.token_urlsafe(32)
    now = _now()
    with conn:
        conn.execute(
            "INSERT INTO sessions (fingerprint, editor_id, created_at, seen_at) VALUES (?, ?, ?, ?)",
            (_fingerprint(key), row["id"], now, now),
        )
    return key


def logout(conn: sqlite3.Connection, key: str) -> None:
    with conn:
        conn.execute("DELETE FROM sessions WHERE fingerprint = ?", (_fingerprint(key),))


def editor_by_key(conn: sqlite3.Connection, key: str | None) -> Editor | None:
    if not key:
        return None
    row = conn.execute(
        "SELECT e.id AS id, e.name AS name, s.seen_at AS seen_at FROM sessions s JOIN editors e ON e.id = s.editor_id"
        " WHERE s.fingerprint = ?",
        (_fingerprint(key),),
    ).fetchone()
    if row is None:
        return None
    # сессия, по которой давно не было запросов, гаснет сама: забытый вход и украденная cookie не живут вечно
    idle = datetime.now(UTC) - datetime.fromisoformat(row["seen_at"])
    if idle > timedelta(hours=IDLE_HOURS):
        logout(conn, key)
        return None
    with conn:
        conn.execute("UPDATE sessions SET seen_at = ? WHERE fingerprint = ?", (_now(), _fingerprint(key)))
    return Editor(id=row["id"], name=row["name"])
