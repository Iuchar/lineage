"""Служебные теги приложения в записях GEDCOM: метки, состояния, главная линия, портрет.

Всё, что приложение знает о человеке сверх GEDCOM, пишется в его же запись тегами с подчёркиванием —
их разрешает стандарт, чужие программы их пропускают, а при заливке обратно они возвращаются целыми.
Поэтому метки и состояния идут через тот же журнал с откатом и уходят в экспорт вместе с человеком.

    1 _TAG Переселенец          метка человека (сколько угодно)
    1 _BURNT Y                  выжжен из рода
    1 _HIDDEN Y                 скрыт от зрителей
    1 _HEIR Y                   продолжатель главной линии
    1 _PORTRAIT none            портрет выключен у этого человека (silhouette — заглушка вместо снимка)
    1 OBJE / 2 FILE photos/…    снимок, лежит в папке photos рядом с базой

Набор меток рода с цветами — в заголовке файла: 1 _TAGDEF Переселенец / 2 _COLOR синий.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

from app.gedcom.records import Record

TAG_COLORS = ("синий", "винный", "зелёный", "охра", "лиловый", "морской", "кирпичный", "дымный")
Portrait = Literal["auto", "silhouette", "none"]
PHOTO_PREFIX = "photos/"


@dataclass
class PersonMeta:
    tags: list[str] = field(default_factory=list)
    burnt: bool = False
    hidden: bool = False
    heir: bool = False
    portrait: Portrait = "auto"
    photo: str | None = None  # путь внутри папки снимков: photos/<род>/<файл>


def _flag(record: Record, tag: str) -> bool:
    return (record.value_of(tag) or "").upper() == "Y"


def read_meta(record: Record) -> PersonMeta:
    portrait = (record.value_of("_PORTRAIT") or "auto").lower()
    photo = next((obje.value_of("FILE") for obje in record.all("OBJE")
                  if (obje.value_of("FILE") or "").startswith(PHOTO_PREFIX)), None)
    return PersonMeta(
        tags=[c.value for c in record.all("_TAG") if c.value],
        burnt=_flag(record, "_BURNT"), hidden=_flag(record, "_HIDDEN"), heir=_flag(record, "_HEIR"),
        portrait=portrait if portrait in ("auto", "silhouette", "none") else "auto",  # type: ignore[arg-type]
        photo=photo,
    )


def _set_flag(record: Record, tag: str, on: bool) -> None:
    record.children = [c for c in record.children if c.tag != tag]
    if on:
        record.children.append(Record(level=1, tag=tag, value="Y"))


def write_meta(record: Record, meta: PersonMeta) -> None:
    """Поставить служебные теги по meta; прочие теги записи не трогаются."""
    keep = [c for c in record.children if c.tag != "_TAG"]
    record.children = keep + [Record(level=1, tag="_TAG", value=t) for t in dict.fromkeys(meta.tags) if t.strip()]
    _set_flag(record, "_BURNT", meta.burnt)
    _set_flag(record, "_HIDDEN", meta.hidden)
    _set_flag(record, "_HEIR", meta.heir)
    record.children = [c for c in record.children if c.tag != "_PORTRAIT"]
    if meta.portrait != "auto":
        record.children.append(Record(level=1, tag="_PORTRAIT", value=meta.portrait))


def set_photo(record: Record, path: str | None) -> None:
    """Снимок — объект OBJE с файлом в папке снимков; чужие OBJE (ссылки из других программ) не трогаются."""
    record.children = [c for c in record.children
                       if not (c.tag == "OBJE" and (c.value_of("FILE") or "").startswith(PHOTO_PREFIX))]
    if path:
        obje = Record(level=1, tag="OBJE")
        ext = path.rsplit(".", 1)[-1].lower()
        obje.children = [Record(level=2, tag="FILE", value=path), Record(level=2, tag="FORM", value=ext)]
        record.children.append(obje)


@dataclass
class TagDef:
    name: str
    color: str


def read_tag_defs(header: Record | None) -> list[TagDef]:
    if header is None:
        return []
    return [TagDef(name=c.value, color=c.value_of("_COLOR") or TAG_COLORS[0]) for c in header.all("_TAGDEF") if c.value]


def add_tag_def(header: Record, name: str, color: str) -> None:
    if any(c.value == name for c in header.all("_TAGDEF")):
        return
    record = Record(level=1, tag="_TAGDEF", value=name)
    record.children.append(Record(level=2, tag="_COLOR", value=color if color in TAG_COLORS else TAG_COLORS[0]))
    header.children.append(record)
