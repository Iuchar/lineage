// Главная линия рода: цепочка продолжателей, отмеченных человеком. Ни возраст, ни размер ветки
// её не задают. Здесь только разбор отметок: кто на линии, где она кончается и пресеклась ли.

import type { ClanTree, TreePerson } from "../api/types";

export interface MainLine {
  persons: ReadonlySet<number>; // все на линии, по порядку от последнего к основателю
  last: number | null; // последний отмеченный
  broken: boolean; // у последнего нет ни детей, ни продолжения в другом роду — линия пресеклась
}

export const NO_LINE: MainLine = { persons: new Set(), last: null, broken: false };

// Отмечаются дети-продолжатели: основатель линии в наборе не нужен, он выводится сам.
export function mainLine(tree: ClanTree, heirs: ReadonlySet<number>): MainLine {
  if (!heirs.size) return NO_LINE;
  const persons = new Map(tree.persons.map((p) => [p.id, p]));
  const families = new Map(tree.families.map((f) => [f.id, f]));

  const childrenOf = (person: TreePerson): number[] =>
    person.spouse_families.flatMap((id) => families.get(id)?.children ?? []);

  // кровный родитель — тот, у кого свои родители в роду; у основателей — первый записанный
  const parentOf = (person: TreePerson): TreePerson | null => {
    const family = families.get(person.parent_families[0] ?? -1);
    if (!family) return null;
    const pair = [family.husband, family.wife]
      .map((id) => (id != null ? persons.get(id) : undefined))
      .filter((p): p is TreePerson => p !== undefined);
    return pair.find((p) => p.parent_families.length) ?? pair[0] ?? null;
  };

  // конец линии — отмеченный, среди чьих детей отмеченных нет; при спорных отметках берётся длинная цепочка
  const ends = [...heirs]
    .map((id) => persons.get(id))
    .filter((p): p is TreePerson => p !== undefined && !childrenOf(p).some((c) => heirs.has(c)));
  let best: { line: number[]; last: TreePerson } | null = null;
  for (const end of ends) {
    const line: number[] = [end.id];
    let walk: TreePerson | null = end;
    while (walk) {
      const parent: TreePerson | null = parentOf(walk);
      if (!parent || line.includes(parent.id)) break;
      line.push(parent.id);
      walk = heirs.has(parent.id) ? parent : null; // выше основателя линии не идём
    }
    if (!best || line.length > best.line.length) best = { line, last: end };
  }
  if (!best) return NO_LINE;
  // «Ветвь» на конце — не обрыв: линия уходит в другой род
  const broken = !best.last.is_branch_stub && childrenOf(best.last).length === 0;
  return { persons: new Set(best.line), last: best.last.id, broken };
}
