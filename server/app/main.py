"""Один процесс отдаёт и API, и собранный интерфейс."""

from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles

ROOT = Path(__file__).resolve().parents[2]
DIST = ROOT / "web" / "dist"

app = FastAPI(
    title="Родословные",
    docs_url="/api/docs",
    openapi_url="/api/openapi.json",
    redoc_url=None,
)


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


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
