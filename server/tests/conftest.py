from pathlib import Path

import pytest

# замороженные копии родов: рабочие файлы в houses/ меняются вместе с деревом, проверки должны стоять на месте
HOUSES = Path(__file__).parent / "houses"

# род → файл, людей, семей, узлов-заглушек «Ветвь» и «Потомки»; числа людей и семей — из проектного документа
CLANS = {
    "Гленн Уриск": ("Gleann_Uruisg_tree.ged", 38, 14, 6),
    "Уинтерхоуп": ("Winterhope_tree.ged", 62, 26, 7),
    "О'Дувейн": ("O_Dubhain_tree.ged", 17, 6, 0),
    "Монад Кройве": ("Monadh_Croibhe_tree.ged", 84, 36, 7),
}


def source(name: str) -> Path:
    return HOUSES / CLANS[name][0]


@pytest.fixture(autouse=True)
def _no_working_database(tmp_path_factory: pytest.TempPathFactory, monkeypatch: pytest.MonkeyPatch) -> None:
    """Ни один тест не трогает рабочую базу: путь по умолчанию у каждого свой, временный.

    Раньше тесты, не подменившие путь сами, ходили в data/rodoslovnye.sqlite3 — и накатывали на неё
    миграции, едва те появлялись в коде. Тест, которому нужна своя база, подменяет путь поверх этого.
    """
    import app.config
    import app.main

    path = tmp_path_factory.mktemp("base") / "default.sqlite3"
    monkeypatch.setattr(app.config, "DB_PATH", path)
    monkeypatch.setattr(app.main, "DB_PATH", path)
