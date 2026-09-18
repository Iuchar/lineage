// Окружение человека для проверки связки: родители с их союзом, супруги и дети — маленькое дерево,
// которое рисуется тем же раскладчиком, что и карта. По нему тёзки из разных семей расходятся сразу.

import type { ClanTree, TreeFamily, TreePerson } from "../api/types";

export function around(tree: ClanTree, personId: number): ClanTree {
  const persons = new Map(tree.persons.map((p) => [p.id, p]));
  const families = new Map(tree.families.map((f) => [f.id, f]));
  const self = persons.get(personId);
  if (!self) return { clan: tree.clan, persons: [], families: [] };

  const kept: TreeFamily[] = [];
  const ids = new Set<number>([personId]);
  const parents = families.get(self.parent_families[0] ?? -1);
  if (parents) {
    // из братьев и сестёр — только он сам: окружение про его семью, а не про весь выводок
    kept.push({ ...parents, children: [personId] });
    for (const id of [parents.husband, parents.wife]) if (id != null) ids.add(id);
  }
  for (const fid of self.spouse_families) {
    const family = families.get(fid);
    if (!family) continue;
    kept.push({ ...family, children: [...family.children] });
    for (const id of [family.husband, family.wife, ...family.children]) if (id != null) ids.add(id);
  }

  const keptIds = new Set(kept.map((f) => f.id));
  const cut = (p: TreePerson): TreePerson => ({
    ...p,
    parent_families: p.parent_families.filter((f) => keptIds.has(f)),
    spouse_families: p.spouse_families.filter((f) => keptIds.has(f)),
  });
  // порядок людей — как в роду: раскладка опирается на порядок записи
  return { clan: tree.clan, persons: tree.persons.filter((p) => ids.has(p.id)).map(cut), families: kept };
}
