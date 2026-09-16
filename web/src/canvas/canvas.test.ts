import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { ClanTree } from "../api/types";
import { cardName, formatDate, lifeYears } from "../format";
import gleannTree from "../layout/fixtures/gleann.tree.json";
import monadhTree from "../layout/fixtures/monadh.tree.json";
import { layoutTree } from "../layout/layout";
import { STYLE_METRICS, type StyleName } from "../layout/metrics";
import standLinks from "./fixtures/stand-links.json";
import { drawLinks } from "./links";
import { tickStep } from "./ruler";
import { centreOn, fitAll, keepAnchor, zoomAt } from "./view";

const TREES: Record<string, ClanTree> = {
  gleann: gleannTree as unknown as ClanTree,
  monadh: monadhTree as unknown as ClanTree,
};

// переменные тёмной темы стиля — ровно те, что браузер отдаёт через getComputedStyle
function darkVariables(style: StyleName): Map<string, string> {
  const css = readFileSync(new URL(`../styles/${style}.css`, import.meta.url), "utf8");
  const block = css.match(new RegExp(`\\[data-style=${style}\\]\\s*\\{([^}]*)\\}`))![1]!;
  const vars = new Map<string, string>();
  for (const [, name, value] of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) vars.set(name!, value!.trim());
  if (style === "gazeta") {
    const dark = css.match(/\[data-style=gazeta\]\[data-theme=dark\]\s*\{([^}]*)\}/)![1]!;
    for (const [, name, value] of dark.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) vars.set(name!, value!.trim());
  }
  return vars;
}

// так браузер сериализует SVG в innerHTML: пустые элементы получают закрывающий тег
const asSerialised = (svg: string) => svg.replace(/<(path|circle|rect)([^>]*)\/>/g, "<$1$2></$1>");

const fingerprint = (s: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${h.toString(16)}:${s.length}`;
};

// Отпечатки сняты со стенда: разметка связей в тёмной теме, оба рода, пять стилей, с линейкой и без.
describe("связи совпадают со стендом побайтно", () => {
  for (const [key, expected] of Object.entries(standLinks as Record<string, string>)) {
    it(key, () => {
      const [clan, style, mode] = key.split("/") as [string, StyleName, string];
      const tree = TREES[clan]!;
      const layout = layoutTree(tree, STYLE_METRICS[style], { ruler: mode === "ruler", rootAtBottom: false });
      const vars = darkVariables(style);
      const links = drawLinks(tree, layout, style, (name, fallback) => (vars.get(name) || fallback).trim());
      expect(fingerprint(asSerialised(links.paths + links.marks))).toBe(expected);
    });
  }
});

describe("подписи на карточках", () => {
  const date = (kind: string, year: number | null, end: number | null = null) => ({
    raw: "", kind, year, month: null, day: null, end_year: end, end_month: null, end_day: null, phrase: null,
  });

  it("неточные даты остаются неточными", () => {
    expect(formatDate(date("exact", 1748))).toBe("1748");
    expect(formatDate(date("about", 1748))).toBe("≈ 1748");
    expect(formatDate(date("before", 1748))).toBe("до 1748");
    expect(formatDate(date("after", 1748))).toBe("после 1748");
    expect(formatDate(date("between", 1740, 1750))).toBe("1740–1750");
    expect(formatDate({ ...date("unparsed", null), raw: "весной 1748" })).toBe("весной 1748");
  });

  it("годы жизни и заглушки", () => {
    const monadh = TREES.monadh!;
    const hamish = monadh.persons.find((p) => p.xref === "@I51@")!;
    expect(lifeYears(hamish)).toBe("1798 — 1920");
    const stub = monadh.persons.find((p) => p.is_branch_stub && p.given === "Потомки")!;
    expect(cardName(stub)).toMatch(/^потомки /);
  });
});

describe("вид карты", () => {
  it("зум оставляет точку под курсором на месте", () => {
    const view = { k: 1, x: 100, y: 50 };
    const next = zoomAt(view, 300, 200, 2);
    expect((300 - next.x) / next.k).toBeCloseTo((300 - view.x) / view.k);
    expect((200 - next.y) / next.k).toBeCloseTo((200 - view.y) / view.k);
  });

  it("зум не выходит за пределы", () => {
    expect(zoomAt({ k: 2, x: 0, y: 0 }, 0, 0, 10).k).toBe(2.5);
    expect(zoomAt({ k: 0.2, x: 0, y: 0 }, 0, 0, 0.1).k).toBe(0.15);
  });

  it("«целиком» вписывает полотно по центру", () => {
    const view = fitAll({ width: 2000, height: 1000 }, { width: 1040, height: 1040 });
    expect(view.k).toBeCloseTo(0.5);
    expect(view.x).toBeCloseTo(20);
  });

  it("центр на выбранном и возврат якоря после перестройки", () => {
    const centred = centreOn({ k: 2, x: 0, y: 0 }, { x: 100, y: 50 }, { width: 800, height: 600 });
    expect([centred.x + 100 * 2, centred.y + 50 * 2]).toEqual([400, 300]);
    const kept = keepAnchor(centred, { x: 100, y: 50 }, { x: 326, y: 90 });
    expect([kept.x + 326 * 2, kept.y + 90 * 2]).toEqual([400, 300]);
  });

  it("деления линейки прореживаются при отдалении", () => {
    expect(tickStep(10, 1)).toBe(5);
    expect(tickStep(10, 0.4)).toBe(10);
    expect(tickStep(10, 0.1)).toBe(50);
  });
});
