import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { ClanTree } from "../api/types";
import { cardName, formatDate, lifeYears } from "../format";
import gleannTree from "../layout/fixtures/gleann.tree.json";
import monadhTree from "../layout/fixtures/monadh.tree.json";
import { type LayoutResult, layoutTree } from "../layout/layout";
import { STYLE_METRICS, type StyleName } from "../layout/metrics";
import standLinks from "./fixtures/stand-links.json";
import { drawLinks } from "./links";
import { generationBands, tickStep, yearToCanvas } from "./ruler";
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

// Пять отпечатков «monadh/…/ruler» пересняты 1 октября 2026: шины выводков у многобрачных с линейкой дат
// теперь отсчитываются от общего верха детей, иначе шины разных браков сходились почти вплотную.
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

// У многобрачного у каждого брака свой выводок и своя шина. Спуск одного выводка не должен пересекать шину
// другого и ложиться на чужой ствол — иначе не понять, чей ребёнок. Проверяем на всех, у кого больше одного брака
// с детьми: во всех стилях, в «стандарте» и в «главной ветви», где наследник встаёт под середину ряда родителя.
describe("спуски разных браков не пересекаются", () => {
  const vars = () => new Map<string, string>();
  const source = TREES.monadh!;
  const malcolm = source.persons.find((p) => p.given === "Малькольм" && p.birth?.year === 1941)!;
  const kenneth = source.persons.find((p) => p.given === "Кеннет" && p.birth?.year === 1976)!;
  // В эталонном файле браки идут как записаны; приложение ставит их по правилу очереди — у Малькольма
  // первой становится Элспет, мать Кеннета. Именно так его линия ложилась на чужой ствол, поэтому
  // здесь браки переставлены по году рождения жены, как на карте.
  const wifeYear = (familyId: number) => {
    const family = source.families.find((f) => f.id === familyId)!;
    const wife = source.persons.find((p) => p.id === (family.husband === malcolm.id ? family.wife : family.husband));
    return wife?.birth?.year ?? 9999;
  };
  const tree: ClanTree = {
    ...source,
    persons: source.persons.map((p) => p.id === malcolm.id
      ? { ...p, spouse_families: [...p.spouse_families].sort((a, b) => wifeYear(a) - wifeYear(b)) } : p),
  };
  const persons = new Map(tree.persons.map((p) => [p.id, p]));

  const crossings = (style: StyleName, heirs: Set<number>, ruler = false): number => {
    const layout = layoutTree(tree, STYLE_METRICS[style], { ruler, rootAtBottom: false, heirs });
    const links = drawLinks(tree, layout, style, (name, fallback) => (vars().get(name) || fallback).trim());
    let count = 0;
    for (const person of tree.persons.filter((p) => p.spouse_families.length > 1)) {
      const routes = person.spouse_families
        .map((id) => ({ family: tree.families.find((f) => f.id === id)!, geometry: links.descents.get(id) }))
        .filter((r) => r.geometry)
        .map((r) => {
          const kids = r.family.children.filter((c) => persons.has(c)).map((c) => layout.positions.get(c)!);
          const xs = [r.geometry!.x, ...kids.map((k) => k.x + layout.cardWidth / 2)];
          return {
            bus: r.geometry!.bus, left: Math.min(...xs), right: Math.max(...xs),
            verticals: [{ x: r.geometry!.x, from: r.geometry!.y, to: r.geometry!.bus },
              ...kids.map((k) => ({ x: k.x + layout.cardWidth / 2, from: r.geometry!.bus, to: k.y }))],
          };
        });
      for (const a of routes) {
        for (const b of routes) {
          if (a === b) continue;
          for (const v of a.verticals) {
            const lo = Math.min(v.from, v.to);
            const hi = Math.max(v.from, v.to);
            if (v.x >= b.left - 1 && v.x <= b.right + 1 && b.bus > lo + 1 && b.bus < hi - 1) count++;
          }
        }
      }
    }
    return count;
  };

  for (const style of Object.keys(STYLE_METRICS) as StyleName[]) {
    it(`${style}: стандарт и главная ветвь`, () => {
      expect(crossings(style, new Set())).toBe(0);
      expect(crossings(style, new Set([malcolm.id, kenneth.id]))).toBe(0);
      // с линейкой дат дети стоят на разной высоте — шины всё равно не должны сходиться и пересекаться
      expect(crossings(style, new Set(), true)).toBe(0);
      expect(crossings(style, new Set([malcolm.id, kenneth.id]), true)).toBe(0);
    });
  }
});

describe("линейка дат", () => {
  const tree = TREES.gleann!;
  const layout = layoutTree(tree, STYLE_METRICS.gobelen, { ruler: true, rootAtBottom: false });
  const ruler = layout.ruler!;

  it("год человека приходится на середину портрета, а не на край карточки", () => {
    const morag = tree.persons.find((p) => p.given === "Мораг" && p.birth?.year === 1860)!;
    const top = layout.positions.get(morag.id)!.y;
    expect(Math.abs(yearToCanvas(ruler, 1860) - (top + STYLE_METRICS.gobelen.yearAnchor))).toBeLessThan(2);
  });

  it("полосы поколений идут сплошь: конец одного — начало следующего", () => {
    const bands = [...generationBands(ruler).values()];
    expect(bands.length).toBe(9); // у десятого поколения годов нет
    for (let i = 1; i < bands.length; i++) expect(bands[i]!.from).toBe(bands[i - 1]!.to);
    // шестое поколение — не пять лет между крайними рождениями, а промежуток до соседей
    const sixth = bands[5]!;
    expect([sixth.from, sixth.to]).toEqual([1841, 1877]);
  });

  it("люди своего поколения лежат внутри его полосы или у самой границы", () => {
    const bands = generationBands(ruler);
    for (const [g, band] of bands) {
      const range = ruler.range.get(g)!;
      expect(range.min).toBeGreaterThanOrEqual(band.from - 6);
      expect(range.max).toBeLessThanOrEqual(band.to + 6);
    }
  });
});

// Семья без родителей рисуется кружком над шиной братьев, подпись «родители не записаны» — справа от кружка.
// Когда выводки стоят близко, две одинаковые подписи ложились одна на другую. Повторять надпись незачем:
// она достаётся левому узлу, остальным остаётся кружок. Координаты взяты с рода Прайс, где это и вылезло:
// центры выводков разошлись всего на 39 пикселей при ширине подписи 148.
describe("подпись «родители не записаны» одна на соседние семьи", () => {
  const person = (id: number, family: number) => ({
    id, xref: `@I${id}@`, given: `Дитя${id}`, surname: "Прайс", married_surname: null, sex: "M", is_branch_stub: false,
    birth: null, death: null, parent_families: [family], spouse_families: [],
  });
  const tree = (broods: number[][]) => ({
    clan: { id: 1, name: "Прайс", persons: broods.flat().length, families: broods.length },
    persons: broods.flatMap((kids, f) => kids.map((id) => person(id, f + 1))),
    families: broods.map((kids, f) => ({ id: f + 1, xref: `@F${f + 1}@`, husband: null, wife: null, children: kids })),
  } as unknown as ClanTree);

  const drawn = (style: StyleName, broods: number[][], at: Record<number, number>) => {
    const layout = {
      positions: new Map(Object.entries(at).map(([id, x]) => [+id, { x, y: 120 }])),
      generation: new Map(broods.flat().map((id) => [id, 0])),
      cardWidth: 104, cardHeight: 126, width: 4000, height: 600, ruler: null, rootAtBottom: false,
    } as unknown as LayoutResult;
    const marks = drawLinks(tree(broods), layout, style, (_, fallback) => fallback).marks;
    return {
      кружков: [...marks.matchAll(/<circle class="knot"/g)].length,
      подписей: [...marks.matchAll(/<text class="knotLbl"/g)].length,
    };
  };

  const рядом: [number[][], Record<number, number>] = [[[10, 11, 12], [20, 21]], { 10: 620, 11: 790, 12: 960, 20: 700, 21: 870 }];
  const врозь: [number[][], Record<number, number>] = [[[10, 11], [20, 21]], { 10: 200, 11: 370, 20: 1800, 21: 1970 }];

  for (const style of Object.keys(STYLE_METRICS) as StyleName[]) {
    it(style, () => {
      // выводки вплотную: два кружка, но подпись одна
      expect(drawn(style, ...рядом)).toEqual({ кружков: 2, подписей: 1 });
      // далеко друг от друга — у каждого своя подпись
      expect(drawn(style, ...врозь)).toEqual({ кружков: 2, подписей: 2 });
    });
  }
});
