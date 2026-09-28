"""Кто сейчас правит.

Имя редактора нужно журналу и связкам, но тащить его через десяток вызовов было бы возней ради одного
поля. Поэтому оно живёт в контексте запроса: заслон в main.py ставит имя, журнал читает. Вне запроса
(командная строка, тесты) имени нет — правка записывается без автора, как было раньше.
"""

from contextvars import ContextVar

_author: ContextVar[str | None] = ContextVar("rodoslovnye_author", default=None)


def set_author(name: str | None) -> None:
    _author.set(name)


def author() -> str | None:
    return _author.get()
