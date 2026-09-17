// Оценка года рождения для тех, у кого его нет: по родне, от надёжного признака к слабому.
// Оценка нужна раскладке: высоте на линейке и порядку среди братьев, когда датированных братьев нет —
// иначе порядок берётся из записи семьи (layout.ts). На карточке по-прежнему «год неизвестен».
// Поколение человека задаёт родство, а не год, поэтому промах оценки не уводит его в чужой ярус.

import type { ClanTree, TreePerson } from "../api/types";

const MIN_PARENT_AGE = 15; // моложе родителем не становятся
const GENERATION = 30; // типичный разрыв между родителем и ребёнком, когда граница только одна

const yearOf = (person: TreePerson | undefined): number | null =>
  person?.birth ? (person.birth.year ?? person.birth.end_year ?? null) : null;

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
};

// Сначала братья и сёстры (середина их годов), зажатые границами: не раньше родителей + 15,
// не позже первого ребёнка − 15 и года смерти. Без братьев — середина между родителями и детьми, а если известна
// только одна сторона — она с типичным разрывом поколения. Супруги — только если больше ничего нет, серединой ряда.
// Заглушки «Ветвь» и «Потомки» не оцениваются: это не люди, их место — ярус поколения.
export function estimateBirthYears(tree: ClanTree): Map<number, number> {
  const persons = new Map(tree.persons.map((p) => [p.id, p]));
  const families = new Map(tree.families.map((f) => [f.id, f]));
  const out = new Map<number, number>();

  for (const person of tree.persons) {
    if (person.is_branch_stub || yearOf(person) != null) continue;
    const known = (ids: (number | null | undefined)[]) =>
      ids.map((id) => (id != null ? yearOf(persons.get(id)) : null)).filter((y): y is number => y != null);

    const parentFamilies = person.parent_families.map((f) => families.get(f)).filter((f) => f !== undefined);
    const siblings = known(parentFamilies.flatMap((f) => f.children.filter((c) => c !== person.id && !persons.get(c)?.is_branch_stub)));
    const parents = known(parentFamilies.flatMap((f) => [f.husband, f.wife]));
    const marriages = person.spouse_families.map((f) => families.get(f)).filter((f) => f !== undefined);
    const children = known(marriages.flatMap((f) => f.children));
    const spouses = known(marriages.map((f) => (f.husband === person.id ? f.wife : f.husband)));

    const low = parents.length ? Math.max(...parents) + MIN_PARENT_AGE : null;
    const beforeChildren = children.length ? Math.min(...children) - MIN_PARENT_AGE : null;
    const death = person.death ? (person.death.year ?? person.death.end_year ?? null) : null;
    const high = [beforeChildren, death].filter((y): y is number => y != null).reduce<number | null>(
      (a, b) => (a == null ? b : Math.min(a, b)), null);
    const clamp = (year: number) => Math.min(high ?? year, Math.max(low ?? year, year));

    let estimate: number | null = null;
    if (siblings.length) estimate = clamp(median(siblings));
    else if (low != null && beforeChildren != null) estimate = clamp(Math.round((low + beforeChildren) / 2));
    else if (parents.length) estimate = clamp(Math.max(...parents) + GENERATION);
    else if (children.length) estimate = clamp(Math.min(...children) - GENERATION);
    else if (spouses.length) estimate = clamp(median(spouses));
    if (estimate != null) out.set(person.id, estimate);
  }
  return out;
}
