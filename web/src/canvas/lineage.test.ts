import { describe, expect, it } from "vitest";

import type { ClanTree } from "../api/types";
import gleannTree from "../layout/fixtures/gleann.tree.json";
import monadhTree from "../layout/fixtures/monadh.tree.json";
import { layoutTree } from "../layout/layout";
import { STYLE_METRICS, type StyleName } from "../layout/metrics";
import { lineageOf } from "./lineage";
import { drawLinks } from "./links";

const monadh = monadhTree as unknown as ClanTree;
const gleann = gleannTree as unknown as ClanTree;
const byXref = (tree: ClanTree, xref: string) => tree.persons.find((p) => p.xref === xref)!;
const STYLES: StyleName[] = ["gobelen", "viktorian", "gazeta", "kabinet", "polotno"];

// прямые отрезки пути: M x y, дальше H и V по очереди
function segments(d: string): { x1: number; y1: number; x2: number; y2: number }[] {
  const out = [];
  for (const run of d.split("M").filter(Boolean)) {
    if (run.includes("C")) continue; // завиток сверяется отдельно — он берётся из связей целиком
    const [start, ...moves] = run.split(/(?=[HV])/);
    let [x, y] = start!.trim().split(" ").map(Number) as [number, number];
    for (const move of moves) {
      const value = Number(move.slice(1));
      const next = move[0] === "H" ? { x: value, y } : { x, y: value };
      out.push({ x1: x, y1: y, x2: next.x, y2: next.y });
      ({ x, y } = next);
    }
  }
  return out;
}

const covers = (outer: ReturnType<typeof segments>[number], inner: ReturnType<typeof segments>[number]) => {
  const near = (a: number, b: number) => Math.abs(a - b) < 0.01;
  if (near(inner.y1, inner.y2)) {
    return near(outer.y1, outer.y2) && near(outer.y1, inner.y1) &&
      Math.min(outer.x1, outer.x2) - 0.01 <= Math.min(inner.x1, inner.x2) && Math.max(outer.x1, outer.x2) + 0.01 >= Math.max(inner.x1, inner.x2);
  }
  return near(outer.x1, outer.x2) && near(outer.x1, inner.x1) &&
    Math.min(outer.y1, outer.y2) - 0.01 <= Math.min(inner.y1, inner.y2) && Math.max(outer.y1, outer.y2) + 0.01 >= Math.max(inner.y1, inner.y2);
};

describe("линия рода", () => {
  const layout = layoutTree(monadh, STYLE_METRICS.viktorian, { ruler: false, rootAtBottom: false });
  const links = drawLinks(monadh, layout, "viktorian", (_, fallback) => fallback);
  const names = (ids: Set<number>) => [...ids].map((id) => monadh.persons.find((p) => p.id === id)!.given);

  it("от выбранного вверх до основателя по кровным родителям", () => {
    const line = lineageOf(monadh, layout, "viktorian", links, byXref(monadh, "@I555@").id);
    expect(names(line.persons)).toEqual(["Кеннет", "Малькольм", "Роберт", "Иэйн", "Кайл", "Юэн", "Хэмиш", "Дункан"]);
  });

  it("у пришлого супруга и у основателя линии нет", () => {
    expect(lineageOf(monadh, layout, "viktorian", links, byXref(monadh, "@I554@").id).paths).toBe("");
    expect(lineageOf(monadh, layout, "viktorian", links, byXref(monadh, "@I575@").id).paths).toBe("");
  });

  for (const [name, tree] of [["Монад", monadh], ["Гленн", gleann]] as const) {
    it(`${name}: подсветка идёт только по нарисованным связям во всех стилях`, () => {
      for (const style of STYLES) {
        for (const [ruler, rootAtBottom] of [[false, false], [true, false], [false, true]] as const) {
          const l = layoutTree(tree, STYLE_METRICS[style], { ruler, rootAtBottom });
          const drawn = drawLinks(tree, l, style, (_, fallback) => fallback);
          const drawnSegments = segments([...drawn.paths.matchAll(/d="([^"]+)"/g)].map((m) => m[1]).join(""));
          const curls = [...drawn.paths.matchAll(/d="([^"]*C[^"]*)"/g)].map((m) => m[1]!);
          for (const person of tree.persons) {
            const line = lineageOf(tree, l, style, drawn, person.id);
            for (const curl of line.paths.match(/M[^M]*C[^M]*/g) ?? []) expect(curls).toContain(curl);
            for (const seg of segments(line.paths)) {
              // у гобелена прошлые союзы вышиты стежками без сплошной нити — там подсветка идёт по стежкам
              const stitched = style === "gobelen" && seg.y1 === seg.y2 && drawn.paths.includes(` ${seg.y1 + 4} l6 -8`);
              const ok = stitched || drawnSegments.some((d) => covers(d, seg));
              expect(ok, `${style} ruler=${ruler} bottom=${rootAtBottom} ${person.xref} ${JSON.stringify(seg)}`).toBe(true);
            }
          }
        }
      }
    });
  }
});
