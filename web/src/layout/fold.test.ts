import { describe, expect, it } from "vitest";

import type { ClanTree } from "../api/types";
import { drawLinks } from "../canvas/links";
import gleannTree from "./fixtures/gleann.tree.json";
import monadhTree from "./fixtures/monadh.tree.json";
import { descendantsOf, foldsHiding, foldTree } from "./fold";
import { layoutTree } from "./layout";
import { STYLE_METRICS, type StyleName } from "./metrics";

const monadh = monadhTree as unknown as ClanTree;
const gleann = gleannTree as unknown as ClanTree;
const byXref = (tree: ClanTree, xref: string) => tree.persons.find((p) => p.xref === xref)!;
const founderFamily = (tree: ClanTree) => byXref(tree, "@I575@").spouse_families[0]!;

describe("свёрнутые ветки", () => {
  it("без свёрнутых дерево то же самое", () => {
    const { tree, folds } = foldTree(monadh, new Set());
    expect(tree).toBe(monadh);
    expect(folds.size).toBe(0);
  });

  it("союз свёрнут: потомки скрыты, пара и её браки на месте", () => {
    const man = byXref(monadh, "@I538@");
    const family = man.spouse_families[0]!; // брак с Ионой, сын Финлэй
    const hidden = descendantsOf(monadh, family);
    const { tree, folds } = foldTree(monadh, new Set([family]));

    expect(folds.get(family)?.descendants).toBe(hidden.size);
    expect(folds.get(family)?.children.map((p) => p.given)).toEqual(["Финлэй"]);
    const ids = new Set(tree.persons.map((p) => p.id));
    for (const id of hidden) expect(ids.has(id)).toBe(false);
    expect(tree.persons.find((p) => p.id === man.id)?.spouse_families).toEqual(man.spouse_families);
    expect(tree.families.find((f) => f.id === family)?.children).toEqual([]);
    // все ссылки ведут на оставшихся
    for (const f of tree.families) {
      for (const id of [f.husband, f.wife, ...f.children]) if (id != null) expect(ids.has(id)).toBe(true);
    }
  });

  it("супруг потомка уходит вместе с ним", () => {
    const root = monadh.families.find((f) => f.id === founderFamily(monadh))!;
    const { tree } = foldTree(monadh, new Set([root.id]));
    const loners = monadh.persons.filter((p) => !p.parent_families.length && !p.spouse_families.length).map((p) => p.id);
    expect(tree.persons.map((p) => p.id).sort()).toEqual([root.husband!, root.wife!, ...loners].sort());
    expect(tree.persons.some((p) => p.xref === "@I52@")).toBe(false); // пришлая жена потомка
  });

  it("поиск разворачивает ветки на пути к человеку, в том числе к пришлому супругу", () => {
    const root = founderFamily(monadh);
    const inLaw = byXref(monadh, "@I52@");
    expect(foldsHiding(monadh, new Set([root]), inLaw.id)).toEqual([root]);
    const man = byXref(monadh, "@I538@");
    expect(foldsHiding(monadh, new Set([man.spouse_families[1]!]), man.id)).toEqual([]);
  });

  it("основатели со свёрнутой веткой стоят парой", () => {
    const folded = new Set([founderFamily(monadh)]);
    const { tree } = foldTree(monadh, folded);
    const metrics = STYLE_METRICS.viktorian;
    const layout = layoutTree(tree, metrics, { ruler: false, rootAtBottom: false, folded });
    const [a, b] = tree.persons.map((p) => layout.positions.get(p.id)!);
    expect(Math.abs(a!.x - b!.x)).toBe(metrics.width + metrics.pairGap);
    expect(a!.y).toBe(b!.y);
  });

  it("под стопкой оставлено место: широкий выводок брата под неё не заезжает", () => {
    // основатели 1+2; сын 3 с женой 4 и одним ребёнком (ветка свёрнута); сын 5 с женой 6 и восемью детьми
    const person = (id: number, year: number, parents: number[], spouses: number[]) => ({
      id, xref: `@I${id}@`, given: `П${id}`, surname: null, married_surname: null, sex: "M", is_branch_stub: false,
      birth: { raw: String(year), kind: "exact", year, month: null, day: null, end_year: null, end_month: null, end_day: null, phrase: null },
      death: null, parent_families: parents, spouse_families: spouses,
    });
    const kids = [8, 9, 10, 11, 12, 13, 14, 15];
    const source = {
      clan: monadh.clan,
      persons: [
        person(1, 1870, [], [100]), person(2, 1872, [], [100]),
        person(3, 1900, [100], [101]), person(4, 1901, [], [101]), person(7, 1925, [101], []),
        person(5, 1902, [100], [102]), person(6, 1903, [], [102]),
        ...kids.map((id, i) => person(id, 1926 + i, [102], [])),
      ],
      families: [
        { id: 100, husband: 1, wife: 2, children: [3, 5] },
        { id: 101, husband: 3, wife: 4, children: [7] },
        { id: 102, husband: 5, wife: 6, children: kids },
      ],
    } as unknown as ClanTree;
    const { tree, folds } = foldTree(source, new Set([101]));
    const folded = new Set(folds.keys());
    const layout = layoutTree(tree, STYLE_METRICS.viktorian, { ruler: false, rootAtBottom: false, folded });
    const links = drawLinks(tree, layout, "viktorian", (_, fallback) => fallback, undefined, folded);
    const anchor = links.folds[0]!;
    const leftmostKid = Math.min(...kids.map((id) => layout.positions.get(id)!.x));
    expect(leftmostKid).toBeGreaterThanOrEqual(anchor.x + 60);
  });

  // под стопкой не должно оказаться ни карточки, ни чужого спуска
  const STYLES: StyleName[] = ["gobelen", "viktorian", "gazeta", "kabinet", "polotno"];
  for (const [name, source] of [["Монад", monadh], ["Гленн", gleann]] as const) {
    it(`${name}: стопка не залезает на карточки ни в одном стиле`, () => {
      // сворачиваем каждый второй союз с детьми
      const folded = new Set(source.families.filter((f) => f.children.length).filter((_, i) => i % 2).map((f) => f.id));
      const { tree, folds } = foldTree(source, folded);
      const foldedIds = new Set(folds.keys());
      for (const style of STYLES) {
        for (const [ruler, rootAtBottom] of [[false, false], [true, false], [false, true], [true, true]] as const) {
          const layout = layoutTree(tree, STYLE_METRICS[style], { ruler, rootAtBottom, folded: foldedIds });
          const links = drawLinks(tree, layout, style, (_, fallback) => fallback, undefined, foldedIds);
          for (const anchor of links.folds) {
            const box = anchor.up
              ? { l: anchor.x - 60, r: anchor.x + 60, t: anchor.y - 52, b: anchor.y }
              : { l: anchor.x - 60, r: anchor.x + 60, t: anchor.y, b: anchor.y + 52 };
            expect(anchor.up).toBe(rootAtBottom);
            for (const p of layout.positions.values()) {
              const overlap =
                p.x < box.r && p.x + layout.cardWidth > box.l && p.y < box.b && p.y + layout.cardHeight > box.t;
              expect(overlap, `${style} ruler=${ruler} family=${anchor.family}`).toBe(false);
            }
            // горизонтальные нити — шины чужих выводков и браки
            for (const [, x1, y, x2] of links.paths.matchAll(/M([\d.-]+) ([\d.-]+)H([\d.-]+)/g)) {
              const [l, r] = [Number(x1), Number(x2)].sort((m, n) => m - n);
              const crosses = Number(y) > box.t && Number(y) < box.b && l! < box.r && r! > box.l;
              expect(crosses, `${style} ruler=${ruler} bottom=${rootAtBottom} family=${anchor.family} y=${y} x=${x1}..${x2} anchor=${anchor.x},${anchor.y}`).toBe(false);
            }
          }
          expect(links.folds.length).toBe(foldedIds.size);
        }
      }
    });
  }
});
