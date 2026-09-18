// Родня без родителей, приёмные и развод: раскладка и связи на живом роде Монад Кройве.
import { describe, expect, it } from "vitest";
import type { ClanTree, TreeFamily, TreePerson } from "../api/types";
import { drawLinks } from "../canvas/links";
import monadhTree from "./fixtures/monadh.tree.json";
import { foldTree } from "./fold";
import { generations, layoutTree, primaryFamilies } from "./layout";
import { STYLE_METRICS } from "./metrics";

const base = monadhTree as unknown as ClanTree;
const DUNCAN = base.persons.find((p) => p.xref === "@I575@")!;
const options = { ruler: false, rootAtBottom: false };
const noColor = (_: string, fallback: string) => fallback;

const person = (id: number, given: string, extra: Partial<TreePerson> = {}): TreePerson => ({
  ...DUNCAN, id, xref: `@N${id}@`, given, birth: null, death: null, parent_families: [], spouse_families: [], ...extra,
});

// у Дункана брат, родители обоих не записаны: семья, где одни дети
function withBrother(): ClanTree {
  const family: TreeFamily = { id: 900, xref: "@F900@", husband: null, wife: null, children: [DUNCAN.id, 901],
    child_pedigree: ["birth", "birth"], divorced: false };
  return {
    ...base,
    persons: [...base.persons.map((p) => (p.id === DUNCAN.id ? { ...p, parent_families: [900] } : p)),
      person(901, "Алистер", { parent_families: [900] })],
    families: [...base.families, family],
  };
}

describe("братья без родителей", () => {
  it("стоят рядом на верхнем ярусе, род Дункана под ним целиком", () => {
    const tree = withBrother();
    const gen = generations(tree);
    expect(gen.get(DUNCAN.id)).toBe(0);
    expect(gen.get(901)).toBe(0);
    const layout = layoutTree(tree, STYLE_METRICS.gobelen, options);
    expect(layout.positions.size).toBe(tree.persons.length);
    const duncan = layout.positions.get(DUNCAN.id)!;
    const brother = layout.positions.get(901)!;
    expect(brother.y).toBe(duncan.y);
    expect(brother.x).toBeGreaterThan(duncan.x);
    // над ними место под шину, узел и подпись
    expect(duncan.y).toBeGreaterThanOrEqual(64);
    // основатель снизу: братья на нижнем ярусе, над ними всё так же шина и узел
    const flipped = layoutTree(tree, STYLE_METRICS.gobelen, { ruler: false, rootAtBottom: true });
    expect(flipped.positions.get(901)!.y).toBe(flipped.positions.get(DUNCAN.id)!.y);
    expect(drawLinks(tree, flipped, "gobelen", noColor).marks).toContain("родители не записаны");
    // без брата раскладка прежняя: все на своих местах
    const plain = layoutTree(base, STYLE_METRICS.gobelen, options);
    expect(plain.positions.size).toBe(base.persons.length);
  });

  it("свёрнутая ветка не рассыпает братьев без родителей", () => {
    const tree = withBrother();
    const union = DUNCAN.spouse_families[0]!;
    const { tree: shown } = foldTree(tree, new Set([union]));
    // видны братья, жена Дункана — и всё; семья без родителей на месте
    expect(shown.persons.map((p) => p.id).sort()).toEqual([DUNCAN.id, 901, tree.families.find((f) => f.id === union)!.wife!].sort());
    expect(shown.families.find((f) => f.id === 900)?.children).toEqual([DUNCAN.id, 901]);
  });

  it("узел с подписью над шиной, шина — место для плюса брата", () => {
    const tree = withBrother();
    const layout = layoutTree(tree, STYLE_METRICS.viktorian, options);
    const links = drawLinks(tree, layout, "viktorian", noColor);
    expect(links.marks).toContain("родители не записаны");
    const geometry = links.descents.get(900)!;
    expect(geometry.bus).toBe(layout.positions.get(DUNCAN.id)!.y - 30);
    expect(links.unions.has(900)).toBe(false);
  });
});

describe("приёмные", () => {
  it("человек из двух семей стоит под приёмной, спуск к нему пунктиром", () => {
    const murdo = base.persons.find((p) => p.spouse_families.length === 1 && base.families.find((f) => f.id === p.spouse_families[0])!.children.length > 1)!;
    const adoptive = base.families.find((f) => f.id === murdo.spouse_families[0])!;
    const kid = adoptive.children[0]!;
    const birth: TreeFamily = { id: 950, xref: "@F950@", husband: 951, wife: null, children: [kid], child_pedigree: ["birth"], divorced: false };
    const tree: ClanTree = {
      ...base,
      persons: [...base.persons.map((p) => (p.id === kid ? { ...p, parent_families: [950, adoptive.id] } : p)),
        person(951, "Родной", { spouse_families: [950] })],
      families: [...base.families.map((f) => (f.id === adoptive.id ? { ...f, child_pedigree: f.children.map((c) => (c === kid ? "adopted" : "birth")) } : f)), birth],
    };
    expect(primaryFamilies(tree).get(kid)).toBe(adoptive.id);
    const layout = layoutTree(tree, STYLE_METRICS.gazeta, options);
    const links = drawLinks(tree, layout, "gazeta", noColor);
    expect(links.paths).toContain('stroke-dasharray="5 4"');
    // от родной семьи спуска к нему нет — он там только строкой в панели
    expect(links.descents.has(950)).toBe(false);
  });
});

describe("развод", () => {
  it("разведённый единственный союз рисуется как прошлый", () => {
    const family = base.families.find((f) => f.husband === DUNCAN.id)!;
    const tree: ClanTree = { ...base, families: base.families.map((f) => (f.id === family.id ? { ...f, divorced: true } : f)) };
    const layout = layoutTree(tree, STYLE_METRICS.gazeta, options);
    const before = drawLinks(base, layout, "gazeta", noColor);
    const after = drawLinks(tree, layout, "gazeta", noColor);
    expect(after.paths.split('stroke-dasharray="4 4"').length).toBeGreaterThan(before.paths.split('stroke-dasharray="4 4"').length);
    expect(after.unions.get(family.id)).toEqual(before.unions.get(family.id));
  });
});
