from pathlib import Path

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
