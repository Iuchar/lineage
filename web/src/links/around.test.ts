import { describe, expect, it } from "vitest";

import type { ClanTree } from "../api/types";
import { layoutTree } from "../layout/layout";
import gleannTree from "../layout/fixtures/gleann.tree.json";
import { STYLE_METRICS } from "../layout/metrics";
import { around } from "./around";

const gleann = gleannTree as unknown as ClanTree;
const byXref = (xref: string) => gleann.persons.find((p) => p.xref === xref)!;
const names = (tree: ClanTree) => tree.persons.map((p) => p.given).sort();

describe("окружение для проверки связки", () => {
  it("родители, супруги и дети — без братьев и дальней родни", () => {
    const eogan = gleann.persons.find((p) => p.given === "Эоган" && p.birth?.year === 1719)!;
    const small = around(gleann, eogan.id);
    // у Эогана в Гленн Уриск: родители Ниалл и Мор, брат Тормод в окружение не попадает
    expect(names(small)).toContain("Ниалл");
    expect(names(small)).toContain("Мор");
    expect(names(small)).not.toContain("Тормод");
  });

  it("ссылки ведут только на оставшихся — дерево раскладывается", () => {
    for (const person of gleann.persons) {
      const small = around(gleann, person.id);
      const ids = new Set(small.persons.map((p) => p.id));
      for (const f of small.families) {
        for (const id of [f.husband, f.wife, ...f.children]) if (id != null) expect(ids.has(id)).toBe(true);
      }
      for (const p of small.persons) {
        for (const fid of [...p.parent_families, ...p.spouse_families]) {
          expect(small.families.some((f) => f.id === fid)).toBe(true);
        }
      }
      expect(() => layoutTree(small, STYLE_METRICS.gobelen, { ruler: false, rootAtBottom: false })).not.toThrow();
    }
  });

  it("неизвестный человек — пустое окружение", () => {
    expect(around(gleann, -1).persons).toEqual([]);
    expect(byXref("@I1001@")).toBeDefined();
  });
});
