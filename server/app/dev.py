"""Служебные команды разработки.

    python -m app.dev openapi ПУТЬ.json      описание API — из него собираются типы интерфейса
    python -m app.dev fixtures ПАПКА         роды в формате /api/clans/{id}/tree для тестов раскладки
"""

import json
import sys
from pathlib import Path

from app.config import ROOT
from app.db.clans import import_clan
from app.db.connection import connect
from app.db.tree import clan_tree
from app.gedcom.load import load_file
from app.main import app

# фикстуры собираются из исходных файлов, а не из рабочей базы, — чтобы тесты не зависели от её состояния
FIXTURE_CLANS = {
    "gleann": ("Гленн Уриск", "Gleann_Uruisg_tree.ged"),
    "monadh": ("Монад Кройве", "Monadh_Croibhe_tree.ged"),
}


def write_openapi(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(app.openapi(), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def write_fixtures(folder: Path) -> None:
    folder.mkdir(parents=True, exist_ok=True)
    conn = connect(":memory:")
    for key, (name, file) in FIXTURE_CLANS.items():
        report = import_clan(conn, name, load_file(ROOT / file), source_file=file)
        payload = clan_tree(conn, report.clan_id).model_dump(mode="json")
        (folder / f"{key}.tree.json").write_text(
            json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8"
        )


def main() -> None:
    if len(sys.argv) != 3 or sys.argv[1] not in ("openapi", "fixtures"):
        sys.exit(__doc__)
    target = Path(sys.argv[2])
    (write_openapi if sys.argv[1] == "openapi" else write_fixtures)(target)


if __name__ == "__main__":
    main()
