// Связи рода в SVG: нити браков в просветах между карточками и спуски к детям.
// Функция чистая: раскладка и цвета на входе, разметка на выходе. Сверена со стендом побайтно.

import type { ClanTree, TreeFamily, TreePerson } from "../api/types";
import type { LayoutResult, Point } from "../layout/layout";
import type { StyleName } from "../layout/metrics";
import { LINK_STYLES, marriageLevel, ROMAN } from "./styles";

export type ColorLookup = (variable: string, fallback: string) => string;

export interface LinksSvg {
  paths: string;
  marks: string;
}

type Segment = [number, number];

export function drawLinks(
  tree: ClanTree,
  layout: LayoutResult,
  style: StyleName,
  color: ColorLookup,
  visible: (id: number) => boolean = () => true,
): LinksSvg {
  const S = LINK_STYLES[style];
  const w = layout.cardWidth;
  const h = layout.cardHeight;
  const pos = layout.positions;
  const persons = new Map<number, TreePerson>(tree.persons.map((p) => [p.id, p]));
  const CL = color("--link", "#888");
  const CA = color("--acc", "#c90");

  const boxes: Point[] = tree.persons.filter((p) => visible(p.id)).map((p) => pos.get(p.id)!);

  // просветы между карточками на высоте линии: нить видна только в них и не режет ни текст, ни портреты
  const gapsAt = (x1: number, x2: number, level: number): Segment[] => {
    const hit = boxes
      .filter((n) => n.y - 14 < level && level < n.y + h + 2 && n.x + w > x1 && n.x < x2)
      .sort((a, b) => a.x - b.x);
    const segments: Segment[] = [];
    let cursor = x1;
    for (const n of hit) {
      if (n.x > cursor) segments.push([cursor, Math.min(n.x, x2)]);
      cursor = Math.max(cursor, n.x + w);
    }
    if (cursor < x2) segments.push([cursor, x2]);
    return segments.filter((s) => s[1] - s[0] > 2);
  };

  let paths = "";
  let marks = "";

  for (const family of tree.families) {
    const parents = [family.husband, family.wife].filter((id): id is number => id != null && visible(id));
    const kids = family.children.filter(visible);

    let famLevel: number | null = null;
    let famX: number | null = null;
    let famIndex = 0;

    if (parents.length === 2) {
      const a = pos.get(family.husband!)!;
      const b = pos.get(family.wife!)!;
      const top = Math.min(a.y, b.y);
      const x1 = Math.min(a.x, b.x) + w;
      const x2 = Math.max(a.x, b.x);

      // очередь союза считается у того, у кого браков больше
      const marriagesOf = (id: number) => persons.get(id)?.spouse_families ?? [];
      const owner = marriagesOf(family.husband!).length >= marriagesOf(family.wife!).length ? family.husband! : family.wife!;
      const list = marriagesOf(owner);
      const N = list.length;
      const idx = Math.max(0, list.indexOf(family.id));
      const past = idx < N - 1;

      const level = marriageLevel(style, idx, top, N, h);
      famLevel = level;
      famIndex = idx;
      const anchor = gapsAt(x1, x2, level)[0];
      famX = anchor ? (anchor[0] + anchor[1]) / 2 : (x1 + x2) / 2; // спуск идёт с нити союза

      const op = past ? ".72" : "1";
      const segs = gapsAt(x1, x2, level)
        .map((s): Segment => [s[0] + S.inset, s[1] - S.inset])
        .filter((s) => s[1] - s[0] > 4);
      const near = segs[0];

      if (style === "gobelen") {
        const OLD = color("--st-old", "#7c8a76");
        const NEW = color("--st-new", "#8d9b86");
        const k = N > 2 ? idx / (N - 2) : 1; // старший союз глуше, ближний ярче
        const stitchColor = past ? (idx === 0 ? OLD : NEW) : CA;
        const stitchOpacity = past ? (0.7 + 0.15 * k).toFixed(2) : "1";
        for (const s of segs) {
          if (!past) paths += `<path d="M${s[0]} ${level}H${s[1]}" stroke="${CA}" stroke-width="1.7" fill="none"/>`;
          const width = past ? 1.6 : 2.3;
          for (let x = s[0] + 12; x <= s[1] - 6; x += 12) {
            paths += `<path d="M${x} ${level + 4} l6 -8" stroke="${stitchColor}" stroke-width="${width}" stroke-linecap="round" fill="none" opacity="${stitchOpacity}"/>`;
          }
        }
        if (!past && near) marks += `<circle cx="${(near[0] + near[1]) / 2}" cy="${level}" r="3" fill="#e8dcb8"/>`;
      } else if (style === "gazeta") {
        for (const s of segs) {
          paths += `<path d="M${s[0]} ${level}H${s[1]}" stroke="${CL}" stroke-width="${past ? ".9" : "1.1"}" fill="none" opacity="${past ? ".45" : "1"}"${past ? ' stroke-dasharray="4 4"' : ""}/>`;
        }
        if (near) {
          const cx = (near[0] + near[1]) / 2; // один знак равенства на зазор
          marks += `<path d="M${cx - 7} ${level - 3}h14M${cx - 7} ${level + 3}h14" stroke="${CL}" stroke-width="1.3" fill="none"${past ? ' opacity=".75"' : ""}/>`;
        }
      } else if (style === "polotno") {
        const M1 = color("--m1", "#a39a8e");
        const M0 = color("--m0", "#6f6a60");
        const trace = past ? M0 : CA; // тусклый след через весь пролёт
        const bright = past ? M1 : CA;
        const from = Math.min(a.x, b.x);
        const to = pos.get(owner)!.x + w;
        paths += `<path d="M${from} ${level}H${to}" stroke="${trace}" stroke-width="1" fill="none" opacity="${past ? ".26" : ".28"}"/>`;
        const exact = gapsAt(x1, x2, level);
        for (const s of exact) {
          paths += `<path d="M${s[0]} ${level}H${s[1]}" stroke="${bright}" stroke-width="${past ? 1.2 : 1.5}" fill="none"/>`;
        }
        if (N > 1 && exact[0]) {
          const g0 = exact[0];
          marks += `<text x="${(g0[0] + g0[1]) / 2}" y="${level - 7}" text-anchor="middle" fill="${past ? "var(--mut)" : CA}" font-family="IBM Plex Mono,monospace" font-size="9">${String(idx + 1).padStart(2, "0")}</text>`;
        }
      } else {
        // викторианский и кабинет
        const dash = past ? S.pastDash : S.marriageDash;
        for (const s of segs) {
          paths += `<path d="M${s[0]} ${level}H${s[1]}" stroke="${CL}" stroke-width="${S.width}" fill="none" opacity="${op}" stroke-dasharray="${dash}" stroke-linecap="butt"/>`;
        }
        if (near) {
          const cx = (near[0] + near[1]) / 2;
          if (S.mark === "lozenge") {
            marks += `<path d="M${cx} ${level - 5.5}l5.5 5.5-5.5 5.5-5.5-5.5z" fill="${CA}" opacity="${past ? ".85" : "1"}"/>`;
          } else if (S.mark === "rivet") {
            const rivet = past ? color("--label-past", CL) : CA;
            marks += `<circle cx="${cx}" cy="${level}" r="${past ? 3 : 3.4}" fill="${rivet}" opacity="${op}"/>`;
          }
          if (N > 1 && S.ordinal === "line") {
            // метка очереди над линией
            const label = ROMAN[idx] ?? String(idx + 1);
            const width = 8 + label.length * 4.6;
            const fill = past ? color("--label-past", CL) : CA;
            const text = past ? color("--label-past-fg", "#fff") : "var(--bg)";
            marks += `<rect x="${cx - width / 2}" y="${level - 19}" width="${width}" height="12" rx="2" fill="${fill}"/><text x="${cx}" y="${level - 10}" text-anchor="middle" fill="${text}" font-family="IBM Plex Mono,monospace" font-size="8.5">${label}</text>`;
          }
        }
      }
    }

    if (!kids.length || !parents.length) continue;
    paths += descent(family, parents, kids, pos, { w, h, style, CL, famLevel, famX, famIndex, persons });
    if (S.tip) {
      for (const id of kids) {
        const p = pos.get(id)!;
        marks += `<circle cx="${p.x + w / 2}" cy="${p.y - S.descentGap}" r="${S.tip}" fill="${CL}"/>`;
      }
    }
  }

  return { paths, marks };
}

interface DescentContext {
  w: number;
  h: number;
  style: StyleName;
  CL: string;
  famLevel: number | null;
  famX: number | null;
  famIndex: number;
  persons: Map<number, TreePerson>;
}

// Спуск к детям: с нити союза или, при одном известном родителе, завитком из-под карточки.
// У каждого выводка своя шина, разнесённая по очереди союзов.
function descent(
  _family: TreeFamily,
  parents: number[],
  kids: number[],
  pos: Map<number, Point>,
  c: DescentContext,
): string {
  const S = LINK_STYLES[c.style];
  let out = "";
  let px: number;
  let py: number;
  if (c.famX != null && c.famLevel != null) {
    px = c.famX;
    py = c.famLevel;
  } else {
    // завиток уходит вбок и возвращается на ось: дальше линия идёт прямо, без ступеньки
    const parent = pos.get(parents[0]!)!;
    const cx = parent.x + c.w / 2;
    const y0 = parent.y + c.h + S.descentGap;
    const bend = 17;
    px = cx;
    py = y0 + bend * 2;
    out += `<path d="M${cx} ${y0}C${cx + bend} ${y0} ${cx + bend} ${y0 + bend} ${cx} ${y0 + bend}C${cx - bend} ${y0 + bend} ${cx - bend} ${y0 + bend * 2} ${cx} ${y0 + bend * 2}" stroke="${c.CL}" stroke-width="${S.width}" fill="none" stroke-linecap="round"/>`;
  }

  const kidsTop = Math.min(...kids.map((id) => pos.get(id)!.y));
  const multi = c.famX != null ? parents.find((id) => (c.persons.get(id)?.spouse_families.length ?? 0) > 1) : undefined;
  const broods = multi != null ? c.persons.get(multi)!.spouse_families.length || 1 : 1;
  const bus = kidsTop - 30 - Math.max(0, broods - 1 - c.famIndex) * 34;
  const kxs = kids.map((id) => pos.get(id)!.x + c.w / 2);
  const runL = Math.min(px, ...kxs);
  const runR = Math.max(px, ...kxs);
  out += `<path d="M${px} ${py}V${bus}" stroke="${c.CL}" stroke-width="${S.width}" fill="none"/><path d="M${runL} ${bus}H${runR}" stroke="${c.CL}" stroke-width="${S.width}" fill="none"/>`;
  for (const id of kids) {
    const p = pos.get(id)!;
    out += `<path d="M${p.x + c.w / 2} ${bus}V${p.y - S.descentGap}" stroke="${c.CL}" stroke-width="${S.width}" fill="none" stroke-linecap="butt" stroke-linejoin="round"/>`;
  }
  return out;
}
