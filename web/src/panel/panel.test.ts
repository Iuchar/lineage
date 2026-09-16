import { describe, expect, it } from "vitest";

import type { ClanTree } from "../api/types";
import monadhTree from "../layout/fixtures/monadh.tree.json";
import { relativesOf } from "./relatives";
import { findPersons } from "./search";

const tree = monadhTree as unknown as ClanTree;
const byXref = (xref: string) => tree.persons.find((p) => p.xref === xref)!;
const names = (list: { given: string | null }[]) => list.map((p) => p.given);

describe("родня", () => {
  it("браки по очереди, у каждого свои дети", () => {
    const rel = relativesOf(tree, byXref("@I538@").id);
    expect(rel.marriages.map((m) => m.spouse?.given)).toEqual(["Иона", "Финнула", "Элспет"]);
    expect(rel.marriages.map((m) => names(m.children))).toEqual([["Финлэй"], ["Диан"], ["Кеннет"]]);
    expect([rel.father?.given, rel.mother?.given]).toEqual(["Роберт", "Мэри"]);
    expect(rel.siblings.length).toBeGreaterThan(0);
  });

  it("у основателя родителей нет", () => {
    const rel = relativesOf(tree, byXref("@I575@").id);
    expect([rel.father, rel.mother]).toEqual([null, null]);
    expect(rel.siblings).toEqual([]);
  });
});

describe("поиск", () => {
  it("точное имя выше похожего", () => {
    expect(findPersons(tree, "мор")[0]?.given).toBe("Мор");
  });

  it("ищет по фамилии по мужу и по двум словам, ё и е равны", () => {
    expect(findPersons(tree, "изабелла монад").map((p) => p.xref)).toContain("@I52@");
    expect(findPersons(tree, "стюарт").map((p) => p.xref)).toContain("@I52@");
  });

  it("пустой запрос и промах", () => {
    expect(findPersons(tree, "   ")).toEqual([]);
    expect(findPersons(tree, "никтоненайдётся")).toEqual([]);
  });

  it("заглушки после людей", () => {
    const hits = findPersons(tree, "данбар");
    const stubAt = hits.findIndex((p) => p.is_branch_stub);
    const personAt = hits.findIndex((p) => !p.is_branch_stub);
    if (stubAt >= 0 && personAt >= 0) expect(personAt).toBeLessThan(stubAt);
  });
});
