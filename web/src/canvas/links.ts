// Связи рода в SVG: нити браков в просветах между карточками и спуски к детям.
// Функция чистая: раскладка и цвета на входе, разметка на выходе. Сверена со стендом побайтно.

import type { ClanTree, TreeFamily, TreePerson } from "../api/types";
import { KNOT_BUS_DROP, KNOT_LABEL_H, KNOT_LIFT, type LayoutResult, parentless, type Point, primaryFamilies }
  from "../layout/layout";
import type { StyleName } from "../layout/metrics";
import { LINK_STYLES, marriageLevel, ROMAN } from "./styles";

export type ColorLookup = (variable: string, fallback: string) => string;

export interface LinksSvg {
  paths: string;
  marks: string;
  folds: FoldAnchor[];
  descents: Map<number, DescentGeometry>; // по id семьи — для подсветки линии рода
  unions: Map<number, Point>; // знак союза пары: откуда идёт спуск; по нему щелчком выбирается семья
}

// спуск к детям одной семьи: ствол от (x, y) до шины, [завиток над стволом], спуски на шине к верху детей
export interface DescentGeometry {
  x: number;
  y: number;
  bus: number;
  curl: string | null; // d завитка, когда известен один родитель
  kidEnd: number; // зазор между концом спуска и карточкой ребёнка
}

// где у свёрнутого союза встаёт стопка: x — ось спуска, y — край стопки со стороны пары.
// Когда основатель снизу, дети над родителями, и стопка тоже над парой (up).
export interface FoldAnchor {
  family: number;
  x: number;
  y: number;
  up: boolean;
}

const FOLD_DROP = 30;
const BUS_DROP = KNOT_BUS_DROP; // шина выводка — на столько выше верха детей
const KNOT_LABEL = "родители не записаны";
const KNOT_LABEL_W = KNOT_LABEL.length * 6.7 + 14; // моноширинная подпись справа от узла
const BUS_STEP = 34; // разнос шин разных браков одного человека
const FOSTER_DASH = "5 4"; // спуск к приёмному или под опекой — заметный штрих во всех стилях // от низа карточек до стопки

type Segment = [number, number];

export function drawLinks(
  tree: ClanTree,
  layout: LayoutResult,
  style: StyleName,
  color: ColorLookup,
  visible: (id: number) => boolean = () => true,
  folded: ReadonlySet<number> = new Set(),
): LinksSvg {
  const S = LINK_STYLES[style];
  const w = layout.cardWidth;
  const h = layout.cardHeight;
  const pos = layout.positions;
  const persons = new Map<number, TreePerson>(tree.persons.map((p) => [p.id, p]));
  const families = new Map<number, TreeFamily>(tree.families.map((f) => [f.id, f]));
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

  // Где у пары знак союза: уровень нити и точка, откуда уходит спуск к детям.
  // Очередь союза считается у того, у кого браков больше.
  const unionOf = (family: TreeFamily) => {
    const a = pos.get(family.husband!)!;
    const b = pos.get(family.wife!)!;
    const top = Math.min(a.y, b.y);
    const x1 = Math.min(a.x, b.x) + w;
    const x2 = Math.max(a.x, b.x);
    const marriagesOf = (id: number) => persons.get(id)?.spouse_families ?? [];
    const owner = marriagesOf(family.husband!).length >= marriagesOf(family.wife!).length ? family.husband! : family.wife!;
    const list = marriagesOf(owner);
    const N = list.length;
    const idx = Math.max(0, list.indexOf(family.id));
    const level = marriageLevel(style, idx, top, N, h);
    const anchor = gapsAt(x1, x2, level)[0];
    const x = anchor ? (anchor[0] + anchor[1]) / 2 : (x1 + x2) / 2; // спуск идёт с нити союза
    return { a, b, owner, top, x1, x2, N, idx, level, x };
  };

  let paths = "";
  let marks = "";
  const folds: FoldAnchor[] = [];
  const descents = new Map<number, DescentGeometry>();
  const unions = new Map<number, Point>();
  // человек из двух семей (родной и приёмной) стоит под одной — спуск только от неё
  const primary = primaryFamilies(tree);
  const PEDI = new Map<number, string>();
  const slots = busSlots(tree, {
    folded, visible, primary, persons, pos, cardWidth: w, gap: S.descentGap,
    union: (family) => unionOf(family),
  });
  const labelled = knotLabels(tree, { visible, primary, pos, cardWidth: w });

  for (const family of tree.families) {
    const parents = [family.husband, family.wife].filter((id): id is number => id != null && visible(id));
    const kids = family.children.filter((id) => visible(id) && primary.get(id) === family.id);
    family.children.forEach((id, i) => {
      if (primary.get(id) === family.id) PEDI.set(id, family.child_pedigree?.[i] ?? "birth");
    });

    // братья и сёстры без родителей: шина и над ней пустой узел с подписью
    if (parentless(family) && kids.length) {
      const kidsTop = Math.min(...kids.map((id) => pos.get(id)!.y));
      const bus = kidsTop - 30;
      const xs = kids.map((id) => pos.get(id)!.x + w / 2);
      const x = (Math.min(...xs) + Math.max(...xs)) / 2;
      const knot = bus - KNOT_LIFT; // подпись выше плюса «брат или сестра» на шине
      descents.set(family.id, { x, y: knot, bus, curl: null, kidEnd: S.descentGap });
      paths += `<path d="M${x} ${knot + 5}V${bus}M${Math.min(...xs)} ${bus}H${Math.max(...xs)}" stroke="${CL}" stroke-width="${S.width}" fill="none"/>`;
      for (const id of kids) {
        const p = pos.get(id)!;
        paths += `<path d="M${p.x + w / 2} ${bus}V${p.y - S.descentGap}" stroke="${CL}" stroke-width="${S.width}" fill="none"${PEDI.get(id) !== "birth" ? ` stroke-dasharray="${FOSTER_DASH}"` : ""}/>`;
      }
      // кружок у каждой семьи, а подпись одна на все соседние: двух одинаковых надписей рядом не нужно
      marks += `<circle class="knot" cx="${x}" cy="${knot}" r="5" fill="var(--bg)" stroke="${CL}" stroke-width="1.4"/>`;
      if (labelled.has(family.id)) {
        marks += `<text class="knotLbl" x="${x + 11}" y="${knot + 3.5}">${KNOT_LABEL}</text>`;
      }
      continue;
    }

    let famLevel: number | null = null;
    let famX: number | null = null;
    let famIndex = 0;

    if (parents.length === 2) {
      const union = unionOf(family);
      const { a, b, owner, x1, x2, N, idx, level } = union;
      const past = idx < N - 1 || !!family.divorced;

      famLevel = level;
      famIndex = idx;
      famX = union.x;
      unions.set(family.id, { x: famX, y: level });

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

    if (folded.has(family.id) && parents.length) {
      const drop = foldDrop(parents, pos, { w, h, style, CL, famLevel, famX, famIndex, persons, up: layout.rootAtBottom, families });
      paths += drop.path;
      folds.push({ family: family.id, x: drop.x, y: drop.y, up: layout.rootAtBottom });
      continue;
    }
    if (!kids.length || !parents.length) continue;
    paths += descent(family, parents, kids, pos, {
      w, h, style, CL, famLevel, famX, famIndex, persons, slot: slots.get(family.id)?.slot, busFrom: slots.get(family.id)?.from,
      record: (geometry) => descents.set(family.id, geometry),
      fostered: new Set(kids.filter((id) => PEDI.get(id) !== "birth")),
    });
    if (S.tip) {
      for (const id of kids) {
        const p = pos.get(id)!;
        marks += `<circle cx="${p.x + w / 2}" cy="${p.y - S.descentGap}" r="${S.tip}" fill="${CL}"/>`;
      }
    }
  }

  return { paths, marks, folds, descents, unions };
}

interface DescentContext {
  w: number;
  h: number;
  style: StyleName;
  CL: string;
  famLevel: number | null;
  famX: number | null;
  famIndex: number;
  slot?: number; // на какой высоте идёт шина выводка: подобрано так, чтобы спуски не пересекались
  busFrom?: number; // от какого верха отсчитывать шину: общий для всех выводков одного человека
  persons: Map<number, TreePerson>;
  up?: boolean;
  families?: Map<number, TreeFamily>;
  record?: (geometry: DescentGeometry) => void;
  fostered?: ReadonlySet<number>; // приёмные и под опекой: спуск к ним пунктиром
}

// Спуск к стопке свёрнутой ветки: с нити союза или завитком, как к детям, но короче — до стопки.
function foldDrop(parents: number[], pos: Map<number, Point>, c: DescentContext): { path: string; x: number; y: number } {
  const S = LINK_STYLES[c.style];
  if (c.up) {
    // над парой проходит шина её братьев: 30 над самым верхним из них, у многобрачных родителей выше.
    // Стопка встаёт над шиной, спуск пересекает её так же, как спуск к развёрнутым детям.
    const top = Math.min(...parents.map((id) => pos.get(id)!.y));
    let clear = top - FOLD_DROP;
    for (const id of parents) {
      for (const fid of c.persons.get(id)?.parent_families ?? []) {
        const brood = c.families?.get(fid);
        if (!brood?.children.length) continue;
        const kidsTop = Math.min(...brood.children.map((kid) => pos.get(kid)!.y));
        const broods = Math.max(
          1,
          ...[brood.husband, brood.wife].map((pid) => (pid != null ? (c.persons.get(pid)?.spouse_families.length ?? 1) : 1)),
        );
        clear = Math.min(clear, kidsTop - 30 - (broods - 1) * 34 - 14);
      }
    }
    const x = c.famX ?? pos.get(parents[0]!)!.x + c.w / 2;
    const y = clear;
    const from = c.famLevel ?? top;
    return { path: `<path d="M${x} ${from}V${y + S.descentGap}" stroke="${c.CL}" stroke-width="${S.width}" fill="none"/>`, x, y };
  }
  const bottom = Math.max(...parents.map((id) => pos.get(id)!.y)) + c.h;
  const y = bottom + FOLD_DROP;
  if (c.famX != null && c.famLevel != null) {
    return {
      path: `<path d="M${c.famX} ${c.famLevel}V${y - S.descentGap}" stroke="${c.CL}" stroke-width="${S.width}" fill="none"/>`,
      x: c.famX,
      y,
    };
  }
  const parent = pos.get(parents[0]!)!;
  const cx = parent.x + c.w / 2;
  const y0 = parent.y + c.h + S.descentGap;
  const bend = 17;
  const end = y0 + bend * 2;
  return {
    path: `<path d="M${cx} ${y0}C${cx + bend} ${y0} ${cx + bend} ${y0 + bend} ${cx} ${y0 + bend}C${cx - bend} ${y0 + bend} ${cx - bend} ${end} ${cx} ${end}V${end + 12}" stroke="${c.CL}" stroke-width="${S.width}" fill="none" stroke-linecap="round"/>`,
    x: cx,
    y: end + 12 + S.descentGap,
  };
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
  let curl: string | null = null;
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
    curl = `M${cx} ${y0}C${cx + bend} ${y0} ${cx + bend} ${y0 + bend} ${cx} ${y0 + bend}C${cx - bend} ${y0 + bend} ${cx - bend} ${y0 + bend * 2} ${cx} ${y0 + bend * 2}`;
    out += `<path d="M${cx} ${y0}C${cx + bend} ${y0} ${cx + bend} ${y0 + bend} ${cx} ${y0 + bend}C${cx - bend} ${y0 + bend} ${cx - bend} ${y0 + bend * 2} ${cx} ${y0 + bend * 2}" stroke="${c.CL}" stroke-width="${S.width}" fill="none" stroke-linecap="round"/>`;
  }

  const kidsTop = Math.min(...kids.map((id) => pos.get(id)!.y));
  const multi = c.famX != null ? parents.find((id) => (c.persons.get(id)?.spouse_families.length ?? 0) > 1) : undefined;
  const broods = multi != null ? c.persons.get(multi)!.spouse_families.length || 1 : 1;
  const bus = (c.busFrom ?? kidsTop) - BUS_DROP - (c.slot ?? Math.max(0, broods - 1 - c.famIndex)) * BUS_STEP;
  const kxs = kids.map((id) => pos.get(id)!.x + c.w / 2);
  const runL = Math.min(px, ...kxs);
  const runR = Math.max(px, ...kxs);
  c.record?.({ x: px, y: py, bus, curl, kidEnd: S.descentGap });
  out += `<path d="M${px} ${py}V${bus}" stroke="${c.CL}" stroke-width="${S.width}" fill="none"/><path d="M${runL} ${bus}H${runR}" stroke="${c.CL}" stroke-width="${S.width}" fill="none"/>`;
  for (const id of kids) {
    const p = pos.get(id)!;
    const dash = c.fostered?.has(id) ? ` stroke-dasharray="${FOSTER_DASH}"` : "";
    out += `<path d="M${p.x + c.w / 2} ${bus}V${p.y - S.descentGap}" stroke="${c.CL}" stroke-width="${S.width}" fill="none" stroke-linecap="butt" stroke-linejoin="round"${dash}/>`;
  }
  return out;
}

interface SlotContext {
  folded: ReadonlySet<number>;
  visible: (id: number) => boolean;
  primary: Map<number, number>;
  persons: Map<number, TreePerson>;
  pos: Map<number, Point>;
  cardWidth: number;
  gap: number;
  union: (family: TreeFamily) => { level: number; x: number; idx: number };
}

interface Route {
  family: number;
  x: number; // ось спуска от знака союза
  top: number; // уровень нити союза
  kidsTop: number;
  kids: { x: number; y: number }[];
  slot: number;
}

// Высоты шин у многобрачного. У каждого брака свой выводок и своя шина; раньше высота шла строго по очереди
// брака — первый брак выше всех. Пока дети стоят по порядку под своими узлами, это работает, но стоит наследнику
// встать под середину ряда (вид «главная ветвь») или выводкам разойтись — спуск одного брака ложится на спуск
// другого. Поэтому высоты подбираются: перебираем расстановки и берём ту, где спуски не пересекаются и не
// накладываются. Привычная расстановка проверяется первой и остаётся, если она не хуже остальных.
function busSlots(tree: ClanTree, c: SlotContext): Map<number, { slot: number; from: number }> {
  const out = new Map<number, { slot: number; from: number }>();
  const groups = new Map<number, Route[]>();
  for (const family of tree.families) {
    if (family.husband == null || family.wife == null || c.folded.has(family.id)) continue;
    if (!c.visible(family.husband) || !c.visible(family.wife)) continue;
    const kids = family.children.filter((id) => c.visible(id) && c.primary.get(id) === family.id);
    if (!kids.length) continue;
    // выводки считаются у того из родителей, у кого браков больше одного — как и при отрисовке спуска
    const multi = [family.husband, family.wife].find((id) => (c.persons.get(id)?.spouse_families.length ?? 0) > 1);
    if (multi == null) continue;
    const broods = c.persons.get(multi)!.spouse_families.length;
    const union = c.union(family);
    const points = kids.map((id) => ({ x: c.pos.get(id)!.x + c.cardWidth / 2, y: c.pos.get(id)!.y - c.gap }));
    const route: Route = {
      family: family.id, x: union.x, top: union.level, kids: points,
      kidsTop: Math.min(...kids.map((id) => c.pos.get(id)!.y)),
      slot: Math.max(0, broods - 1 - union.idx),
    };
    groups.set(multi, [...(groups.get(multi) ?? []), route]);
  }

  for (const routes of groups.values()) {
    if (routes.length < 2) continue;
    // Шины отсчитываются от общего верха — самого высокого из детей всех браков. С линейкой дат дети стоят
    // на разной высоте, и отсчёт от своего верха сводил бы шины разных браков почти вплотную.
    const from = Math.min(...routes.map((r) => r.kidsTop));
    for (const r of routes) r.kidsTop = from;
    const usual = routes.map((r) => r.slot);
    let best = usual;
    let bestCost = clashes(routes, usual);
    if (bestCost > 0) {
      for (const order of permutations(usual)) {
        const cost = clashes(routes, order);
        if (cost < bestCost) {
          best = order;
          bestCost = cost;
          if (!cost) break;
        }
      }
    }
    routes.forEach((r, i) => out.set(r.family, { slot: best[i]!, from }));
  }
  return out;
}

// сколько раз спуски разных выводков пересекают чужую шину или ложатся друг на друга при такой расстановке высот
function clashes(routes: Route[], slots: number[]): number {
  const shape = routes.map((r, i) => {
    const bus = r.kidsTop - BUS_DROP - slots[i]! * BUS_STEP;
    const xs = [r.x, ...r.kids.map((k) => k.x)];
    return {
      bus, left: Math.min(...xs), right: Math.max(...xs),
      // вертикали: ствол от нити союза до шины и спуски от шины к детям
      verticals: [{ x: r.x, from: r.top, to: bus }, ...r.kids.map((k) => ({ x: k.x, from: bus, to: k.y }))],
    };
  });
  let count = 0;
  for (let a = 0; a < shape.length; a++) {
    for (let b = 0; b < shape.length; b++) {
      if (a === b) continue;
      for (const v of shape[a]!.verticals) {
        const lo = Math.min(v.from, v.to);
        const hi = Math.max(v.from, v.to);
        // чужая шина проходит сквозь вертикаль
        if (v.x >= shape[b]!.left - 1 && v.x <= shape[b]!.right + 1 && shape[b]!.bus > lo + 1 && shape[b]!.bus < hi - 1) count++;
        // две вертикали разных выводков на одной оси и перекрываются по высоте
        if (a < b) {
          for (const u of shape[b]!.verticals) {
            if (Math.abs(u.x - v.x) < 4 && Math.min(hi, Math.max(u.from, u.to)) - Math.max(lo, Math.min(u.from, u.to)) > 2) count++;
          }
        }
      }
    }
  }
  return count;
}

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  return items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]));
}

// Кому из семей без родителей достаётся подпись. Узел такой семьи — кружок над шиной братьев, подпись справа
// от него. Когда выводки стоят близко, подписи ложились одна на другую; повторять одну и ту же надпись рядом
// незачем — она достаётся самому левому узлу группы, остальным остаётся кружок на своей шине.
function knotLabels(
  tree: ClanTree,
  c: { visible: (id: number) => boolean; primary: Map<number, number>; pos: Map<number, Point>; cardWidth: number },
): Set<number> {
  const broods = tree.families
    .filter((family) => parentless(family))
    .map((family) => {
      const kids = family.children.filter((id) => c.visible(id) && c.primary.get(id) === family.id);
      if (!kids.length) return null;
      const xs = kids.map((id) => c.pos.get(id)!.x + c.cardWidth / 2);
      return {
        family: family.id,
        at: (Math.min(...xs) + Math.max(...xs)) / 2,
        knot: Math.min(...kids.map((id) => c.pos.get(id)!.y)) - BUS_DROP - KNOT_LIFT,
      };
    })
    .filter((brood) => brood !== null)
    .sort((a, b) => a.at - b.at);

  const out = new Set<number>();
  const taken: { left: number; right: number; y: number }[] = [];
  for (const brood of broods) {
    const box = { left: brood.at - 6, right: brood.at + KNOT_LABEL_W, y: brood.knot };
    // подпись соседа слева дотянулась сюда на той же высоте — своей не нужно
    const covered = taken.some((other) =>
      box.left < other.right && box.right > other.left && Math.abs(box.y - other.y) < KNOT_LABEL_H);
    if (covered) continue;
    out.add(brood.family);
    taken.push(box);
  }
  return out;
}
