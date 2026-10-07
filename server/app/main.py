"""Один процесс отдаёт и API, и собранный интерфейс."""

import json
import sqlite3
from collections.abc import Callable, Iterator
from typing import Annotated
from urllib.parse import quote

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.openapi.docs import get_swagger_ui_html
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, PlainTextResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from app import uploads
from app.config import DB_PATH, DIST
from app.db.access import AccessError, Editor, TooManyTries, editor_by_key, editors_exist, login, logout
from app.db.author import set_author
from app.db.clans import ClanExistsError, import_clan
from app.db.connection import connect
from app.db.editor import (
    Created,
    DeletePreview,
    EditError,
    NewPerson,
    PersonFields,
    PersonForm,
    add_person,
    delete_person,
    delete_preview,
    person_form,
    update_person,
)
from app.db.eyes import Eyes, sift, sift_family, sift_links, sift_person
from app.db.journal import ChangeInfo, JournalError, RevertConflictError, clan_changes, person_changes, redo, revert, undo, undo_to
from app.db.kin import FamilyFields, FamilyForm, KinError, family_form, update_family
from app.db.links import (
    Candidate,
    ClanLink,
    Link,
    LinkClashError,
    LinkError,
    LinkNotFoundError,
    LinkPerson,
    candidates,
    clan_links,
    create_link,
    delete_link,
    list_links,
    reject_pair,
    search_persons,
    set_link_see,
)
from app.db.newclan import ClanStart, NewClanError, start_clan
from app.db.person import PersonDetails, PersonNotFoundError, person_details
from app.db.photos import photo_path, remove_photo, save_photo
from app.db.reload import ClanMatch, ReloadPreview, ReloadReport, clan_matches, preview_reload, reload_clan, suggested_name
from app.db.share import DEFAULT_TERM, ShareError, ShareLink, enter, issue, link_of, revoke, viewer_access, viewer_clans
from app.db.tagset import TagChange, TagError, delete_tag, set_status, tag_usage, update_tag
from app.db.tree import ClanNotFoundError, ClanSummary, ClanTree, clan_tree, list_clans
from app.gedcom.export import ExportError, export_clan
from app.gedcom.load import load_text
from app.gedcom.meta import See, read_meta
from app.gedcom.records import GedcomSyntaxError, Record
from app.gedcom.ru_dates import DateInputError, parse_input

# Описание API встроенное мы выключаем и раздаём своё: оно показывает всю поверхность приложения
# разом, и постороннему это ни к чему. Адреса прежние, только за входом редактора.
app = FastAPI(
    title="Родословные",
    docs_url=None,
    openapi_url=None,
    redoc_url=None,
)


def database() -> Iterator[sqlite3.Connection]:
    conn = connect(DB_PATH)
    try:
        yield conn
    finally:
        conn.close()


Database = Annotated[sqlite3.Connection, Depends(database)]

SESSION_COOKIE = "rodoslovnye_editor"
VIEWER_COOKIE = "rodoslovnye_viewer"
VIEWER_DAYS = 365
# вход и проверка себя открыты всем: иначе войти было бы нечем
OPEN_PATHS = {"/api/login", "/api/logout", "/api/me"}


def _encrypted(request: Request) -> bool:
    """Шифрованное ли соединение. За обратным прокси схема у приложения всегда http, а снаружи https —
    про это говорит заголовок, который прокси подставляет (uvicorn читает его с --proxy-headers)."""
    forwarded = request.headers.get("x-forwarded-proto", "").split(",")[0].strip().lower()
    return (forwarded or request.url.scheme) == "https"


def _current_editor(conn: sqlite3.Connection, request: Request) -> Editor | None:
    return editor_by_key(conn, request.cookies.get(SESSION_COOKIE))


def only_editor(conn: Database, request: Request) -> None:
    """Маршрут не для чужих глаз. Пока ни одного редактора не заведено, правка открыта — тогда открыто и это."""
    if editors_exist(conn) and _current_editor(conn, request) is None:
        raise HTTPException(status_code=401, detail="Нужен вход редактора")


def _is_hidden(conn: sqlite3.Connection, clan_id: int, eyes: Eyes) -> Callable[[int], bool]:
    """Кого этим глазам видеть не положено. Уровень лежит в самой записи, поэтому читаем её, а не колонку."""
    def hidden(person_id: int) -> bool:
        row = conn.execute("SELECT raw FROM persons WHERE id = ?", (person_id,)).fetchone()
        if row is None:
            return False
        return not eyes.allows(read_meta(Record.from_json(json.loads(row["raw"]))).see, clan_id)

    return hidden


def _eyes(conn: sqlite3.Connection, request: Request, as_viewer: int | None = None) -> Eyes:
    """Чьими глазами смотрят: редактор видит всё, зритель — общий слой и свои роды по ссылкам.

    as_viewer — редактор смотрит чужими глазами. N — «родовой зритель рода N»: ровно то, что увидит
    приглашённый по ссылке этого рода. 0 — «общий зритель»: тот, кто открыл сайт без всякой ссылки.
    """
    editor = not editors_exist(conn) or _current_editor(conn, request) is not None
    if editor and as_viewer is not None:
        return Eyes(editor=False, clans=frozenset({as_viewer}) if as_viewer else frozenset())
    if editor:
        return Eyes(editor=True)
    return Eyes(editor=False, clans=frozenset(viewer_clans(conn, request.cookies.get(VIEWER_COOKIE))))


@app.middleware("http")
async def guard_edits(request: Request, call_next):  # type: ignore[no-untyped-def]
    """Пока заведён хотя бы один редактор, менять данные может только вошедший."""
    path = request.url.path
    set_author(None)
    if request.method in {"POST", "PUT", "PATCH", "DELETE"} and path.startswith("/api/") and path not in OPEN_PATHS:
        conn = connect(DB_PATH)
        try:
            editor = _current_editor(conn, request)
            if editors_exist(conn) and editor is None:
                return JSONResponse({"detail": "Нужен вход редактора"}, status_code=401)
            set_author(editor.name if editor else None)
        finally:
            conn.close()
    return await call_next(request)


class ClanAccess(BaseModel):
    clan_id: int
    until: str  # до какого момента действует доступ по ссылке


class Me(BaseModel):
    name: str | None = None  # имя вошедшего редактора; null — не вошёл
    guarded: bool  # заведён ли хоть один редактор: пока нет, правка открыта всем
    clans: list[int] = []  # роды, для которых предъявитель ссылки свой
    access: list[ClanAccess] = []  # те же роды со сроком: гость должен видеть, до какого дня он свой


class LoginForm(BaseModel):
    name: str
    password: str


@app.get("/api/me")
def get_me(conn: Database, request: Request) -> Me:
    editor = _current_editor(conn, request)
    access = viewer_access(conn, request.cookies.get(VIEWER_COOKIE))
    return Me(
        name=editor.name if editor else None,
        guarded=editors_exist(conn),
        clans=[a.clan_id for a in access],
        access=[ClanAccess(clan_id=a.clan_id, until=a.until) for a in access],
    )


@app.post("/api/login")
def post_login(conn: Database, body: LoginForm, request: Request, response: Response) -> Me:
    try:
        key = login(conn, body.name, body.password)
    except TooManyTries as error:
        # 429 с Retry-After: страница показывает, сколько ждать, а не повторяет «пароль не тот»
        raise HTTPException(status_code=429, detail=str(error),
                            headers={"Retry-After": str(error.seconds)}) from None
    except AccessError as error:
        raise HTTPException(status_code=401, detail=str(error)) from None
    # без срока жизни: вход держится, пока открыт браузер, и кончается вместе с ним.
    # secure — только по https: на открытом соединении браузер отказался бы хранить cookie,
    # и приложение перестало бы работать на localhost и в домашней сети
    response.set_cookie(SESSION_COOKIE, key, httponly=True, samesite="lax", path="/",
                        secure=_encrypted(request))
    return Me(name=body.name.strip(), guarded=True)


@app.post("/api/logout")
def post_logout(conn: Database, request: Request, response: Response) -> Me:
    key = request.cookies.get(SESSION_COOKIE)
    if key:
        logout(conn, key)
    response.delete_cookie(SESSION_COOKIE, path="/")
    return Me(name=None, guarded=editors_exist(conn), clans=viewer_clans(conn, request.cookies.get(VIEWER_COOKIE)))


class ShareInfo(BaseModel):
    """Ссылка зрителям на род: адрес показывается редактору целиком, чтобы его можно было отдать."""

    url: str
    created_at: str
    opened: int
    opened_at: str | None = None
    expires_at: str  # до какого момента ссылка открывается


class ShareTerm(BaseModel):
    days: int = DEFAULT_TERM  # на сколько дней выпустить: 30, 90, 180 или 365


def _share(request: Request, link: ShareLink) -> ShareInfo:
    base = str(request.base_url).rstrip("/")
    return ShareInfo(url=f"{base}/r/{link.key}", created_at=link.created_at,
                     opened=link.opened, opened_at=link.opened_at, expires_at=link.expires_at)


@app.get("/api/clans/{clan_id}/link", dependencies=[Depends(only_editor)])
def get_share_link(clan_id: int, conn: Database, request: Request) -> ShareInfo | None:
    """Только редактору: ссылка — это и есть доступ к роду, кто её прочитал, тот и вошёл."""
    link = link_of(conn, clan_id)
    return _share(request, link) if link else None


@app.post("/api/clans/{clan_id}/link")
def post_share_link(clan_id: int, conn: Database, request: Request, body: ShareTerm | None = None) -> ShareInfo:
    """Выпускает ссылку заново на выбранный срок: прежняя перестаёт работать."""
    try:
        return _share(request, issue(conn, clan_id, body.days if body else DEFAULT_TERM))
    except ShareError as error:
        raise HTTPException(status_code=404 if "рода" in str(error) else 400, detail=str(error)) from None


@app.delete("/api/clans/{clan_id}/link")
def delete_share_link(clan_id: int, conn: Database) -> dict[str, bool]:
    """Отзывает ссылку: род закрывается и для тех, кто по ней уже приходил."""
    revoke(conn, clan_id)
    return {"ok": True}


@app.get("/r/{key}", include_in_schema=False)
def open_share_link(key: str, conn: Database, request: Request) -> RedirectResponse:
    """Зритель открыл ссылку: род становится для него своим, дальше он видит обычную страницу."""
    try:
        session, _clan_id = enter(conn, key, request.cookies.get(VIEWER_COOKIE))
    except ShareError:
        return RedirectResponse("/?ссылка=нет", status_code=303)
    answer = RedirectResponse("/", status_code=303)
    answer.set_cookie(
        VIEWER_COOKIE, session, max_age=VIEWER_DAYS * 24 * 3600,
        httponly=True, samesite="lax", path="/", secure=_encrypted(request),
    )
    return answer


@app.get("/api/openapi.json", include_in_schema=False, dependencies=[Depends(only_editor)])
def get_openapi_schema() -> JSONResponse:
    return JSONResponse(app.openapi())


@app.get("/api/docs", include_in_schema=False, dependencies=[Depends(only_editor)])
def get_docs() -> HTMLResponse:
    return get_swagger_ui_html(openapi_url="/api/openapi.json", title="Родословные — описание API")


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/clans")
def get_clans(conn: Database) -> list[ClanSummary]:
    return list_clans(conn)


@app.get("/api/clans/{clan_id}/tree")
def get_clan_tree(clan_id: int, conn: Database, request: Request, as_viewer: int | None = None) -> ClanTree:
    try:
        return sift(clan_tree(conn, clan_id), _eyes(conn, request, as_viewer))
    except ClanNotFoundError:
        raise HTTPException(status_code=404, detail="Такого рода нет") from None


@app.get("/api/persons/{person_id}")
def get_person(person_id: int, conn: Database, request: Request, as_viewer: int | None = None) -> PersonDetails:
    try:
        details = person_details(conn, person_id)
    except PersonNotFoundError:
        raise HTTPException(status_code=404, detail="Такого человека нет") from None
    eyes = _eyes(conn, request, as_viewer)
    # скрытого нет в дереве зрителя — нет его и по номеру: номера идут подряд и перебираются.
    # Ответ тот же, что на несуществующего, чтобы «скрыт» не отличался от «нет такого»
    if _is_hidden(conn, details.clan_id, eyes)(person_id):
        raise HTTPException(status_code=404, detail="Такого человека нет")
    return sift_person(details, eyes)


@app.get("/api/persons", dependencies=[Depends(only_editor)])
def find_persons(q: str, conn: Database, exclude_clan: int | None = None) -> list[LinkPerson]:
    """Поиск по всем родам — для ручной связки."""
    return search_persons(conn, q, exclude_clan)


@app.get("/api/clans/{clan_id}/links")
def get_clan_links(clan_id: int, conn: Database, request: Request, as_viewer: int | None = None) -> list[ClanLink]:
    return sift_links(clan_links(conn, clan_id), _eyes(conn, request, as_viewer), clan_id)


class NewLink(BaseModel):
    a: int
    b: int
    note: str | None = None
    replace: bool = False  # у человека в том роду уже есть двойник — снять старую связку и поставить эту
    see: See = "all"  # уровень видимости связки, по умолчанию общий


class LinkSee(BaseModel):
    see: See


class PairDecision(BaseModel):
    a: int
    b: int


@app.get("/api/links", dependencies=[Depends(only_editor)])
def get_links(conn: Database) -> list[Link]:
    return list_links(conn)


@app.get("/api/links/candidates", dependencies=[Depends(only_editor)])
def get_candidates(conn: Database) -> list[Candidate]:
    return candidates(conn)


@app.post("/api/links")
def post_link(body: NewLink, conn: Database) -> Link:
    try:
        return create_link(conn, body.a, body.b, body.note, body.replace, body.see)
    except LinkClashError as error:
        raise HTTPException(status_code=409, detail=str(error)) from None
    except LinkError as error:
        raise HTTPException(status_code=400, detail=str(error)) from None


@app.put("/api/links/{link_id}/see")
def put_link_see(link_id: int, body: LinkSee, conn: Database) -> Link:
    """Уровень связки: скрытую зритель не видит и перейти по ней не может."""
    try:
        return set_link_see(conn, link_id, body.see)
    except LinkNotFoundError:
        raise HTTPException(status_code=404, detail="Такой связки нет") from None


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


@app.get("/api/dates/parse", dependencies=[Depends(only_editor)])
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


@app.get("/api/persons/{person_id}/form", dependencies=[Depends(only_editor)])
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


@app.get("/api/families/{family_id}/form")
def get_family_form(family_id: int, conn: Database, request: Request, as_viewer: int | None = None) -> FamilyForm:
    """Союз для карточки и формы: венчание, развод, дети по порядку файла.

    Карточку открывает и зритель — щелчком по союзу на карте, — поэтому маршрут не закрыт, а просеян:
    скрытый уходит из союза так же, как уходит из дерева, и следа по себе не оставляет.
    """
    try:
        form = family_form(conn, family_id)
    except KinError as error:
        raise HTTPException(status_code=404, detail=str(error)) from None
    eyes = _eyes(conn, request, as_viewer)
    return sift_family(form, eyes, _is_hidden(conn, form.clan_id, eyes))


@app.put("/api/families/{family_id}")
def put_family(family_id: int, body: FamilyFields, conn: Database) -> ChangeInfo:
    try:
        return update_family(conn, family_id, body)
    except (KinError, JournalError) as error:
        raise _edit_errors(error) from None


@app.get("/api/persons/{person_id}/delete-preview", dependencies=[Depends(only_editor)])
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


@app.get("/api/clans/{clan_id}/changes", dependencies=[Depends(only_editor)])
def get_clan_changes(clan_id: int, conn: Database) -> list[ChangeInfo]:
    """Только редактору: журнал помнит и прежние значения полей, и тех, кого скрыли от зрителя."""
    return clan_changes(conn, clan_id)


@app.get("/api/persons/{person_id}/changes", dependencies=[Depends(only_editor)])
def get_person_changes(person_id: int, conn: Database) -> list[ChangeInfo]:
    """Только редактору: история человека — тот же журнал, отобранный по одному из них."""
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


class ClanStatus(BaseModel):
    status: str


@app.put("/api/clans/{clan_id}/status")
def put_clan_status(clan_id: int, body: ClanStatus, conn: Database) -> ChangeInfo:
    """Титул рода: пишется в заголовок файла, поэтому переживает выгрузку и перезалив."""
    try:
        return set_status(conn, clan_id, body.status)
    except (TagError, JournalError) as error:
        raise _edit_errors(error) from None


@app.get("/api/clans/{clan_id}/tags/{name}/usage", dependencies=[Depends(only_editor)])
def get_tag_usage(clan_id: int, name: str, conn: Database) -> int:
    """Сколько людей носят метку — чтобы перед удалением сказать, с кого она снимется."""
    return tag_usage(conn, clan_id, name)


@app.put("/api/clans/{clan_id}/tags/{name}")
def put_tag(clan_id: int, name: str, body: TagChange, conn: Database) -> ChangeInfo:
    try:
        return update_tag(conn, clan_id, name, body)
    except TagError as error:
        raise HTTPException(status_code=400, detail=str(error)) from None


@app.delete("/api/clans/{clan_id}/tags/{name}")
def remove_tag(clan_id: int, name: str, conn: Database) -> ChangeInfo:
    try:
        return delete_tag(conn, clan_id, name)
    except TagError as error:
        raise HTTPException(status_code=400, detail=str(error)) from None


@app.post("/api/persons/{person_id}/photo")
async def post_photo(person_id: int, request: Request, conn: Database) -> ChangeInfo:
    try:
        return save_photo(conn, person_id, await request.body(), request.headers.get("content-type"))
    except (EditError, JournalError) as error:
        raise _edit_errors(error) from None


@app.delete("/api/persons/{person_id}/photo")
def delete_photo(person_id: int, conn: Database) -> ChangeInfo:
    try:
        return remove_photo(conn, person_id)
    except (EditError, JournalError) as error:
        raise _edit_errors(error) from None


@app.get("/api/photos/{clan}/{name}", include_in_schema=False)
def get_photo(clan: str, name: str) -> FileResponse:
    try:
        return FileResponse(photo_path(clan, name))
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Снимка нет") from None


@app.get("/api/clans/{clan_id}/export", response_class=PlainTextResponse)
def get_export(clan_id: int, request: Request, conn: Database, as_viewer: int | None = None) -> PlainTextResponse:
    """Род файлом GEDCOM 5.5.1. Каждый получает свой слой: редактор — всё, свой для рода — общее
    и родовое, прочий зритель — только общее."""
    eyes = _eyes(conn, request, as_viewer)
    try:
        text = export_clan(conn, clan_id, None if eyes.editor else (lambda level: eyes.allows(level, clan_id)))
    except ExportError:
        raise HTTPException(status_code=404, detail="Такого рода нет") from None
    name = conn.execute("SELECT name FROM clans WHERE id = ?", (clan_id,)).fetchone()[0]
    return PlainTextResponse(text, media_type="text/plain; charset=utf-8", headers={
        "Content-Disposition": f"attachment; filename*=UTF-8''{quote(name)}.ged"})


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


@app.post("/api/clans")
def post_clan(body: ClanStart, conn: Database) -> ClanSummary:
    """Новый род с нуля: имя рода и первый человек."""
    try:
        clan_id = start_clan(conn, body)
    except ClanExistsError as error:
        raise HTTPException(status_code=409, detail=str(error)) from None
    except NewClanError as error:
        raise HTTPException(status_code=400, detail=str(error)) from None
    return next(c for c in list_clans(conn) if c.id == clan_id)


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


@app.get("/api/uploads/{token}/reload/{clan_id}", dependencies=[Depends(only_editor)])
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
