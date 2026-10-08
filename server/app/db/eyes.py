"""Кто смотрит и что ему видно.

Редактор видит всё. Зритель — общий слой любого рода плюс родовой слой тех родов, ссылки на которые
он открывал. Скрытого не видит никто, кроме редактора, и скрытый не намекает на себя: его нет в дереве
вовсе, а не висит серым. Дети скрытого остаются — просто их семья теряет родителя и рисуется как
«родители не записаны», такой знак на карте и так есть у братьев без родителей.
"""

from collections.abc import Callable
from dataclasses import dataclass

from app.db.kin import FamilyForm
from app.db.links import ClanLink
from app.db.person import PersonDetails
from app.db.tree import ClanTree
from app.gedcom.meta import PersonMeta, See


@dataclass(frozen=True)
class Eyes:
    editor: bool = True  # правка открыта — значит смотрит редактор
    clans: frozenset[int] = frozenset()  # роды, для которых смотрящий свой

    def allows(self, level: See, clan_id: int) -> bool:
        if self.editor:
            return True
        if level == "hidden":
            return False
        return level == "all" or clan_id in self.clans


def sift_links(links: list[ClanLink], eyes: Eyes, clan_id: int,
               levels: Callable[[int], PersonMeta | None]) -> list[ClanLink]:
    """Связки: уровень свой у каждой. Скрытую зритель не видит, и перехода по ней у него нет.

    Связка приносит имя и годы человека из другого рода, поэтому держит и правила его дерева:
    скрытого на любом из концов для зрителя нет вовсе, а годы приходят, только если открыты
    в ТОМ роду — свой здесь не значит свой там. Кто поставил связку, зрителю не говорится:
    это имя редактора, под ним входят.
    """
    if eyes.editor:
        return links
    seen = []
    for link in links:
        own, other = levels(link.person_id), levels(link.other.id)
        if own is None or other is None or not eyes.allows(link.see, clan_id):
            continue
        if not eyes.allows(own.see, clan_id) or not eyes.allows(other.see, link.other.clan_id):
            continue
        link.created_by = None
        if not eyes.allows(other.see_dates, link.other.clan_id):
            link.other.born = None
            link.other.died = None
            link.other.dates_closed = True
        seen.append(link)
    return seen


def sift_family(form: FamilyForm, eyes: Eyes, hidden: Callable[[int], bool]) -> FamilyForm | None:
    """Карточка союза: скрытый уходит из неё так же, как уходит из дерева.

    Союз остаётся — без скрытого супруга и без скрытого ребёнка. Иначе зритель, щёлкнув по союзу,
    узнавал бы, что у пары есть кто-то ещё: самого человека не видно, а след от него оставался.
    Если скрыт супруг, уходит и всё о браке; а когда показывать больше нечего, союза для зрителя нет (None).
    """
    if eyes.editor:
        return form
    lost = False  # супруг ушёл из союза, потому что скрыт
    if form.husband is not None and hidden(form.husband):
        form.husband, lost = None, True
    if form.wife is not None and hidden(form.wife):
        form.wife, lost = None, True
    form.children = [child for child in form.children if not hidden(child.id)]
    if lost:
        # венчание, место и развод говорят, что супруг был: от такого союза зрителю остаются только дети
        form.marriage = form.marriage.model_copy(update={"gedcom": None, "ru": "", "input": ""})
        form.divorce = form.divorce.model_copy(update={"gedcom": None, "ru": "", "input": ""})
        form.place, form.divorced = None, False
        if not form.children:
            return None
    if form.husband is None and form.wife is None and not form.children:
        return None
    return form


def sift_person(details: PersonDetails, eyes: Eyes, see_dates: See = "all",
                veiled: Callable[[int], bool] = lambda _family: False) -> PersonDetails:
    """Карточка человека: заметки уровнем выше доступного уходят вовсе, а не прячутся многоточием.

    Годы жизни держатся уровня самого человека (see_dates) — того же, что в дереве и в выгрузке:
    у рождения и смерти уходит дата, место остаётся. Иначе закрытое в дереве читалось бы щелчком.
    Брак со скрытым супругом (veiled) из карточки уходит целиком: венчание выдавало бы, что супруг был.
    """
    if eyes.editor:
        return details
    details.events = [e for e in details.events if eyes.allows(e.see, details.clan_id)]
    details.marriages = [m for m in details.marriages if not veiled(m.family_id)]
    if not eyes.allows(see_dates, details.clan_id):
        for event in details.events:
            if event.tag in ("BIRT", "DEAT"):
                event.date = None
    return details


def sift(tree: ClanTree, eyes: Eyes) -> ClanTree:
    """Убирает из дерева то, чего этим глазам видеть не положено."""
    if eyes.editor:
        return tree

    clan_id = tree.clan.id
    # Зритель видит ту же схему, что нарисовал редактор: скрываются данные, а не расположение людей.
    # Раскладке для этого нужны годы — порядок по старшинству, высота на линейке дат, оценка для людей без года.
    # Поэтому годы уходят зрителю служебными полями, отдельно от дат на карточке; считаем до того, как даты уйдут.
    for person in tree.persons:
        person.layout_birth = (person.birth.year or person.birth.end_year) if person.birth else None
        person.layout_death = (person.death.year or person.death.end_year) if person.death else None
    keep = [p for p in tree.persons if eyes.allows(p.see, clan_id)]
    gone = {p.id for p in tree.persons} - {p.id for p in keep}
    for person in keep:
        if not eyes.allows(person.see_dates, clan_id):
            person.birth = None
            person.death = None
            person.dates_closed = True
        if not eyes.allows(person.see_portrait, clan_id):
            person.photo = None
            person.portrait = "silhouette"

    families = []
    for family in tree.families:
        # скрытый родитель уходит из семьи: остаётся союз без него, а без обоих — «родители не записаны»
        lost = family.husband in gone or family.wife in gone
        if family.husband in gone:
            family.husband = None
        if family.wife in gone:
            family.wife = None
        # родство ребёнка лежит вторым списком — вычёркиваем парами, иначе оно съедет
        pedigree = family.child_pedigree or []
        pairs = [(child, pedigree[i] if i < len(pedigree) else "birth")
                 for i, child in enumerate(family.children) if child not in gone]
        family.children = [child for child, _ in pairs]
        if pedigree:
            family.child_pedigree = [kind for _, kind in pairs]
        if family.husband is None and family.wife is None and not family.children:
            continue
        if lost:
            # развод выдавал бы, что супруг был; а бездетный союз со скрытым показывать нечем — его нет
            family.divorced = False
            if not family.children:
                continue
        families.append(family)

    alive = {f.id for f in families}
    for person in keep:
        person.parent_families = [f for f in person.parent_families if f in alive]
        person.spouse_families = [f for f in person.spouse_families if f in alive]
    tree.persons = keep
    tree.families = families
    return tree
