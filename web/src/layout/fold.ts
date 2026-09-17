// Свёрнутые ветки: из дерева убираются потомки свёрнутых союзов, союз остаётся со стопкой под собой.
// Человек виден, если к нему ведёт хоть одна дорога мимо свёрнутых союзов.

import type { ClanTree, TreeFamily, TreePerson } from "../api/types";

export interface FoldInfo {
  family: number;
  descendants: number; // все скрытые потомки: дети, внуки и дальше
  children: TreePerson[]; // дети этого союза по порядку в семье
}

export interface FoldedTree {
  tree: ClanTree;
  folds: Map<number, FoldInfo>;
}

// все потомки союза по полному дереву, без супругов
export function descendantsOf(tree: ClanTree, familyId: number): Set<number> {
  const persons = new Map(tree.persons.map((p) => [p.id, p]));
  const families = new Map(tree.families.map((f) => [f.id, f]));
  const out = new Set<number>();
  const queue = [...(families.get(familyId)?.children ?? [])];
  while (queue.length) {
    const id = queue.pop()!;
    if (out.has(id) || !persons.has(id)) continue;
    out.add(id);
    for (const fid of persons.get(id)!.spouse_families) queue.push(...(families.get(fid)?.children ?? []));
  }
  return out;
}

function visiblePersons(tree: ClanTree, folded: ReadonlySet<number>): Set<number> {
  const persons = new Map(tree.persons.map((p) => [p.id, p]));
  const families = new Map(tree.families.map((f) => [f.id, f]));
  const spousesOf = (person: TreePerson) =>
    person.spouse_families
      .map((fid) => families.get(fid))
      .filter((f): f is TreeFamily => f !== undefined)
      .map((f) => (f.husband === person.id ? f.wife : f.husband))
      .filter((id): id is number => id != null && persons.has(id));

  // опора — основатели и одиночки: у них и у всех их супругов нет родителей в роду
  const visible = new Set<number>();
  for (const person of tree.persons) {
    if (person.parent_families.length) continue;
    if (spousesOf(person).every((id) => !persons.get(id)!.parent_families.length)) visible.add(person.id);
  }

  let changed = true;
  while (changed) {
    changed = false;
    const show = (id: number) => {
      if (!visible.has(id)) {
        visible.add(id);
        changed = true;
      }
    };
    for (const family of tree.families) {
      const parents = [family.husband, family.wife].filter((id): id is number => id != null);
      if (!parents.some((id) => visible.has(id))) continue;
      // пришлый супруг виден вместе с видимым
      for (const id of parents) if (persons.has(id) && !persons.get(id)!.parent_families.length) show(id);
      if (!folded.has(family.id)) for (const id of family.children) if (persons.has(id)) show(id);
    }
  }
  return visible;
}

export function foldTree(tree: ClanTree, folded: ReadonlySet<number>): FoldedTree {
  const folds = new Map<number, FoldInfo>();
  if (!folded.size) return { tree, folds };

  const persons = new Map(tree.persons.map((p) => [p.id, p]));
  const visible = visiblePersons(tree, folded);

  const families: TreeFamily[] = [];
  for (const family of tree.families) {
    const parents = [family.husband, family.wife].filter((id): id is number => id != null && visible.has(id));
    if (!parents.length) continue;
    const isFolded = folded.has(family.id) && family.children.length > 0;
    if (isFolded) {
      folds.set(family.id, {
        family: family.id,
        descendants: descendantsOf(tree, family.id).size,
        children: family.children.map((id) => persons.get(id)).filter((p): p is TreePerson => p !== undefined),
      });
    }
    families.push({
      ...family,
      husband: family.husband != null && visible.has(family.husband) ? family.husband : null,
      wife: family.wife != null && visible.has(family.wife) ? family.wife : null,
      children: isFolded ? [] : family.children.filter((id) => visible.has(id)),
    });
  }

  const kept = new Map(families.map((f) => [f.id, f]));
  const prunedPersons = tree.persons
    .filter((p) => visible.has(p.id))
    .map((p) => ({
      ...p,
      parent_families: p.parent_families.filter((fid) => kept.get(fid)?.children.includes(p.id)),
      spouse_families: p.spouse_families.filter((fid) => kept.has(fid)),
    }));
  return { tree: { ...tree, persons: prunedPersons, families }, folds };
}

// свёрнутые союзы, за которыми спрятан человек: их надо развернуть, чтобы показать его
export function foldsHiding(tree: ClanTree, folded: ReadonlySet<number>, personId: number): number[] {
  if (!folded.size) return [];
  const persons = new Map(tree.persons.map((p) => [p.id, p]));
  const families = new Map(tree.families.map((f) => [f.id, f]));
  const out = new Set<number>();
  const seen = new Set<number>();
  const queue = [personId];
  while (queue.length) {
    const id = queue.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const person = persons.get(id);
    if (person && !person.parent_families.length) {
      // пришлый супруг виден через того, с кем в браке
      for (const fid of person.spouse_families) {
        const family = families.get(fid);
        const spouse = family?.husband === id ? family?.wife : family?.husband;
        if (spouse != null) queue.push(spouse);
      }
    }
    for (const fid of person?.parent_families ?? []) {
      if (folded.has(fid)) out.add(fid);
      const family = families.get(fid);
      for (const parent of [family?.husband, family?.wife]) if (parent != null) queue.push(parent);
    }
  }
  return [...out];
}
