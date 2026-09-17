"""Разобранные, но ещё не залитые файлы. Живут в памяти процесса до заливки или вытеснения."""

from __future__ import annotations

import secrets
from collections import OrderedDict
from dataclasses import dataclass

from app.gedcom.convert import ClanData

LIMIT = 8  # столько файлов ждут решения одновременно; старые вытесняются


@dataclass
class Upload:
    file_name: str
    data: ClanData


_uploads: OrderedDict[str, Upload] = OrderedDict()


def put(file_name: str, data: ClanData) -> str:
    token = secrets.token_urlsafe(12)
    _uploads[token] = Upload(file_name, data)
    while len(_uploads) > LIMIT:
        _uploads.popitem(last=False)
    return token


def get(token: str) -> Upload | None:
    return _uploads.get(token)


def drop(token: str) -> None:
    _uploads.pop(token, None)
