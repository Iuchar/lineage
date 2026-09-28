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
from datetime import UTC, datetime

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
    row = conn.execute("SELECT id, name, secret FROM editors WHERE name = ?", (name.strip(),)).fetchone()
    # одинаковый ответ на «нет такого» и «пароль не тот»: имя редактора не подсказывается
    if row is None or not _matches(row["secret"], password):
        raise AccessError("Имя или пароль не подходят.")
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
        "SELECT e.id AS id, e.name AS name FROM sessions s JOIN editors e ON e.id = s.editor_id"
        " WHERE s.fingerprint = ?",
        (_fingerprint(key),),
    ).fetchone()
    if row is None:
        return None
    with conn:
        conn.execute("UPDATE sessions SET seen_at = ? WHERE fingerprint = ?", (_now(), _fingerprint(key)))
    return Editor(id=row["id"], name=row["name"])
