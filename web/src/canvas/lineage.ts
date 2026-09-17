// Линия рода: путь от основателя к выбранному по уже нарисованным связям — нить союза от кровного
// родителя, ствол спуска, отрезок шины к нужному ребёнку и спуск к нему. У пришлого супруга линии нет.

import type { ClanTree, TreePerson } from "../api/types";
import type { LayoutResult } from "../layout/layout";
import type { StyleName } from "../layout/metrics";
import type { LinksSvg } from "./links";
import { LINK_STYLES } from "./styles";

export interface Lineage {
  paths: string; // d-атрибуты путей, без оформления
  persons: Set<number>; // люди на линии, выбранный включительно
}

const NONE: Lineage = { paths: "", persons: new Set() };

export function lineageOf(tree: ClanTree, layout: LayoutResult, style: StyleName, links: LinksSvg, personId: number): Lineage {
  const persons = new Map(tree.persons.map((p) => [p.id, p]));
  const families = new Map(tree.families.map((f) => [f.id, f]));
  const start = persons.get(personId);
  if (!start?.parent_families.length) return NONE;

  const inset = LINK_STYLES[style].inset; // газета отступает нитью от карточек
  const w = layout.cardWidth;
  const h = layout.cardHeight;
  const boxes = [...layout.positions.values()];
  // нить союза видна только в просветах между карточками — так же и подсветка
  const gaps = (x1: number, x2: number, level: number): [number, number][] => {
    const hit = boxes.filter((n) => n.y - 14 < level && level < n.y + h + 2 && n.x + w > x1 && n.x < x2).sort((a, b) => a.x - b.x);
    const out: [number, number][] = [];
    let cursor = x1;
    for (const n of hit) {
      if (n.x > cursor) out.push([cursor, Math.min(n.x, x2)]);
      cursor = Math.max(cursor, n.x + w);
    }
    if (cursor < x2) out.push([cursor, x2]);
    return out.filter((s) => s[1] - s[0] > 2);
  };

  const line = new Set<number>([personId]);
  let d = "";
  let child: TreePerson = start;
  while (child.parent_families.length) {
    const family = families.get(child.parent_families[0]!);
    const geometry = family && links.descents.get(family.id);
    if (!family || !geometry) break;
    const parents = [family.husband, family.wife]
      .map((id) => (id != null ? persons.get(id) : undefined))
      .filter((p): p is TreePerson => p !== undefined);
    // кровный родитель — у кого свои родители в роду; у основателей — первый записанный
    const parent = parents.find((p) => p.parent_families.length) ?? parents[0];
    if (!parent || line.has(parent.id)) break;

    const kid = layout.positions.get(child.id)!;
    const kx = kid.x + w / 2;
    if (geometry.curl) {
      d += geometry.curl;
    } else {
      const p = layout.positions.get(parent.id)!;
      const [x1, x2] = p.x < geometry.x ? [p.x + w, geometry.x] : [geometry.x, p.x];
      for (const [a, b] of gaps(x1, x2, geometry.y)) {
        // от карточек нить отступает, у ствола — нет: там она встречает спуск
        const from = a === geometry.x ? a : a + inset;
        const to = b === geometry.x ? b : b - inset;
        if (to - from > 1) d += `M${from} ${geometry.y}H${to}`;
      }
    }
    d += `M${geometry.x} ${geometry.y}V${geometry.bus}H${kx}V${kid.y - geometry.kidEnd}`;

    line.add(parent.id);
    child = parent;
  }
  return { paths: d, persons: line };
}
