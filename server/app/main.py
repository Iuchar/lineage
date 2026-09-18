"""Один процесс отдаёт и API, и собранный интерфейс."""

import sqlite3
from collections.abc import Iterator
from typing import Annotated

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from app import uploads
from app.config import DB_PATH, DIST
from app.db.clans import ClanExistsError, import_clan
from app.db.connection import connect
from app.db.editor import (Created, DeletePreview, EditError, NewPerson, PersonFields, PersonForm, add_person,
                           delete_person, delete_preview, person_form, update_person)
from app.db.journal import (ChangeInfo, JournalError, RevertConflictError, clan_changes, person_changes, redo, revert,
                            undo, undo_to)
from app.gedcom.ru_dates import DateInputError, parse_input
from app.db.links import (Candidate, ClanLink, Link, LinkClashError, LinkError, LinkNotFoundError, LinkPerson,
                          candidates, clan_links, create_link, delete_link, list_links, reject_pair, search_persons)
from app.db.person import PersonDetails, PersonNotFoundError, person_details
from app.db.reload import ClanMatch, ReloadPreview, ReloadReport, clan_matches, preview_reload, reload_clan, suggested_name
from app.db.tree import ClanNotFoundError, ClanSummary, ClanTree, clan_tree, list_clans
from app.gedcom.load import load_text
from app.gedcom.records import GedcomSyntaxError

app = FastAPI(
    title="Родословные",
    docs_url="/api/docs",
    openapi_url="/api/openapi.json",
    redoc_url=None,
)


def database() -> Iterator[sqlite3.Connection]:
    conn = connect(DB_PATH)
    try:
        yield conn
    finally:
        conn.close()


Database = Annotated[sqlite3.Connection, Depends(database)]


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/clans")
def get_clans(conn: Database) -> list[ClanSummary]:
    return list_clans(conn)


@app.get("/api/clans/{clan_id}/tree")
def get_clan_tree(clan_id: int, conn: Database) -> ClanTree:
    try:
        return clan_tree(conn, clan_id)
    except ClanNotFoundError:
        raise HTTPException(status_code=404, detail="Такого рода нет") from None


@app.get("/api/persons/{person_id}")
def get_person(person_id: int, conn: Database) -> PersonDetails:
    try:
        return person_details(conn, person_id)
    except PersonNotFoundError:
        raise HTTPException(status_code=404, detail="Такого человека нет") from None


@app.get("/api/persons")
def find_persons(q: str, conn: Database, exclude_clan: int | None = None) -> list[LinkPerson]:
    """Поиск по всем родам — для ручной связки."""
    return search_persons(conn, q, exclude_clan)


@app.get("/api/clans/{clan_id}/links")
def get_clan_links(clan_id: int, conn: Database) -> list[ClanLink]:
    return clan_links(conn, clan_id)


class NewLink(BaseModel):
    a: int
    b: int
    note: str | None = None
    replace: bool = False  # у человека в том роду уже есть двойник — снять старую связку и поставить эту


class PairDecision(BaseModel):
    a: int
    b: int


@app.get("/api/links")
def get_links(conn: Database) -> list[Link]:
    return list_links(conn)


@app.get("/api/links/candidates")
def get_candidates(conn: Database) -> list[Candidate]:
    return candidates(conn)


@app.post("/api/links")
def post_link(body: NewLink, conn: Database) -> Link:
    try:
        return create_link(conn, body.a, body.b, body.note, body.replace)
    except LinkClashError as error:
        raise HTTPException(status_code=409, detail=str(error)) from None
    except LinkError as error:
        raise HTTPException(status_code=400, detail=str(error)) from None


@app.delete("/api/links/{link_id}", status_code=204)
def remove_link(link_id: int, conn: Database) -> None:
    try:
        delete_link(conn, link_id)
    except LinkNotFoundError:
        raise HTTPException(status_code=404, detail="Такой связки нет") from None


@app.post("/api/links/reject", status_code=204)
def post_reject(body: PairDecision, conn: Database) -> None:
    try:
        reject_pair(conn, body.a, body.b)
    except LinkError as error:
        raise HTTPException(status_code=400, detail=str(error)) from None


# ── редактор: даты, форма человека, правка, добавление, удаление, журнал ──

class ParsedDate(BaseModel):
    gedcom: str | None
    ru: str
    kind: str


@app.get("/api/dates/parse")
def get_parsed_date(text: str = "") -> ParsedDate:
    """Как поле даты поняло набранное — для подсказки на лету. Непонятное — 400 с причиной."""
    try:
        parsed = parse_input(text)
    except DateInputError as error:
        raise HTTPException(status_code=400, detail=str(error)) from None
    return ParsedDate(gedcom=parsed.gedcom, ru=parsed.ru, kind=parsed.kind)


def _edit_errors(error: Exception) -> HTTPException:
    if isinstance(error, RevertConflictError):
        return HTTPException(status_code=409, detail=str(error))
    return HTTPException(status_code=400, detail=str(error))


@app.get("/api/persons/{person_id}/form")
def get_person_form(person_id: int, conn: Database) -> PersonForm:
    try:
        return person_form(conn, person_id)
    except EditError as error:
        raise HTTPException(status_code=404, detail=str(error)) from None


@app.put("/api/persons/{person_id}")
def put_person(person_id: int, body: PersonFields, conn: Database) -> ChangeInfo:
    try:
        return update_person(conn, person_id, body)
    except (EditError, JournalError) as error:
        raise _edit_errors(error) from None


@app.post("/api/clans/{clan_id}/persons")
def post_person(clan_id: int, body: NewPerson, conn: Database) -> Created:
    try:
        return add_person(conn, clan_id, body)
    except (EditError, JournalError) as error:
        raise _edit_errors(error) from None


@app.get("/api/persons/{person_id}/delete-preview")
def get_delete_preview(person_id: int, conn: Database) -> DeletePreview:
    try:
        return delete_preview(conn, person_id)
    except EditError as error:
        raise HTTPException(status_code=404, detail=str(error)) from None


@app.delete("/api/persons/{person_id}")
def remove_person(person_id: int, conn: Database, branch: bool = False) -> ChangeInfo:
    try:
        return delete_person(conn, person_id, branch)
    except (EditError, JournalError) as error:
        raise _edit_errors(error) from None


@app.get("/api/clans/{clan_id}/changes")
def get_clan_changes(clan_id: int, conn: Database) -> list[ChangeInfo]:
    return clan_changes(conn, clan_id)


@app.get("/api/persons/{person_id}/changes")
def get_person_changes(person_id: int, conn: Database) -> list[ChangeInfo]:
    return person_changes(conn, person_id)


@app.post("/api/clans/{clan_id}/undo")
def post_undo(clan_id: int, conn: Database) -> ChangeInfo | None:
    return undo(conn, clan_id)


@app.post("/api/clans/{clan_id}/redo")
def post_redo(clan_id: int, conn: Database) -> ChangeInfo | None:
    return redo(conn, clan_id)


@app.post("/api/changes/{change_id}/undo-to")
def post_undo_to(change_id: int, conn: Database) -> list[ChangeInfo]:
    try:
        return undo_to(conn, change_id)
    except JournalError as error:
        raise _edit_errors(error) from None


@app.post("/api/changes/{change_id}/revert")
def post_revert(change_id: int, conn: Database) -> ChangeInfo:
    try:
        return revert(conn, change_id)
    except (EditError, JournalError) as error:
        raise _edit_errors(error) from None


MAX_UPLOAD = 20 * 1024 * 1024


class UploadInfo(BaseModel):
    token: str
    file_name: str
    persons: int
    families: int
    branch_stubs: int
    warnings: list[str]
    suggested_name: str
    clans: list[ClanMatch]


class NewClan(BaseModel):
    name: str


class ReloadRequest(BaseModel):
    delete: list[int] = []  # кого из пропавших в файле удалить; остальные остаются


def _upload(token: str) -> uploads.Upload:
    upload = uploads.get(token)
    if upload is None:
        raise HTTPException(status_code=404, detail="Файл больше не ждёт заливки — загрузите его заново")
    return upload


@app.post("/api/uploads")
async def post_upload(request: Request, conn: Database, file_name: str = "файл.ged") -> UploadInfo:
    body = await request.body()
    if len(body) > MAX_UPLOAD:
        raise HTTPException(status_code=413, detail="Файл больше 20 МБ")
    try:
        data = load_text(body.decode("utf-8-sig"))
    except UnicodeDecodeError:
        raise HTTPException(status_code=400, detail="Файл не в UTF-8 — такие пока не читаются") from None
    except GedcomSyntaxError as error:
        raise HTTPException(status_code=400, detail=f"Не похоже на GEDCOM: {error}") from None
    if not data.persons:
        raise HTTPException(status_code=400, detail="В файле нет ни одного человека")
    return UploadInfo(
        token=uploads.put(file_name, data), file_name=file_name,
        persons=len(data.persons), families=len(data.families),
        branch_stubs=sum(p.is_branch_stub for p in data.persons.values()),
        warnings=data.warnings, suggested_name=suggested_name(data), clans=clan_matches(conn, data),
    )


@app.post("/api/uploads/{token}/clan")
def post_new_clan(token: str, body: NewClan, conn: Database) -> ClanSummary:
    upload = _upload(token)
    try:
        report = import_clan(conn, body.name, upload.data, upload.file_name)
    except ClanExistsError as error:
        raise HTTPException(status_code=409, detail=str(error)) from None
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from None
    uploads.drop(token)
    return next(c for c in list_clans(conn) if c.id == report.clan_id)


@app.get("/api/uploads/{token}/reload/{clan_id}")
def get_reload_preview(token: str, clan_id: int, conn: Database) -> ReloadPreview:
    upload = _upload(token)
    try:
        return preview_reload(conn, clan_id, upload.data)
    except ClanNotFoundError:
        raise HTTPException(status_code=404, detail="Такого рода нет") from None


@app.post("/api/uploads/{token}/reload/{clan_id}")
def post_reload(token: str, clan_id: int, body: ReloadRequest, conn: Database) -> ReloadReport:
    upload = _upload(token)
    try:
        report = reload_clan(conn, clan_id, upload.data, set(body.delete), upload.file_name)
    except ClanNotFoundError:
        raise HTTPException(status_code=404, detail="Такого рода нет") from None
    uploads.drop(token)
    return report


if (DIST / "assets").is_dir():
    app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")


@app.api_route("/{path:path}", methods=["GET", "HEAD"], include_in_schema=False, response_model=None)
def interface(path: str) -> FileResponse | PlainTextResponse:
    # неизвестный адрес API или несуществующий файл — честная ошибка, а не страница интерфейса
    if path == "api" or path.startswith("api/"):
        raise HTTPException(status_code=404)
    if "." in path.rsplit("/", 1)[-1]:
        raise HTTPException(status_code=404)
    index = DIST / "index.html"
    if not index.exists():
        return PlainTextResponse(
            "Интерфейс не собран. Запустите приложение командой rodoslovnye.",
            status_code=503,
        )
    return FileResponse(index)
