"""Чтение файла .ged целиком в общую модель."""

from pathlib import Path

from app.gedcom.convert import ClanData, convert
from app.gedcom.records import parse_records


class GedcomEncodingError(ValueError):
    pass


def load_text(text: str) -> ClanData:
    return convert(parse_records(text))


def load_file(path: Path) -> ClanData:
    data = path.read_bytes()
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError as error:
        # ANSEL и однобайтные кодировки старых программ пока не поддерживаются
        raise GedcomEncodingError(f"{path.name}: файл не в UTF-8 ({error.reason})") from error
    return load_text(text)
