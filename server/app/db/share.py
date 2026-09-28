"""Ссылки зрителям.

Ссылка выдаётся на род и живёт до отзыва. Ключ хранится в базе как есть: редактор должен видеть
ссылку целиком в любой момент, а не один раз при выпуске. Открытая ссылка заводит сессию зрителя,
и род попадает в список «своих» для этой сессии; вторая ссылка добавляет второй род.
"""

import hashlib
import secrets
import sqlite3
from dataclasses import dataclass
from datetime import UTC, datetime


class ShareError(Exception):
    """Рода нет или ссылка не подходит."""


@dataclass(frozen=True)
class ShareLink:
    key: str
    created_at: str
    opened: int  # сколько раз открывали
    opened_at: str | None


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def _fingerprint(key: str) -> str:
    return hashlib.sha256(key.encode("utf-8")).hexdigest()


def _clan_exists(conn: sqlite3.Connection, clan_id: int) -> bool:
    return conn.execute("SELECT 1 FROM clans WHERE id = ?", (clan_id,)).fetchone() is not None


def link_of(conn: sqlite3.Connection, clan_id: int) -> ShareLink | None:
    row = conn.execute(
        "SELECT key, created_at, opened, opened_at FROM share_links WHERE clan_id = ?", (clan_id,)
    ).fetchone()
    if row is None:
        return None
    return ShareLink(key=row["key"], created_at=row["created_at"], opened=row["opened"], opened_at=row["opened_at"])


def issue(conn: sqlite3.Connection, clan_id: int) -> ShareLink:
    """Выпускает ссылку заново: прежняя перестаёт работать, а уже вошедшие зрители остаются при своём."""
    if not _clan_exists(conn, clan_id):
        raise ShareError("Такого рода нет")
    key = secrets.token_urlsafe(16)
    now = _now()
    with conn:
        conn.execute(
            "INSERT INTO share_links (clan_id, key, created_at, opened, opened_at) VALUES (?, ?, ?, 0, NULL)"
            " ON CONFLICT(clan_id) DO UPDATE SET key = excluded.key, created_at = excluded.created_at,"
            " opened = 0, opened_at = NULL",
            (clan_id, key, now),
        )
    return ShareLink(key=key, created_at=now, opened=0, opened_at=None)


def revoke(conn: sqlite3.Connection, clan_id: int) -> None:
    """Отзывает ссылку и выгоняет зрителей этого рода: без ссылки род для них закрыт."""
    with conn:
        conn.execute("DELETE FROM share_links WHERE clan_id = ?", (clan_id,))
        conn.execute("DELETE FROM viewer_clans WHERE clan_id = ?", (clan_id,))


def enter(conn: sqlite3.Connection, key: str, session: str | None) -> tuple[str, int]:
    """Зритель открыл ссылку. Возвращает ключ его сессии и род, для которого он теперь свой."""
    row = conn.execute("SELECT clan_id FROM share_links WHERE key = ?", (key,)).fetchone()
    if row is None:
        raise ShareError("Ссылка больше не работает")
    clan_id = int(row["clan_id"])
    now = _now()
    known = session and conn.execute(
        "SELECT 1 FROM viewer_sessions WHERE fingerprint = ?", (_fingerprint(session),)
    ).fetchone()
    key_out = session if known else secrets.token_urlsafe(32)
    mark = _fingerprint(key_out or "")
    with conn:
        if not known:
            conn.execute(
                "INSERT INTO viewer_sessions (fingerprint, created_at, seen_at) VALUES (?, ?, ?)",
                (mark, now, now),
            )
        conn.execute(
            "INSERT OR IGNORE INTO viewer_clans (fingerprint, clan_id) VALUES (?, ?)", (mark, clan_id)
        )
        conn.execute(
            "UPDATE share_links SET opened = opened + 1, opened_at = ? WHERE clan_id = ?", (now, clan_id)
        )
    return key_out or "", clan_id


def viewer_clans(conn: sqlite3.Connection, session: str | None) -> list[int]:
    """Роды, для которых предъявитель этой сессии свой."""
    if not session:
        return []
    mark = _fingerprint(session)
    rows = conn.execute("SELECT clan_id FROM viewer_clans WHERE fingerprint = ? ORDER BY clan_id", (mark,))
    clans = [int(row["clan_id"]) for row in rows]
    if clans:
        with conn:
            conn.execute("UPDATE viewer_sessions SET seen_at = ? WHERE fingerprint = ?", (_now(), mark))
    return clans
