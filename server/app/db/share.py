"""Ссылки зрителям.

Ссылка выдаётся на род на срок, который редактор выбирает при выпуске, и живёт до этого дня или до
отзыва. Ключ хранится в базе как есть: редактор должен видеть ссылку целиком в любой момент, а не один
раз при выпуске. Открытая ссылка заводит сессию зрителя, и род попадает в список «своих» для этой
сессии — до того же дня, до какого действует ссылка; вторая ссылка добавляет второй род.
"""

import hashlib
import secrets
import sqlite3
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

TERMS = (30, 90, 180, 365)  # на сколько дней выпускается ссылка; бессрочной нет
DEFAULT_TERM = 90


class ShareError(Exception):
    """Рода нет или ссылка не подходит."""


@dataclass(frozen=True)
class ShareLink:
    key: str
    created_at: str
    opened: int  # сколько раз открывали
    opened_at: str | None
    expires_at: str  # до какого момента ссылка открывается


@dataclass(frozen=True)
class Access:
    clan_id: int
    until: str  # до какого момента гость свой для этого рода


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def _fingerprint(key: str) -> str:
    return hashlib.sha256(key.encode("utf-8")).hexdigest()


def _clan_exists(conn: sqlite3.Connection, clan_id: int) -> bool:
    return conn.execute("SELECT 1 FROM clans WHERE id = ?", (clan_id,)).fetchone() is not None


def link_of(conn: sqlite3.Connection, clan_id: int) -> ShareLink | None:
    row = conn.execute(
        "SELECT key, created_at, opened, opened_at, expires_at FROM share_links WHERE clan_id = ?", (clan_id,)
    ).fetchone()
    if row is None:
        return None
    return ShareLink(key=row["key"], created_at=row["created_at"], opened=row["opened"], opened_at=row["opened_at"],
                     expires_at=row["expires_at"])


def issue(conn: sqlite3.Connection, clan_id: int, days: int = DEFAULT_TERM) -> ShareLink:
    """Выпускает ссылку заново на days дней: прежняя перестаёт работать, а уже вошедшие зрители
    остаются при своём — каждый до того дня, который был у ссылки, по которой он пришёл."""
    if not _clan_exists(conn, clan_id):
        raise ShareError("Такого рода нет")
    if days not in TERMS:
        raise ShareError("Такого срока нет")
    key = secrets.token_urlsafe(16)
    now = _now()
    until = (datetime.now(UTC) + timedelta(days=days)).isoformat(timespec="seconds")
    with conn:
        conn.execute(
            "INSERT INTO share_links (clan_id, key, created_at, opened, opened_at, expires_at) VALUES (?, ?, ?, 0, NULL, ?)"
            " ON CONFLICT(clan_id) DO UPDATE SET key = excluded.key, created_at = excluded.created_at,"
            " opened = 0, opened_at = NULL, expires_at = excluded.expires_at",
            (clan_id, key, now, until),
        )
    return ShareLink(key=key, created_at=now, opened=0, opened_at=None, expires_at=until)


def revoke(conn: sqlite3.Connection, clan_id: int) -> None:
    """Отзывает ссылку и выгоняет зрителей этого рода: без ссылки род для них закрыт."""
    with conn:
        conn.execute("DELETE FROM share_links WHERE clan_id = ?", (clan_id,))
        conn.execute("DELETE FROM viewer_clans WHERE clan_id = ?", (clan_id,))


def enter(conn: sqlite3.Connection, key: str, session: str | None) -> tuple[str, int]:
    """Зритель открыл ссылку. Возвращает ключ его сессии и род, для которого он теперь свой."""
    row = conn.execute("SELECT clan_id, expires_at FROM share_links WHERE key = ?", (key,)).fetchone()
    if row is None:
        raise ShareError("Ссылка больше не работает")
    now = _now()
    if row["expires_at"] and row["expires_at"] <= now:
        raise ShareError("Срок ссылки вышел")
    clan_id = int(row["clan_id"])
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
        # гость свой для рода до того же дня, до какого действует ссылка; новая ссылка продлевает
        conn.execute(
            "INSERT INTO viewer_clans (fingerprint, clan_id, until) VALUES (?, ?, ?)"
            " ON CONFLICT(fingerprint, clan_id) DO UPDATE SET until = excluded.until",
            (mark, clan_id, row["expires_at"]),
        )
        conn.execute(
            "UPDATE share_links SET opened = opened + 1, opened_at = ? WHERE clan_id = ?", (now, clan_id)
        )
    return key_out or "", clan_id


def viewer_access(conn: sqlite3.Connection, session: str | None) -> list[Access]:
    """Роды, для которых предъявитель этой сессии свой, и до какого дня. Вышедший срок — уже не свой."""
    if not session:
        return []
    mark = _fingerprint(session)
    now = _now()
    rows = conn.execute(
        "SELECT clan_id, until FROM viewer_clans WHERE fingerprint = ? AND until > ? ORDER BY clan_id", (mark, now))
    access = [Access(clan_id=int(row["clan_id"]), until=row["until"]) for row in rows]
    if access:
        with conn:
            conn.execute("UPDATE viewer_sessions SET seen_at = ? WHERE fingerprint = ?", (now, mark))
    return access


def viewer_clans(conn: sqlite3.Connection, session: str | None) -> list[int]:
    """Роды, для которых предъявитель этой сессии свой."""
    return [a.clan_id for a in viewer_access(conn, session)]
