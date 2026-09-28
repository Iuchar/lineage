"""Служебные теги приложения в записях GEDCOM: метки, состояния, главная линия, портрет.

Всё, что приложение знает о человеке сверх GEDCOM, пишется в его же запись тегами с подчёркиванием —
их разрешает стандарт, чужие программы их пропускают, а при заливке обратно они возвращаются целыми.
Поэтому метки и состояния идут через тот же журнал с откатом и уходят в экспорт вместе с человеком.

    1 _TAG Переселенец          метка человека (сколько угодно)
    1 _BURNT Y                  выжжен из рода
    1 _SEE hidden               уровень видимости человека целиком (нет тега — общее)
    1 _SEE dates clan           уровень дат жизни, по умолчанию родовое
    1 _SEE portrait all         уровень портрета, по умолчанию общее
    1 _HIDDEN Y                 прежний вид «скрыт от зрителей»: читается как _SEE hidden
    1 _HEIR Y                   продолжатель главной линии
    1 _PORTRAIT none            портрет выключен у этого человека (silhouette — заглушка вместо снимка)
    1 OBJE / 2 FILE photos/…    снимок, лежит в папке photos рядом с базой

Набор меток рода с цветами — в заголовке файла: 1 _TAGDEF Переселенец / 2 _COLOR синий.
Там же статус рода: 1 _STATUS titled (ключи — в STATUS_NAMES).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

from app.gedcom.records import Record

TAG_COLORS = ("синий", "винный", "зелёный", "охра", "лиловый", "морской", "кирпичный", "дымный")
# статус рода: чем древнее и титулованнее, тем выше при сортировке по статусу
STATUS_NAMES = {
    "titled": "титулованный древний благородный род",
    "old": "древний благородный род",
    "plain": "род без титула",
}
DEFAULT_STATUS = "plain"
Portrait = Literal["auto", "silhouette", "none"]
PHOTO_PREFIX = "photos/"

# уровни видимости: общее — всем зрителям, родовое — только своим для этого рода, скрытое — только редакторам
See = Literal["all", "clan", "hidden"]
SEE_LEVELS: tuple[See, ...] = ("all", "clan", "hidden")
SEE_NAMES: dict[str, str] = {"all": "общее", "clan": "родовое", "hidden": "скрытое"}
# по проектному документу: имя и место в дереве видны всем, даты жизни — своим, портрет — всем
DEFAULT_SEE: See = "all"
DEFAULT_SEE_DATES: See = "clan"


@dataclass
class PersonMeta:
    tags: list[str] = field(default_factory=list)
    burnt: bool = False
    see: See = DEFAULT_SEE  # человек целиком
    see_dates: See = DEFAULT_SEE_DATES
    see_portrait: See = DEFAULT_SEE
    heir: bool = False
    portrait: Portrait = "auto"
    photo: str | None = None  # путь внутри папки снимков: photos/<род>/<файл>


def _flag(record: Record, tag: str) -> bool:
    return (record.value_of(tag) or "").upper() == "Y"


def _level(value: str | None, fallback: See) -> See:
    level = (value or "").strip().lower()
    return level if level in SEE_LEVELS else fallback  # type: ignore[return-value]


def _read_see(record: Record, what: str | None, fallback: See) -> See:
    """Уровень из `_SEE [что] уровень`: без «что» — человек целиком."""
    for child in record.all("_SEE"):
        parts = (child.value or "").split()
        if what is None and len(parts) == 1:
            return _level(parts[0], fallback)
        if what is not None and len(parts) == 2 and parts[0].lower() == what:
            return _level(parts[1], fallback)
    return fallback


def read_meta(record: Record) -> PersonMeta:
    portrait = (record.value_of("_PORTRAIT") or "auto").lower()
    photo = next((obje.value_of("FILE") for obje in record.all("OBJE")
                  if (obje.value_of("FILE") or "").startswith(PHOTO_PREFIX)), None)
    return PersonMeta(
        tags=[c.value for c in record.all("_TAG") if c.value],
        burnt=_flag(record, "_BURNT"),
        # прежние файлы помечали скрытых флагом _HIDDEN — он читается как уровень «скрытое»
        see=_read_see(record, None, "hidden" if _flag(record, "_HIDDEN") else DEFAULT_SEE),
        see_dates=_read_see(record, "dates", DEFAULT_SEE_DATES),
        see_portrait=_read_see(record, "portrait", DEFAULT_SEE),
        heir=_flag(record, "_HEIR"),
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
    _set_flag(record, "_HIDDEN", False)  # флаг заменён уровнем, в файле его больше не держим
    _set_flag(record, "_HEIR", meta.heir)
    _write_see(record, meta)
    record.children = [c for c in record.children if c.tag != "_PORTRAIT"]
    if meta.portrait != "auto":
        record.children.append(Record(level=1, tag="_PORTRAIT", value=meta.portrait))


def _write_see(record: Record, meta: PersonMeta) -> None:
    """Уровни пишутся только там, где отличаются от значения по умолчанию: файл не пухнет."""
    record.children = [c for c in record.children if c.tag != "_SEE"]
    lines = []
    if meta.see != DEFAULT_SEE:
        lines.append(meta.see)
    if meta.see_dates != DEFAULT_SEE_DATES:
        lines.append(f"dates {meta.see_dates}")
    if meta.see_portrait != DEFAULT_SEE:
        lines.append(f"portrait {meta.see_portrait}")
    record.children.extend(Record(level=1, tag="_SEE", value=line) for line in lines)


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


def read_status(header: Record | None) -> str:
    value = (header.value_of("_STATUS") or "").strip() if header else ""
    return value if value in STATUS_NAMES else DEFAULT_STATUS


def write_status(header: Record, status: str) -> None:
    header.children = [c for c in header.children if c.tag != "_STATUS"]
    if status != DEFAULT_STATUS:
        header.children.append(Record(level=1, tag="_STATUS", value=status))


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
