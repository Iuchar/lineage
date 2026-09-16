from pathlib import Path

from app.config import ROOT

# род → файл, людей, семей, узлов-заглушек «Ветвь»; числа людей и семей — из проектного документа
CLANS = {
    "Гленн Уриск": ("Gleann_Uruisg_tree.ged", 38, 14, 6),
    "Уинтерхоуп": ("Winterhope_tree.ged", 62, 26, 7),
    "О'Дувейн": ("O_Dubhain_tree.ged", 17, 6, 0),
    "Монад Кройве": ("Monadh_Croibhe_tree.ged", 84, 36, 4),
}


def source(name: str) -> Path:
    return ROOT / CLANS[name][0]
