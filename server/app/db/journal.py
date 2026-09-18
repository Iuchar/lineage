"""Журнал правок и пересборка таблиц из записей GEDCOM.

Правка меняет запись GEDCOM человека или семьи — ту самую, что пришла из файла, со всеми тегами,
которых приложение не понимает. Таблицы людей, семей, событий и связей между ними пересобираются
из записи. Поэтому экспорт ничего не теряет, а журналу достаточно хранить запись «до» и «после»:
откат ставит «до», повтор — «после». Связки с другими родами живут вне записей и сохраняются отдельно,
когда правка удаляет человека.
"""

from __future__ import annotations

import json
import re
import sqlite3
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from pydantic import BaseModel

from app.db.clans import _insert_event
from app.gedcom.convert import FAMILY_EVENT_TAGS, _event, _family, _person
from app.gedcom.records import Record


class ChangeInfo(BaseModel):
    id: int
    summary: str
    created_at: str
    undone: bool
    persons: list[int]
    reverts: int | None


class JournalError(ValueError):
    pass


class RevertConflictError(JournalError):
    """После этой правки запись меняли ещё раз — молча перетирать нельзя."""


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def _dump(record: Record | None) -> Any:
    return record.to_json() if record else None


def _load(data: Any) -> Record:
    return Record.from_json(data)


@dataclass
class _Touched:
    kind: str  # INDI, FAM
    id: int
    xref: str
    before: Any
    record: Record | None  # что станет «после»; None — запись удалена


@dataclass
class Edit:
    """Одна правка: собирает затронутые записи, в конце пишет их и строку журнала."""

    conn: sqlite3.Connection
    clan_id: int
    summary: str = ""
    persons: set[int] = field(default_factory=set)
    touched: dict[tuple[str, int], _Touched] = field(default_factory=dict)
    links: list[dict[str, Any]] = field(default_factory=list)  # связки удалённых людей — вернуть при откате

    # ── доступ к записям ──
    def person(self, person_id: int) -> Record:
        return self._get("INDI", person_id)

    def family(self, family_id: int) -> Record:
        return self._get("FAM", family_id)

    def _get(self, kind: str, row_id: int) -> Record:
        key = (kind, row_id)
        if key not in self.touched:
            table = "persons" if kind == "INDI" else "families"
            row = self.conn.execute(f"SELECT xref, raw, clan_id FROM {table} WHERE id = ?", (row_id,)).fetchone()
            if row is None or row["clan_id"] != self.clan_id:
                raise JournalError("Такой записи в роду нет")
            data = json.loads(row["raw"])
            self.touched[key] = _Touched(kind, row_id, row["xref"], data, _load(data))
        record = self.touched[key].record
        if record is None:
            raise JournalError("Запись уже удалена этой правкой")
        return record

    def new_person(self) -> tuple[int, Record]:
        return self._new("INDI", "persons", "I")

    def new_family(self) -> tuple[int, Record]:
        return self._new("FAM", "families", "F")

    def _new(self, kind: str, table: str, letter: str) -> tuple[int, Record]:
        # номер берётся с запасом: свежие записи этой же правки ещё не в базе
        taken = [row[0] for row in self.conn.execute(f"SELECT xref FROM {table} WHERE clan_id = ?", (self.clan_id,))]
        taken += [t.xref for t in self.touched.values() if t.kind == kind]
        numbers = [int(m.group(1)) for x in taken if (m := re.fullmatch(rf"@{letter}(\d+)@", x))]
        xref = f"@{letter}{max(numbers, default=0) + 1}@"
        top = self.conn.execute(f"SELECT COALESCE(MAX(id), 0) FROM {table}").fetchone()[0]
        mine = [t.id for t in self.touched.values() if t.kind == kind]
        row_id = max([top, *mine]) + 1
        record = Record(level=0, tag=kind, xref=xref)
        self.touched[(kind, row_id)] = _Touched(kind, row_id, xref, None, record)
        return row_id, record

    def drop(self, kind: str, row_id: int) -> None:
        self._get(kind, row_id)
        self.touched[(kind, row_id)].record = None

    def xref_of(self, kind: str, row_id: int) -> str:
        if (kind, row_id) in self.touched:
            return self.touched[(kind, row_id)].xref
        table = "persons" if kind == "INDI" else "families"
        return self.conn.execute(f"SELECT xref FROM {table} WHERE id = ?", (row_id,)).fetchone()[0]

    # ── запись ──
    def commit(self) -> ChangeInfo:
        if not self.touched:
            raise JournalError("Нечего сохранять")
        records = [{"k": t.kind, "id": t.id, "x": t.xref, "b": t.before, "a": _dump(t.record)}
                   for t in self.touched.values() if t.before != _dump(t.record)]
        if not records and not self.links:
            raise JournalError("Ничего не изменилось")
        for t in self.touched.values():
            if t.kind == "INDI":
                self.persons.add(t.id)
        with self.conn:
            # новая правка отрезает всё отменённое: история линейна
            self.conn.execute("DELETE FROM changes WHERE clan_id = ? AND undone = 1", (self.clan_id,))
            apply_records(self.conn, self.clan_id, records, "a")
            if self.links:
                records.append({"k": "LINKS", "b": self.links, "a": None})
            cursor = self.conn.execute(
                "INSERT INTO changes (clan_id, summary, created_at, records) VALUES (?, ?, ?, ?)",
                (self.clan_id, self.summary, _now(), json.dumps(records, ensure_ascii=False, separators=(",", ":"))),
            )
            change_id = cursor.lastrowid or 0
            self.conn.executemany("INSERT OR IGNORE INTO change_persons (change_id, person_id) VALUES (?, ?)",
                                  [(change_id, pid) for pid in sorted(self.persons)])
        return change_info(self.conn, change_id)


# ── пересборка таблиц из записей ──

def _json(record: Record) -> str:
    return json.dumps(record.to_json(), ensure_ascii=False, separators=(",", ":"))


def apply_records(conn: sqlite3.Connection, clan_id: int, records: list[dict[str, Any]], side: str) -> None:
    """Поставить записи в состояние side («b» или «a») и пересобрать из них таблицы. Без своей транзакции."""
    persons = [r for r in records if r.get("k") == "INDI"]
    families = [r for r in records if r.get("k") == "FAM"]
    # сначала строки, потом связи между ними: связи ссылаются на номера людей и семей
    for r in persons:
        _put_row(conn, clan_id, "persons", r, r[side])
    for r in families:
        _put_row(conn, clan_id, "families", r, r[side])
    xrefs = _xrefs(conn, clan_id)
    for r in persons:
        if r[side] is not None:
            _sync_person(conn, r["id"], _load(r[side]), xrefs)
    touched_families = {r["id"] for r in families if r[side] is not None}
    # у ребёнка тип родства (PEDI) живёт в его записи — семьи, куда он входит, тоже пересобираются
    for r in persons:
        if r[side] is not None:
            touched_families.update(xrefs["FAM"].get(link.value or "", 0) for link in _load(r[side]).all("FAMC"))
    touched_families.discard(0)
    for family_id in touched_families:
        raw = conn.execute("SELECT raw FROM families WHERE id = ?", (family_id,)).fetchone()
        if raw is not None:
            _sync_family(conn, family_id, _load(json.loads(raw[0])), xrefs)
    for r in records:
        if r.get("k") == "LINKS" and side == "b":
            for link in r["b"]:
                conn.execute(
                    """INSERT OR IGNORE INTO person_links (id, a_person_id, b_person_id, note, visibility, created_by, created_at)
                       VALUES (:id, :a_person_id, :b_person_id, :note, :visibility, :created_by, :created_at)""", link)


def _put_row(conn: sqlite3.Connection, clan_id: int, table: str, r: dict[str, Any], data: Any) -> None:
    if data is None:
        conn.execute(f"DELETE FROM {table} WHERE id = ?", (r["id"],))
        return
    record = _load(data)
    exists = conn.execute(f"SELECT 1 FROM {table} WHERE id = ?", (r["id"],)).fetchone()
    if table == "persons":
        p = _person(record)
        values = (p.xref, p.uid, p.name_raw, p.given, p.surname, p.married_surname, p.sex, int(p.is_branch_stub),
                  _json(record))
        if exists:
            conn.execute("""UPDATE persons SET xref = ?, uid = ?, name_raw = ?, given = ?, surname = ?, married_surname = ?,
                            sex = ?, is_branch_stub = ?, raw = ? WHERE id = ?""", (*values, r["id"]))
        else:
            conn.execute("""INSERT INTO persons (xref, uid, name_raw, given, surname, married_surname, sex, is_branch_stub,
                            raw, id, clan_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""", (*values, r["id"], clan_id))
    else:
        f = _family(record)
        if exists:
            conn.execute("UPDATE families SET xref = ?, uid = ?, raw = ? WHERE id = ?", (f.xref, f.uid, _json(record), r["id"]))
        else:
            conn.execute("INSERT INTO families (id, clan_id, xref, uid, raw) VALUES (?, ?, ?, ?, ?)",
                         (r["id"], clan_id, f.xref, f.uid, _json(record)))


def _xrefs(conn: sqlite3.Connection, clan_id: int) -> dict[str, dict[str, int]]:
    return {
        "INDI": {row[0]: row[1] for row in conn.execute("SELECT xref, id FROM persons WHERE clan_id = ?", (clan_id,))},
        "FAM": {row[0]: row[1] for row in conn.execute("SELECT xref, id FROM families WHERE clan_id = ?", (clan_id,))},
    }


def _sync_person(conn: sqlite3.Connection, person_id: int, record: Record, xrefs: dict[str, dict[str, int]]) -> None:
    person = _person(record)
    conn.execute("DELETE FROM events WHERE person_id = ?", (person_id,))
    for position, event in enumerate(person.events):
        _insert_event(conn, "person_id", person_id, position, event)
    conn.execute("DELETE FROM spouse_families WHERE person_id = ?", (person_id,))
    for position, xref in enumerate(person.spouse_families):
        if xref in xrefs["FAM"]:
            conn.execute("INSERT OR IGNORE INTO spouse_families (person_id, family_id, position) VALUES (?, ?, ?)",
                         (person_id, xrefs["FAM"][xref], position))


def _sync_family(conn: sqlite3.Connection, family_id: int, record: Record, xrefs: dict[str, dict[str, int]]) -> None:
    family = _family(record)
    conn.execute("UPDATE families SET husband_id = ?, wife_id = ? WHERE id = ?",
                 (xrefs["INDI"].get(family.husband or ""), xrefs["INDI"].get(family.wife or ""), family_id))
    conn.execute("DELETE FROM events WHERE family_id = ?", (family_id,))
    for position, child in enumerate(c for c in record.children if c.tag in FAMILY_EVENT_TAGS):
        _insert_event(conn, "family_id", family_id, position, _event(child))
    conn.execute("DELETE FROM family_children WHERE family_id = ?", (family_id,))
    for position, xref in enumerate(family.children):
        child_id = xrefs["INDI"].get(xref)
        if child_id is None:
            continue
        raw = conn.execute("SELECT raw FROM persons WHERE id = ?", (child_id,)).fetchone()[0]
        pedigree = next((link.pedigree for link in _person(_load(json.loads(raw))).parent_families
                         if link.family == record.xref), None)
        conn.execute("INSERT INTO family_children (family_id, person_id, position, pedigree) VALUES (?, ?, ?, ?)",
                     (family_id, child_id, position, pedigree))


# ── журнал: список, откат, повтор, «вернуть» ──

def change_info(conn: sqlite3.Connection, change_id: int) -> ChangeInfo:
    row = conn.execute("SELECT * FROM changes WHERE id = ?", (change_id,)).fetchone()
    if row is None:
        raise JournalError("Такой правки нет")
    persons = [r[0] for r in conn.execute("SELECT person_id FROM change_persons WHERE change_id = ?", (change_id,))]
    return ChangeInfo(id=row["id"], summary=row["summary"], created_at=row["created_at"], undone=bool(row["undone"]),
                      persons=persons, reverts=row["reverts"])


def clan_changes(conn: sqlite3.Connection, clan_id: int, limit: int = 200) -> list[ChangeInfo]:
    return [change_info(conn, row[0]) for row in
            conn.execute("SELECT id FROM changes WHERE clan_id = ? ORDER BY id DESC LIMIT ?", (clan_id, limit))]


def person_changes(conn: sqlite3.Connection, person_id: int) -> list[ChangeInfo]:
    return [change_info(conn, row[0]) for row in conn.execute(
        """SELECT c.id FROM changes c JOIN change_persons cp ON cp.change_id = c.id
            WHERE cp.person_id = ? AND c.undone = 0 ORDER BY c.id DESC""", (person_id,))]


def _records(conn: sqlite3.Connection, change_id: int) -> tuple[int, list[dict[str, Any]]]:
    row = conn.execute("SELECT clan_id, records FROM changes WHERE id = ?", (change_id,)).fetchone()
    if row is None:
        raise JournalError("Такой правки нет")
    return row["clan_id"], json.loads(row["records"])


def undo(conn: sqlite3.Connection, clan_id: int) -> ChangeInfo | None:
    """Отменить последнюю действующую правку рода."""
    row = conn.execute("SELECT id FROM changes WHERE clan_id = ? AND undone = 0 ORDER BY id DESC LIMIT 1",
                       (clan_id,)).fetchone()
    if row is None:
        return None
    _, records = _records(conn, row[0])
    with conn:
        apply_records(conn, clan_id, list(reversed(records)), "b")
        conn.execute("UPDATE changes SET undone = 1 WHERE id = ?", (row[0],))
    return change_info(conn, row[0])


def redo(conn: sqlite3.Connection, clan_id: int) -> ChangeInfo | None:
    """Повторить самую раннюю отменённую правку — отменённые всегда хвост истории."""
    row = conn.execute("SELECT id FROM changes WHERE clan_id = ? AND undone = 1 ORDER BY id LIMIT 1",
                       (clan_id,)).fetchone()
    if row is None:
        return None
    _, records = _records(conn, row[0])
    with conn:
        apply_records(conn, clan_id, [r for r in records if r.get("k") != "LINKS"], "a")
        _drop_links(conn, records)
        conn.execute("UPDATE changes SET undone = 0 WHERE id = ?", (row[0],))
    return change_info(conn, row[0])


def _drop_links(conn: sqlite3.Connection, records: list[dict[str, Any]]) -> None:
    for r in records:
        if r.get("k") == "LINKS":
            conn.executemany("DELETE FROM person_links WHERE id = ?", [(link["id"],) for link in r["b"]])


def undo_to(conn: sqlite3.Connection, change_id: int) -> list[ChangeInfo]:
    """Отменить эту правку и всё, что сделано после неё."""
    clan_id, _ = _records(conn, change_id)
    done: list[ChangeInfo] = []
    while True:
        row = conn.execute("SELECT id FROM changes WHERE clan_id = ? AND undone = 0 ORDER BY id DESC LIMIT 1",
                           (clan_id,)).fetchone()
        if row is None or row[0] < change_id:
            return done
        change = undo(conn, clan_id)
        if change:
            done.append(change)


def revert(conn: sqlite3.Connection, change_id: int) -> ChangeInfo:
    """«Вернуть» из истории человека: поставить записи в их состояние до этой правки — новой правкой.
    Если после неё запись меняли ещё раз, молча не перетираем."""
    clan_id, records = _records(conn, change_id)
    summary = conn.execute("SELECT summary FROM changes WHERE id = ?", (change_id,)).fetchone()[0]
    edit = Edit(conn, clan_id, summary=f"Вернуть: {summary}")
    for r in records:
        if r.get("k") not in ("INDI", "FAM"):
            continue
        table = "persons" if r["k"] == "INDI" else "families"
        row = conn.execute(f"SELECT raw FROM {table} WHERE id = ?", (r["id"],)).fetchone()
        now = json.loads(row[0]) if row else None
        if now != r["a"]:
            raise RevertConflictError("После этой правки запись меняли ещё раз — верните через общий журнал")
        if r["a"] is None:  # запись удаляли — вернуть её целиком
            edit.touched[(r["k"], r["id"])] = _Touched(r["k"], r["id"], r["x"], None, _load(r["b"]))
        elif r["b"] is None:  # запись создавали — убрать
            edit._get(r["k"], r["id"])
            edit.touched[(r["k"], r["id"])].record = None
        else:
            edit._get(r["k"], r["id"])
            edit.touched[(r["k"], r["id"])].record = _load(r["b"])
    info = edit.commit()
    for r in records:
        if r.get("k") == "LINKS":
            with conn:
                apply_records(conn, clan_id, [r], "b")
    with conn:
        conn.execute("UPDATE changes SET reverts = ? WHERE id = ?", (change_id, info.id))
    return change_info(conn, info.id)
