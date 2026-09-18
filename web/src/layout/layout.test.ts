import { describe, expect, it } from "vitest";

import type { ClanTree } from "../api/types";
import gleannTree from "./fixtures/gleann.tree.json";
import monadhTree from "./fixtures/monadh.tree.json";
import golden from "./fixtures/stand-golden.json";
import { generations, layoutTree, type LayoutResult } from "./layout";
import { STYLE_METRICS, type StyleName } from "./metrics";

const TREES: Record<string, ClanTree> = {
  gleann: gleannTree as unknown as ClanTree,
  monadh: monadhTree as unknown as ClanTree,
};
const STYLES = Object.keys(STYLE_METRICS) as StyleName[];

// Эталон снят со стенда (prototype/src/stand_template.html) в десяти режимах: координаты всех людей.
// Совпадение до тысячной — значит, раскладка перенесена, а не переписана «по мотивам».
interface GoldenSample {
  clan: string;
  style: StyleName;
  ruler: boolean;
  root: string;
  height: number;
  positions: Record<string, [number, number]>;
}

describe("совпадает со стендом", () => {
  for (const sample of golden as unknown as GoldenSample[]) {
    const label = `${sample.clan}, ${sample.style}, ${sample.ruler ? "с линейкой" : "без линейки"}, основатель ${sample.root === "top" ? "сверху" : "снизу"}`;
    it(label, () => {
      const tree = TREES[sample.clan]!;
      const result = layoutTree(tree, STYLE_METRICS[sample.style], {
        ruler: sample.ruler,
        rootAtBottom: sample.root === "bottom",
      });
      expect(result.cardHeight).toBe(sample.height);

      const byXref = new Map(tree.persons.map((p) => [p.xref.replaceAll("@", ""), p.id]));
      expect(Object.keys(sample.positions).length).toBe(tree.persons.length);
      for (const [xref, [x, y]] of Object.entries(sample.positions)) {
        const point = result.positions.get(byXref.get(xref)!)!;
        expect(point.x, `${xref} x`).toBeCloseTo(x, 2);
        expect(point.y, `${xref} y`).toBeCloseTo(y, 2);
      }
    });
  }
});

function overlaps(result: LayoutResult): string[] {
  const cards = [...result.positions.entries()];
  const found: string[] = [];
  for (let i = 0; i < cards.length; i++) {
    for (let j = i + 1; j < cards.length; j++) {
      const [a, pa] = cards[i]!;
      const [b, pb] = cards[j]!;
      if (Math.abs(pa.x - pb.x) < result.cardWidth - 1 && Math.abs(pa.y - pb.y) < result.cardHeight - 1) {
        found.push(`${a}×${b}`);
      }
    }
  }
  return found;
}

describe("устройство дерева во всех стилях", () => {
  for (const [clan, tree] of Object.entries(TREES)) {
    for (const style of STYLES) {
      for (const ruler of [false, true]) {
        for (const rootAtBottom of [false, true]) {
          const label = `${clan}, ${style}, ${ruler ? "линейка" : "ярусы"}, ${rootAtBottom ? "снизу" : "сверху"}`;
          it(label, () => {
            const result = layoutTree(tree, STYLE_METRICS[style], { ruler, rootAtBottom });

            expect(result.positions.size, "каждый человек на полотне").toBe(tree.persons.length);
            expect(overlaps(result), "карточки не налезают").toEqual([]);

            for (const family of tree.families) {
              const parents = [family.husband, family.wife].filter((id): id is number => id != null);
              if (parents.length === 2) {
                expect(result.positions.get(parents[0]!)!.y, `супруги ${family.xref} вровень`).toBeCloseTo(
                  result.positions.get(parents[1]!)!.y,
                  6,
                );
              }
              for (const child of family.children) {
                const cy = result.positions.get(child)!.y;
                for (const parent of parents) {
                  const py = result.positions.get(parent)!.y;
                  if (rootAtBottom) expect(cy + result.cardHeight, `${family.xref}: ребёнок выше родителя`).toBeLessThanOrEqual(py);
                  else expect(cy, `${family.xref}: ребёнок ниже родителя`).toBeGreaterThanOrEqual(py + result.cardHeight);
                }
              }
            }
          });
        }
      }
    }
  }
});

describe("правила порядка", () => {
  const tree = TREES.monadh!;
  const metrics = STYLE_METRICS.viktorian;
  const byXref = (xref: string) => tree.persons.find((p) => p.xref === xref)!.id;

  it("старший брат левее младшего", () => {
    const result = layoutTree(tree, metrics, { ruler: false, rootAtBottom: false });
    const roberts = tree.families.find((f) => f.children.includes(byXref("@I526@")))!;
    const xs = roberts.children.map((id) => ({
      year: tree.persons.find((p) => p.id === id)!.birth?.year ?? Infinity,
      x: result.positions.get(id)!.x,
    }));
    const byYear = [...xs].sort((a, b) => a.year - b.year).map((c) => c.x);
    expect(byYear).toEqual([...byYear].sort((a, b) => a - b));
  });

  it("ручной сдвиг правее меняет место среди братьев", () => {
    const family = tree.families.find((f) => f.children.length >= 3)!;
    const first = family.children[0]!;
    const plain = layoutTree(tree, metrics, { ruler: false, rootAtBottom: false });
    const moved = layoutTree(tree, metrics, { ruler: false, rootAtBottom: false, manual: new Map([[first, 1]]) });
    const order = (r: LayoutResult) =>
      [...family.children].sort((a, b) => r.positions.get(a)!.x - r.positions.get(b)!.x);
    expect(order(moved)).not.toEqual(order(plain));
    expect(order(moved).indexOf(first)).toBe(order(plain).indexOf(first) + 1);
  });

  it("многобрачный стоит с краю, жёны по очереди браков", () => {
    const result = layoutTree(tree, metrics, { ruler: false, rootAtBottom: false });
    const malcolm = byXref("@I538@");
    const wives = tree.persons
      .find((p) => p.id === malcolm)!
      .spouse_families.map((f) => tree.families.find((fam) => fam.id === f)!.wife!);
    const xs = [...wives, malcolm].map((id) => result.positions.get(id)!.x);
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
  });
});

describe("поколения", () => {
  it("супруг-пришлый встаёт на ярус мужа, дети ярусом ниже", () => {
    const tree = {
      clan: { id: 1, name: "проба", persons: 4, families: 2 },
      persons: [1, 2, 3, 4].map((id) => ({
        id, xref: `@I${id}@`, given: null, surname: null, married_surname: null, sex: null,
        is_branch_stub: false, birth: null, death: null, parent_families: [], spouse_families: [],
        tags: [], burnt: false, hidden: false, heir: false, portrait: "auto" as const, photo: null,
      })),
      families: [
        { id: 10, xref: "@F10@", husband: 1, wife: null, children: [2], child_pedigree: ["birth"], divorced: false },
        { id: 11, xref: "@F11@", husband: 2, wife: 3, children: [4], child_pedigree: ["birth"], divorced: false },
      ],
      tags: [],
    } satisfies ClanTree;
    expect(Object.fromEntries(generations(tree))).toEqual({ 1: 0, 2: 1, 3: 1, 4: 2 });
  });
});
