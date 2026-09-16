"""Один процесс отдаёт и API, и собранный интерфейс."""

import sqlite3
from collections.abc import Iterator
from typing import Annotated

from fastapi import Depends, FastAPI, HTTPException
from fastapi.responses import FileResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles

from app.config import DB_PATH, DIST
from app.db.connection import connect
from app.db.person import PersonDetails, PersonNotFoundError, person_details
from app.db.tree import ClanNotFoundError, ClanSummary, ClanTree, clan_tree, list_clans

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
