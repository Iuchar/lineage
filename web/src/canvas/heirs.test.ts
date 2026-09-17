import { describe, expect, it } from "vitest";

import type { ClanTree } from "../api/types";
import gleannTree from "../layout/fixtures/gleann.tree.json";
import monadhTree from "../layout/fixtures/monadh.tree.json";
import { layoutTree } from "../layout/layout";
import { STYLE_METRICS } from "../layout/metrics";
import { mainLine } from "./heirs";

const monadh = monadhTree as unknown as ClanTree;
const gleann = gleannTree as unknown as ClanTree;
const ids = (tree: ClanTree, xrefs: string[]) =>
  new Set(tree.persons.filter((p) => xrefs.includes(p.xref)).map((p) => p.id));
const byXref = (tree: ClanTree, xref: string) => tree.persons.find((p) => p.xref === xref)!;

// отметки продолжателей: те же цепочки, что в демо-наборе
const MONADH = ["@I51@", "@I53@", "@I511@", "@I518@", "@I526@", "@I544@"]; // кончается Уильямом, детей нет
const GLEANN = ["@I1003@", "@I1007@", "@I1011@", "@I1016@", "@I1019@", "@I1024@", "@I1029@", "@I1035@", "@I1038@"];

describe("главная линия", () => {
  it("без отметок линии нет", () => {
    const line = mainLine(monadh, new Set());
    expect(line.persons.size).toBe(0);
    expect(line.last).toBeNull();
    expect(line.broken).toBe(false);
  });

  it("основатель встаёт в линию сам, хотя не отмечен", () => {
    const line = mainLine(monadh, ids(monadh, MONADH));
    const names = monadh.persons.filter((p) => line.persons.has(p.id)).map((p) => p.given);
    expect(names).toEqual(["Хэмиш", "Юэн", "Кайл", "Иэйн", "Роберт", "Уильям", "Дункан"]);
    expect(line.last).toBe(byXref(monadh, "@I544@").id);
  });

  it("детей у последнего нет — линия пресеклась", () => {
    expect(mainLine(monadh, ids(monadh, MONADH)).broken).toBe(true);
  });

  it("линия уходит в другой род через заглушку — обрыва нет", () => {
    const line = mainLine(gleann, ids(gleann, GLEANN));
    expect(line.last).toBe(byXref(gleann, "@I1038@").id); // Ветвь Уинтерхоуп
    expect(line.broken).toBe(false);
    expect(line.persons.size).toBe(GLEANN.length + 1);
  });

  it("обрыва нет, пока у последнего есть дети без отметки", () => {
    const short = MONADH.slice(0, 3); // до Кайла, у него есть дети
    expect(mainLine(monadh, ids(monadh, short)).broken).toBe(false);
  });

  it("из спорных отметок берётся длинная цепочка", () => {
    const withStray = new Set([...ids(monadh, MONADH), ...ids(monadh, ["@I536@"])]);
    const line = mainLine(monadh, withStray);
    expect(line.last).toBe(byXref(monadh, "@I544@").id);
  });
});

describe("ствол по отметкам", () => {
  const metrics = STYLE_METRICS.gobelen;
  const options = { ruler: false, rootAtBottom: false };

  it("пара встаёт над продолжателем, а не между крайними детьми", () => {
    const heirs = ids(monadh, MONADH);
    const plain = layoutTree(monadh, metrics, options);
    const trunk = layoutTree(monadh, metrics, { ...options, heirs });
    const centre = (layout: ReturnType<typeof layoutTree>, id: number) =>
      layout.positions.get(id)!.x + layout.cardWidth / 2;

    for (const xref of MONADH) {
      const child = byXref(monadh, xref);
      const family = monadh.families.find((f) => f.id === child.parent_families[0])!;
      const pair = [family.husband, family.wife].filter((id): id is number => id != null);
      const union = pair.reduce((sum, id) => sum + centre(trunk, id), 0) / pair.length;
      expect(Math.abs(union - centre(trunk, child.id))).toBeLessThan(0.51);
    }
    // без отметок пара стоит между крайними детьми — сдвиг настоящий
    expect(centre(plain, byXref(monadh, "@I526@").id)).not.toBe(centre(trunk, byXref(monadh, "@I526@").id));
  });

  it("карточки после сдвига не налезают друг на друга", () => {
    const trunk = layoutTree(monadh, metrics, { ...options, heirs: ids(monadh, MONADH) });
    const points = [...trunk.positions.values()];
    for (let i = 0; i < points.length; i++) {
      for (let j = i + 1; j < points.length; j++) {
        const a = points[i]!;
        const b = points[j]!;
        expect(Math.abs(a.x - b.x) >= trunk.cardWidth || Math.abs(a.y - b.y) >= trunk.cardHeight).toBe(true);
      }
    }
  });
});
