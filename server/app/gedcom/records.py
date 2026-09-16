"""Файл GEDCOM → дерево записей без потерь.

Каждая строка сохраняется как есть: уровень, ссылка, тег, значение. Дерево собирается
обратно в те же строки — на этом держится правило «приложение не теряет того, чего не понимает».
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

# уровень, необязательная ссылка @X1@, тег, необязательное значение после одного пробела
_LINE = re.compile(r"^(\d+) (?:(@[^@\s]+@) )?(\S+)(?: (.*))?$")


class GedcomSyntaxError(ValueError):
    def __init__(self, line_no: int, line: str, reason: str) -> None:
        super().__init__(f"строка {line_no}: {reason}: {line!r}")
        self.line_no = line_no


@dataclass
class Record:
    level: int
    tag: str
    value: str | None = None
    xref: str | None = None
    children: list[Record] = field(default_factory=list)
    line_no: int = 0

    def first(self, tag: str) -> Record | None:
        return next((c for c in self.children if c.tag == tag), None)

    def all(self, tag: str) -> list[Record]:
        return [c for c in self.children if c.tag == tag]

    def value_of(self, tag: str) -> str | None:
        child = self.first(tag)
        return child.value if child else None

    def text(self) -> str:
        """Значение вместе с продолжениями CONC (без переноса) и CONT (с переносом строки)."""
        parts = [self.value or ""]
        for child in self.children:
            if child.tag == "CONC":
                parts.append(child.value or "")
            elif child.tag == "CONT":
                parts.append("\n" + (child.value or ""))
        return "".join(parts)

    def to_lines(self) -> list[str]:
        head = [str(self.level)]
        if self.xref:
            head.append(self.xref)
        head.append(self.tag)
        line = " ".join(head) + ("" if self.value is None else " " + self.value)
        lines = [line]
        for child in self.children:
            lines.extend(child.to_lines())
        return lines

    def to_json(self) -> dict[str, Any]:
        out: dict[str, Any] = {"t": self.tag}
        if self.xref is not None:
            out["x"] = self.xref
        if self.value is not None:
            out["v"] = self.value
        if self.children:
            out["c"] = [c.to_json() for c in self.children]
        return out

    @classmethod
    def from_json(cls, data: dict[str, Any], level: int = 0) -> Record:
        return cls(
            level=level,
            tag=data["t"],
            value=data.get("v"),
            xref=data.get("x"),
            children=[cls.from_json(c, level + 1) for c in data.get("c", [])],
        )


def split_lines(text: str) -> list[str]:
    """Строки файла без BOM и без пустых. Переводы строк любые: CRLF, CR, LF."""
    text = text.removeprefix("﻿")
    return [line for line in re.split(r"\r\n|\r|\n", text) if line.strip()]


def parse_records(text: str) -> list[Record]:
    roots: list[Record] = []
    stack: list[Record] = []
    for line_no, raw in enumerate(re.split(r"\r\n|\r|\n", text.removeprefix("﻿")), start=1):
        if not raw.strip():
            continue
        line = raw.lstrip()
        match = _LINE.match(line)
        if match is None:
            raise GedcomSyntaxError(line_no, raw, "строка не по формату GEDCOM")
        level = int(match.group(1))
        if level == 0:
            stack.clear()
        elif not stack or level > stack[-1].level + 1:
            raise GedcomSyntaxError(line_no, raw, "уровень прыгает через ступень")
        while stack and stack[-1].level >= level:
            stack.pop()
        record = Record(
            level=level,
            xref=match.group(2),
            tag=match.group(3),
            value=match.group(4),
            line_no=line_no,
        )
        (stack[-1].children if stack else roots).append(record)
        stack.append(record)
    return roots
