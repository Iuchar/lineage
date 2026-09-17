import { describe, expect, it } from "vitest";

import type { ClanTree, TreePerson } from "../api/types";
import { estimateBirthYears } from "./estimate";
import gleannTree from "./fixtures/gleann.tree.json";
import monadhTree from "./fixtures/monadh.tree.json";
import { layoutTree } from "./layout";
import { STYLE_METRICS } from "./metrics";

const date = (year: number) => ({ raw: String(year), kind: "exact", year, month: null, day: null, end_year: null, end_month: null, end_day: null, phrase: null });

// маленький род: id → год (null — неизвестен), семьи — [муж, жена, дети]
function clan(years: Record<number, number | null>, families: [number | null, number | null, number[]][], deaths: Record<number, number> = {}): ClanTree {
  const persons: TreePerson[] = Object.entries(years).map(([id, year]) => ({
    id: Number(id), xref: `@I${id}@`, given: `П${id}`, surname: null, married_surname: null, sex: "U", is_branch_stub: false,
    birth: year == null ? null : date(year), death: deaths[Number(id)] ? date(deaths[Number(id)]!) : null,
    parent_families: families.flatMap(([, , kids], i) => (kids.includes(Number(id)) ? [100 + i] : [])),
    spouse_families: families.flatMap(([h, w], i) => (h === Number(id) || w === Number(id) ? [100 + i] : [])),
  })) as TreePerson[];
  return {
    clan: { id: 1, name: "проба", persons: persons.length, families: families.length },
    persons,
    families: families.map(([husband, wife, children], i) => ({ id: 100 + i, xref: `@F${i}@`, husband, wife, children })),
  } as ClanTree;
}

describe("оценка года рождения", () => {
  it("по братьям и сёстрам — середина их годов", () => {
    const tree = clan({ 1: 1700, 2: 1705, 3: 1730, 4: null, 5: 1740 }, [[1, 2, [3, 4, 5]]]);
    expect(estimateBirthYears(tree).get(4)).toBe(1735);
  });

  it("середина братьев зажата границей: не позже первого ребёнка − 15", () => {
    // братья 1730 и 1760, но у человека ребёнок 1740 — родиться позже 1725 он не мог
    const tree = clan({ 1: 1700, 2: 1705, 3: 1730, 4: null, 5: 1760, 6: 1742, 7: 1740 }, [[1, 2, [3, 4, 5]], [4, 6, [7]]]);
    expect(estimateBirthYears(tree).get(4)).toBe(1725);
  });

  it("без братьев — середина между родителями + 15 и детьми − 15", () => {
    const tree = clan({ 1: 1900, 2: 1902, 3: null, 4: 1950, 5: 1980 }, [[1, 2, [3]], [3, 4, [5]]]);
    expect(estimateBirthYears(tree).get(3)).toBe(1941); // между 1917 и 1965
  });

  it("поздний ребёнок в 50 лет: одна граница — ребёнок − 30", () => {
    const tree = clan({ 1: null, 2: 1948, 3: 1975, 4: 2000 }, [[1, 2, []], [1, 3, [4]]]);
    expect(estimateBirthYears(tree).get(1)).toBe(1970);
  });

  it("только супруги 1940, 1980, 1955 — середина ряда, а не среднее", () => {
    const tree = clan({ 1: null, 2: 1940, 3: 1980, 4: 1955 }, [[1, 2, []], [1, 3, []], [1, 4, []]]);
    expect(estimateBirthYears(tree).get(1)).toBe(1955);
  });

  it("супруги зажаты годом смерти", () => {
    const tree = clan({ 1: null, 2: 1960 }, [[1, 2, []]], { 1: 1950 });
    expect(estimateBirthYears(tree).get(1)).toBe(1950);
  });

  it("заглушки и люди без единой зацепки не оцениваются", () => {
    const tree = clan({ 1: 1700, 2: null, 3: null }, [[1, null, [2]]]);
    const stub = { ...tree, persons: tree.persons.map((p) => (p.id === 2 ? { ...p, is_branch_stub: true } : p)) };
    expect(estimateBirthYears(stub).has(2)).toBe(false);
    expect(estimateBirthYears(stub).has(3)).toBe(false);
  });

  // у каждого настоящего человека по очереди убирается год и сравнивается оценка с правдой
  for (const [name, source] of [["Монад Кройве", monadhTree], ["Гленн Уриск", gleannTree]] as const) {
    it(`${name}: оценка близка к настоящему году, старшинство братьев сохраняется`, () => {
      const tree = source as unknown as ClanTree;
      const errors: number[] = [];
      let orderKept = 0;
      let withSiblings = 0;
      for (const person of tree.persons) {
        const truth = person.birth?.year;
        if (person.is_branch_stub || truth == null) continue;
        const without = { ...tree, persons: tree.persons.map((p) => (p.id === person.id ? { ...p, birth: null } : p)) };
        const estimate = estimateBirthYears(without).get(person.id);
        if (estimate == null) continue;
        errors.push(Math.abs(estimate - truth));

        const family = tree.families.find((f) => f.id === person.parent_families[0]);
        const brood = family?.children.filter((c) => tree.persons.find((p) => p.id === c)?.birth?.year != null) ?? [];
        if (brood.length < 2) continue;
        withSiblings++;
        const order = (t: ClanTree) => {
          const layout = layoutTree(t, STYLE_METRICS.viktorian, { ruler: false, rootAtBottom: false });
          return [...brood].sort((a, b) => layout.positions.get(a)!.x - layout.positions.get(b)!.x);
        };
        if (JSON.stringify(order(tree)) === JSON.stringify(order(without))) orderKept++;
      }
      errors.sort((a, b) => a - b);
      const med = errors[Math.floor(errors.length / 2)]!;
      process.stderr.write(`${name}: оценено ${errors.length}, промах медиана ${med}, 90% ≤ ${errors[Math.floor(errors.length * 0.9)]}, наибольший ${errors.at(-1)}; порядок братьев сохранён ${orderKept} из ${withSiblings}
`);
      expect(med).toBeLessThanOrEqual(8);
      // порядок среди братьев — по записи семьи, а в файлах дети записаны по старшинству
      expect(orderKept).toBe(withSiblings);
    });
  }
});
