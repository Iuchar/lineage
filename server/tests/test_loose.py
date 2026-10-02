"""Род — одно связное дерево: несвязанные части в файле отмечаются предупреждением."""

from app.gedcom.load import load_text

HEAD = "0 HEAD\n1 CHAR UTF-8\n"


def ged(*blocks: str) -> str:
    return HEAD + "".join(blocks) + "0 TRLR\n"


FATHER = "0 @I1@ INDI\n1 NAME Гарольд /Хартли/\n1 FAMS @F1@\n"
CHILD = "0 @I2@ INDI\n1 NAME Мэри /Дэвис/\n1 FAMC @F1@\n"
FAMILY = "0 @F1@ FAM\n1 HUSB @I1@\n1 CHIL @I2@\n"
STRANGER = "0 @I9@ INDI\n1 NAME Реджиналд /Дэвис/\n1 FAMS @F9@\n"
STRANGER_WIFE = "0 @I10@ INDI\n1 NAME Нора /Эванс/\n1 FAMS @F9@\n"
STRANGER_FAMILY = "0 @F9@ FAM\n1 HUSB @I9@\n1 WIFE @I10@\n"


def loose(text: str) -> list[str]:
    return [w for w in load_text(text).warnings if "не связанных" in w]


def test_one_tree_is_quiet() -> None:
    assert loose(ged(FATHER, CHILD, FAMILY)) == []


def test_second_part_is_named() -> None:
    [warning] = loose(ged(FATHER, CHILD, FAMILY, STRANGER, STRANGER_WIFE, STRANGER_FAMILY))
    assert "2 не связанных между собой частей" in warning
    assert "2 человека не в родстве" in warning
    assert "отдельном роду" in warning


def test_lone_person_counts_as_a_part() -> None:
    [warning] = loose(ged(FATHER, CHILD, FAMILY, "0 @I9@ INDI\n1 NAME Сам /По Себе/\n"))
    assert "1 человек не в родстве" in warning


def test_single_person_file_is_quiet() -> None:
    assert loose(ged("0 @I1@ INDI\n1 NAME Один /Вовсе/\n")) == []


def test_parts_joined_through_a_child_are_one_tree() -> None:
    # родные родители и опекуны сходятся на одном ребёнке — это одно дерево
    text = ged(
        FATHER, FAMILY,
        "0 @I2@ INDI\n1 NAME Мэри /Дэвис/\n1 FAMC @F1@\n1 FAMC @F9@\n",
        STRANGER, STRANGER_WIFE, "0 @F9@ FAM\n1 HUSB @I9@\n1 WIFE @I10@\n1 CHIL @I2@\n",
    )
    assert loose(text) == []
