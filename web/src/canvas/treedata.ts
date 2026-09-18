// Что рисует карта сверх родства — из самого дерева рода: состояния, метки, главная линия, портреты.
// Всё это хранится в записях людей (служебные теги GEDCOM) и приходит вместе с деревом.

import type { ClanTree } from "../api/types";
import type { PersonMarks } from "./cards";
import { TAG_COLORS, type Tag, type TagColor, type TagSet } from "./tags";

export interface TreeData {
  marks: PersonMarks;
  tags: TagSet;
  heirs: ReadonlySet<number>;
  photos: ReadonlyMap<number, string>; // значение для CSS: url('…')
  noPortrait: ReadonlySet<number>; // портрет выключен у этого человека
}

const color = (name: string): TagColor => (name in TAG_COLORS ? (name as TagColor) : "дымный");

export function treeData(tree: ClanTree): TreeData {
  const list: Tag[] = tree.tags.map((t) => ({ id: t.name, name: t.name, color: color(t.color) }));
  // метка без записи в наборе рода (пришла из чужого файла) — всё равно видна, цветом «дымный»
  for (const person of tree.persons) {
    for (const name of person.tags) {
      if (!list.some((t) => t.id === name)) list.push({ id: name, name, color: "дымный" });
    }
  }
  const of = new Map<number, string[]>();
  const photos = new Map<number, string>();
  const noPortrait = new Set<number>();
  for (const person of tree.persons) {
    if (person.tags.length) of.set(person.id, person.tags);
    if (person.portrait === "none") noPortrait.add(person.id);
    // «заглушка» — снимок есть, но показывается профиль
    else if (person.photo && person.portrait === "auto") photos.set(person.id, `url('${person.photo}')`);
  }
  return {
    marks: {
      burnt: new Set(tree.persons.filter((p) => p.burnt).map((p) => p.id)),
      hidden: new Set(tree.persons.filter((p) => p.hidden).map((p) => p.id)),
    },
    tags: { list, of },
    heirs: new Set(tree.persons.filter((p) => p.heir).map((p) => p.id)),
    photos,
    noPortrait,
  };
}

// демо-набор разработчика (?demo=marks) ложится поверх настоящих данных
export function mergeData(real: TreeData, demo: Partial<Pick<TreeData, "marks" | "tags" | "heirs">>): TreeData {
  const union = (a: ReadonlySet<number>, b?: ReadonlySet<number>) => new Set([...a, ...(b ?? [])]);
  const of = new Map(real.tags.of);
  for (const [id, names] of demo.tags?.of ?? []) of.set(id, [...new Set([...(of.get(id) ?? []), ...names])]);
  return {
    ...real,
    marks: { burnt: union(real.marks.burnt, demo.marks?.burnt), hidden: union(real.marks.hidden, demo.marks?.hidden) },
    tags: { list: [...real.tags.list, ...(demo.tags?.list ?? []).filter((t) => !real.tags.list.some((r) => r.id === t.id))], of },
    heirs: union(real.heirs, demo.heirs),
  };
}
