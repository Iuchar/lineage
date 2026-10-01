// Раскладка рода: люди и семьи на входе, координаты карточек на выходе. Ничего не рисует.
// Правила и числа — из docs/decisions.md; перенос сверен со стендом по координатам (layout.test.ts).

import type { ClanTree, TreeFamily, TreePerson } from "../api/types";
import { estimateBirthYears } from "./estimate";
import { type CardMetrics, cardHeight } from "./metrics";

export interface LayoutOptions {
  ruler: boolean;
  rootAtBottom: boolean;
  // ручной сдвиг среди братьев: id человека → на сколько мест (+ правее, − левее)
  manual?: ReadonlyMap<number, number>;
  // свёрнутые союзы: дети уже убраны из дерева (fold.ts), под союзом нужно место для стопки
  folded?: ReadonlySet<number>;
  // продолжатели главной линии: пара встаёт над таким ребёнком, и линия идёт прямым стволом
  heirs?: ReadonlySet<number>;
  // фамилия второй строкой на карточке — карточка выше на строку
  surnames?: boolean;
}

export interface Point {
  x: number;
  y: number;
}

export interface GenerationRange {
  min: number;
  max: number;
  q1: number;
  q3: number;
  count: number;
}

export interface RulerLayout {
  gutter: number; // поле слева под линейку
  top: number;
  scale: number; // пикселей на год для типичного поколения
  firstYear: number;
  generations: number[];
  rowY: Map<number, number>;
  median: Map<number, number | null>;
  range: Map<number, GenerationRange | null>;
}

export interface LayoutResult {
  positions: Map<number, Point>;
  generation: Map<number, number>;
  cardWidth: number;
  cardHeight: number;
  width: number;
  height: number;
  ruler: RulerLayout | null;
  rootAtBottom: boolean; // дети над родителями
}

// между братьями, между двумя бездетными, между ветками верхнего уровня
const GAP_SIBLINGS = 124;
const GAP_LEAVES = 64;
const GAP_TREES = 200;

const TIER_TOP = 26;
const RULER_TOP = 44;
const RULER_GUTTER = 226;
const LINK_ROOM = 96; // место под завиток и шину выводка
const EXTRA_MARRIAGE_ROOM = 34; // разнос шин на каждый следующий брак
const SHIFT_SHARE = 0.34; // сдвиг внутри яруса — не больше трети карточки
const CHILD_DROP = 12;
const PARENTLESS_ROOM = 64;
const SURNAME_ROOM = 13; // строка фамилии под именем // над братьями без родителей: шина, узел и подпись

const collator = new Intl.Collator("ru", { numeric: true });

interface Index {
  persons: Map<number, TreePerson>;
  primary: Map<number, number>; // семья, под которой человек стоит на карте
  estimated: Map<number, number>; // оценка года у тех, у кого его нет; линейка по ней не строится
  families: Map<number, TreeFamily>;
  order: TreePerson[];
  familyOrder: TreeFamily[];
}

function index(tree: ClanTree): Index {
  return {
    persons: new Map(tree.persons.map((p) => [p.id, p])),
    primary: primaryFamilies(tree),
    estimated: estimateBirthYears(tree),
    families: new Map(tree.families.map((f) => [f.id, f])),
    order: tree.persons,
    familyOrder: tree.families,
  };
}

// Где человек стоит на карте, если он записан ребёнком в нескольких семьях: под той, где рос, —
// приёмной или опекунской; иначе под первой. В остальных семьях он только строкой в панели.
export function primaryFamilies(tree: ClanTree): Map<number, number> {
  const out = new Map<number, number>();
  const raised = new Set<number>();
  for (const family of tree.families) {
    family.children.forEach((child, i) => {
      const fostered = (family.child_pedigree?.[i] ?? "birth") !== "birth";
      if (!out.has(child) || (fostered && !raised.has(child))) out.set(child, family.id);
      if (fostered) raised.add(child);
    });
  }
  // при равных — первая семья в записи человека, как было
  for (const person of tree.persons) {
    const first = person.parent_families[0];
    if (first != null && !raised.has(person.id) && out.has(person.id)) out.set(person.id, first);
  }
  return out;
}

// семьи, где записаны одни дети: братья и сёстры с неизвестными родителями
export function parentless(family: TreeFamily): boolean {
  return family.husband == null && family.wife == null && family.children.length > 0;
}

function birthYear(person: TreePerson | undefined): number | null {
  const birth = person?.birth;
  return birth ? (birth.year ?? birth.end_year ?? null) : null;
}

// Ключ старшинства: по нему ставят братьев, корни и семьи без родителей. Зрителю сервер отдаёт не год,
// а место по старшинству (birth_rank) — годы ему видны не все, а дерево должно стоять так же, как у редактора.
// Линейке дат нужен настоящий год, поэтому она по-прежнему берёт birthYear.
function ageKey(person: TreePerson | undefined): number | null {
  return person?.birth_rank ?? birthYear(person);
}

// Поколение: родители одной семьи на одном ярусе, дети — ярусом ниже. Повторяется до устойчивости.
export function generations(tree: ClanTree): Map<number, number> {
  const gen = new Map(tree.persons.map((p) => [p.id, 0]));
  const at = (id: number) => gen.get(id) ?? 0;
  let changed = true;
  for (let guard = 0; changed && guard < 60; guard++) {
    changed = false;
    for (const family of tree.families) {
      const parents = [family.husband, family.wife].filter((id): id is number => id != null);
      const top = parents.length ? Math.max(0, ...parents.map(at)) : -1;
      for (const id of parents) {
        if (at(id) < top) {
          gen.set(id, top);
          changed = true;
        }
      }
      for (const child of family.children) {
        if (at(child) < top + 1) {
          gen.set(child, top + 1);
          changed = true;
        }
      }
    }
  }
  return gen;
}

// Старший левее. Человек без года остаётся на своём месте в записи семьи — между соседями, чьи годы известны:
// во всех семьях исходных файлов дети записаны по старшинству, а оценка по родне ошибается сильнее разницы
// между братьями. Если датированных братьев нет — по оценке (estimate.ts). Заглушки и люди без всякой зацепки —
// после датированных, между собой по идентификатору.
function byAge(idx: Index, order: readonly number[]) {
  const keys = new Map<number, number>();
  const dated = order.map((id) => ageKey(idx.persons.get(id)));
  order.forEach((id, i) => {
    if (dated[i] != null) return keys.set(id, dated[i]!);
    if (idx.persons.get(id)?.is_branch_stub) return;
    const before = dated.slice(0, i).filter((y): y is number => y != null).at(-1);
    const after = dated.slice(i + 1).find((y): y is number => y != null);
    const key = before != null && after != null ? (before + after) / 2
      : before != null ? before + 0.5 : after != null ? after - 0.5 : idx.estimated.get(id);
    if (key != null) keys.set(id, key);
  });
  return (a: number, b: number): number => {
    const ya = keys.get(a) ?? null;
    const yb = keys.get(b) ?? null;
    if (ya != null && yb != null) return ya - yb;
    if (ya != null) return -1;
    if (yb != null) return 1;
    return collator.compare(idx.persons.get(a)?.xref ?? "", idx.persons.get(b)?.xref ?? "");
  };
}

interface Span {
  l: number;
  r: number;
}

interface TreeNode {
  id: number;
  unit: number[]; // человек и его супруги в ряд
  unitWidth: number;
  kids: { node: TreeNode; dx: number }[];
  contour: Span[]; // левая и правая граница поддерева на каждом ярусе
  leaf: boolean;
}

function applyManual(nodes: TreeNode[], manual: ReadonlyMap<number, number> | undefined): TreeNode[] {
  if (!manual) return nodes;
  const moved = nodes.filter((n) => manual.get(n.id));
  if (!moved.length) return nodes;
  const out = [...nodes];
  for (const node of moved) {
    const from = out.indexOf(node);
    const to = Math.max(0, Math.min(out.length - 1, from + (manual.get(node.id) ?? 0)));
    out.splice(from, 1);
    out.splice(to, 0, node);
  }
  return out;
}

function merge(acc: Span[], contour: Span[], dx: number): Span[] {
  const out: Span[] = [];
  for (let i = 0; i < Math.max(acc.length, contour.length); i++) {
    const a = acc[i];
    const c = contour[i];
    const b = c && { l: c.l + dx, r: c.r + dx };
    out.push(!a ? b! : !b ? a : { l: Math.min(a.l, b.l), r: Math.max(a.r, b.r) });
  }
  return out;
}

// По горизонтали: дети подряд с контурным сжатием, пара встаёт между крайними детьми.
function placeHorizontally(idx: Index, metrics: CardMetrics, options: LayoutOptions) {
  const { manual } = options;
  const folded = options.folded ?? new Set<number>();
  const heirs = options.heirs ?? new Set<number>();
  const positions = new Map<number, number>();
  const pairStep = metrics.width + metrics.pairGap;

  const buildNode = (unit: number[], nodes: TreeNode[], id: number): TreeNode => {
    // пустой ряд — семья без родителей: над детьми только узел
    const unitWidth = unit.length ? unit.length * metrics.width + (unit.length - 1) * metrics.pairGap : 0;
    const self: Span[] = [{ l: -unitWidth / 2, r: unitWidth / 2 }];
    if (!nodes.length) return { id, unit, unitWidth, kids: [], contour: self, leaf: unit.length === 1 };

    const gapWith = (a: TreeNode, b: TreeNode) => (a.leaf && b.leaf ? GAP_LEAVES : GAP_SIBLINGS);
    const placed = [{ node: nodes[0]!, dx: 0 }];
    let acc = nodes[0]!.contour.map((c) => ({ ...c }));
    for (let i = 1; i < nodes.length; i++) {
      const node = nodes[i]!;
      const gap = gapWith(nodes[i - 1]!, node);
      let d = 0;
      const depth = Math.min(acc.length, node.contour.length);
      for (let j = 0; j < depth; j++) d = Math.max(d, acc[j]!.r + gap - node.contour[j]!.l);
      placed.push({ node, dx: d });
      acc = merge(acc, node.contour, d);
    }
    const heir = placed.find((p) => heirs.has(p.node.id));
    // над продолжателем встаёт сама карточка, а не середина его блока с супругами
    const inUnit = heir ? heir.node.unit.indexOf(heir.node.id) : 0;
    const shift = heir ? (inUnit - (heir.node.unit.length - 1) / 2) * pairStep : 0;
    const centre = heir ? heir.dx + shift : (placed[0]!.dx + placed[placed.length - 1]!.dx) / 2;
    for (const p of placed) p.dx -= centre;
    acc = acc.map((c) => ({ l: c.l - centre, r: c.r - centre }));
    return { id, unit, unitWidth, kids: placed, contour: self.concat(acc), leaf: false };
  };

  const measure = (id: number, seen: Set<number>): TreeNode | null => {
    if (seen.has(id)) return null;
    seen.add(id);
    const families = (idx.persons.get(id)?.spouse_families ?? [])
      .map((f) => idx.families.get(f))
      .filter((f): f is TreeFamily => f !== undefined);

    const unit = [id];
    for (const family of families) {
      const spouse = family.husband === id ? family.wife : family.husband;
      if (spouse != null && !seen.has(spouse)) {
        seen.add(spouse);
        unit.push(spouse);
      }
    }
    if (unit.length > 2) unit.push(unit.shift()!); // многобрачный с краю, супруги по очереди браков

    const kids: number[] = [];
    for (const family of families) {
      // выводки идут группами по очереди союзов, внутри выводка — по старшинству
      const brood = family.children.filter((c) => !seen.has(c) && idx.persons.has(c) && idx.primary.get(c) === family.id);
      brood.sort(byAge(idx, family.children));
      kids.push(...brood);
    }
    const nodes = kids.map((c) => measure(c, seen)).filter((n): n is TreeNode => n !== null);
    const node = buildNode(unit, applyManual(nodes, manual), id);
    if (families.some((f) => folded.has(f.id))) {
      // стопка свёрнутой ветки занимает ярус ниже по ширине союза — соседи под неё не заезжают
      const below = node.contour[1];
      const half = node.unitWidth / 2;
      node.contour[1] = below ? { l: Math.min(below.l, -half), r: Math.max(below.r, half) } : { l: -half, r: half };
      node.leaf = false;
    }
    return node;
  };

  // семья без родителей: узел без карточек, под ним братья и сёстры
  const measureBrood = (family: TreeFamily, seen: Set<number>): TreeNode | null => {
    const brood = family.children.filter((c) => !seen.has(c) && idx.persons.has(c) && idx.primary.get(c) === family.id);
    brood.sort(byAge(idx, family.children));
    const nodes = brood.map((c) => measure(c, seen)).filter((n): n is TreeNode => n !== null);
    return nodes.length ? buildNode([], applyManual(nodes, manual), -family.id) : null;
  };

  const put = (node: TreeNode, centre: number) => {
    const left = centre - node.unitWidth / 2;
    node.unit.forEach((id, i) => positions.set(id, left + i * pairStep));
    for (const kid of node.kids) put(kid.node, centre + kid.dx);
  };

  const roots = idx.order.filter(
    (p) =>
      p.parent_families.length === 0 &&
      p.spouse_families.some((f) => (idx.families.get(f)?.children.length ?? 0) > 0 || folded.has(f)),
  );
  // место по старшинству бывает нулём — поэтому сравниваем с пустотой, а не «ложно ли»
  roots.sort((a, b) => (ageKey(a) ?? 9999) - (ageKey(b) ?? 9999));

  // сначала семьи без родителей: иначе пришлый супруг одного из братьев заберёт его в свою ветку
  const broods = idx.familyOrder.filter(parentless);
  const eldest = (f: TreeFamily) => Math.min(9999, ...f.children.map((c) => ageKey(idx.persons.get(c)) ?? 9999));
  broods.sort((a, b) => eldest(a) - eldest(b));

  const seen = new Set<number>();
  let edge = 0;
  const tops: (() => TreeNode | null)[] = [
    ...broods.map((f) => () => measureBrood(f, seen)),
    ...roots.map((root) => () => measure(root.id, seen)),
  ];
  for (const top of tops) {
    const node = top();
    if (!node) continue;
    let l = 0;
    let r = 0;
    for (const span of node.contour) {
      l = Math.min(l, span.l);
      r = Math.max(r, span.r);
    }
    put(node, edge - l);
    edge += r - l + GAP_TREES;
  }

  // люди вне веток — одиночки без семей — встают в ряд справа
  let cursor = edge;
  for (const person of idx.order) {
    if (!positions.has(person.id)) {
      positions.set(person.id, cursor);
      cursor += pairStep;
    }
  }
  return positions;
}

// По вертикали с линейкой: ярус на медиане поколения, шаг — от типичного интервала между поколениями.
function rulerTiers(idx: Index, gen: Map<number, number>, gens: number[], height: number) {
  const median = new Map<number, number | null>();
  const range = new Map<number, GenerationRange | null>();
  const keep = new Map<number, number>();
  for (const g of gens) {
    const members = idx.order.filter((p) => gen.get(p.id) === g);
    const years = members
      .map(birthYear)
      .filter((y): y is number => !!y)
      .sort((a, b) => a - b);
    const quantile = (t: number) => years[Math.min(years.length - 1, Math.floor(years.length * t))]!;
    median.set(g, years.length ? years[Math.floor(years.length / 2)]! : null);
    range.set(
      g,
      years.length
        ? { min: years[0]!, max: years[years.length - 1]!, q1: quantile(0.25), q3: quantile(0.75), count: years.length }
        : null,
    );
    const marriages = Math.max(1, ...members.map((p) => p.spouse_families.length));
    keep.set(g, LINK_ROOM + (marriages - 1) * EXTRA_MARRIAGE_ROOM);
  }

  const gaps: number[] = [];
  for (let i = 1; i < gens.length; i++) {
    const a = median.get(gens[i - 1]!);
    const b = median.get(gens[i]!);
    if (a != null && b != null && b > a) gaps.push(b - a);
  }
  gaps.sort((a, b) => a - b);
  const typicalGap = gaps.length ? gaps[Math.floor(gaps.length / 2)]! : 28;

  // типичное поколение — базовый шаг, отклонения вполсилы, потолок — полтора шага,
  // пол — место под карточку и её связи
  const base = (height + LINK_ROOM) * 1.25;
  const rowY = new Map<number, number>();
  let prev: number | null = null;
  let prevGen: number | null = null;
  for (const g of gens) {
    if (prev === null || prevGen === null) {
      rowY.set(g, RULER_TOP);
      prev = RULER_TOP;
      prevGen = g;
      continue;
    }
    const a = median.get(prevGen);
    const b = median.get(g);
    const gap = a != null && b != null ? b - a : typicalGap;
    const soft = base * (1 + (0.5 * (gap - typicalGap)) / typicalGap);
    const floor = height + (keep.get(prevGen) ?? LINK_ROOM);
    const y: number = prev + Math.max(floor, Math.min(soft, base * 1.5));
    rowY.set(g, y);
    prev = y;
    prevGen = g;
  }

  const known = [...median.values()].filter((y): y is number => !!y);
  return {
    rowY,
    keep,
    ruler: {
      gutter: RULER_GUTTER,
      top: RULER_TOP,
      scale: base / typicalGap,
      firstYear: Math.min(...known),
      generations: gens,
      rowY,
      median,
      range,
    } satisfies RulerLayout,
  };
}

// Человек отъезжает к своему году внутри яруса; супруги вровень, ребёнок ниже родителя.
function shiftByYear(
  idx: Index,
  gen: Map<number, number>,
  gens: number[],
  ruler: RulerLayout,
  keep: Map<number, number>,
  height: number,
  y: Map<number, number>,
) {
  const maxShift = height * SHIFT_SHARE;
  const room = (step: number, g: number) =>
    Math.min(maxShift, Math.max(0, (step - height - (keep.get(g) || LINK_ROOM)) / 2));

  const limit = new Map<number, { up: number; down: number }>();
  gens.forEach((g, i) => {
    const row = ruler.rowY.get(g)!;
    const up = i > 0 ? room(row - ruler.rowY.get(gens[i - 1]!)!, gens[i - 1]!) : null;
    const down = i < gens.length - 1 ? room(ruler.rowY.get(gens[i + 1]!)! - row, g) : null;
    limit.set(g, { up: up ?? down ?? 0, down: down ?? up ?? 0 });
  });

  for (const person of idx.order) {
    const g = gen.get(person.id)!;
    const year = birthYear(person) ?? idx.estimated.get(person.id) ?? null;
    const median = ruler.median.get(g);
    let dy = 0;
    if (year != null && median != null) {
      const { up, down } = limit.get(g)!;
      dy = Math.max(-up, Math.min(down, (year - median) * ruler.scale));
    }
    y.set(person.id, ruler.rowY.get(g)! + dy);
  }

  // два правила спорят, поэтому по очереди до схождения
  const minDrop = height + CHILD_DROP;
  const hasParents = (id: number) => (idx.persons.get(id)?.parent_families.length ?? 0) > 0;
  for (let pass = 0; pass < 4; pass++) {
    for (const family of idx.familyOrder) {
      const a = family.husband;
      const b = family.wife;
      if (a == null || b == null || !y.has(a) || !y.has(b)) continue;
      const ownA = hasParents(a);
      const ownB = hasParents(b);
      if (ownA === ownB) {
        const lower = Math.max(y.get(a)!, y.get(b)!);
        y.set(a, lower);
        y.set(b, lower);
      } else if (ownA) {
        y.set(b, y.get(a)!); // пришлый встаёт к кровному
      } else {
        y.set(a, y.get(b)!);
      }
    }
    let moved = false;
    for (const g of gens) {
      for (const family of idx.familyOrder) {
        const parents = [family.husband, family.wife].filter(
          (id): id is number => id != null && y.has(id) && gen.get(id) === g,
        );
        if (!parents.length) continue;
        const parentY = Math.max(...parents.map((id) => y.get(id)!));
        for (const child of family.children) {
          if (y.has(child) && y.get(child)! < parentY + minDrop) {
            y.set(child, parentY + minDrop);
            moved = true;
          }
        }
      }
    }
    if (!moved) break;
  }
}

export function layoutTree(tree: ClanTree, metrics: CardMetrics, options: LayoutOptions): LayoutResult {
  const idx = index(tree);
  const gen = generations(tree);
  const height = cardHeight(metrics, Math.max(1, ...tree.persons.map((p) => p.spouse_families.length))) +
    (options.surnames ? SURNAME_ROOM : 0);
  const xs = placeHorizontally(idx, metrics, options);
  const gens = [...new Set(tree.persons.map((p) => gen.get(p.id)!))].sort((a, b) => a - b);

  let ruler: RulerLayout | null = null;
  const y = new Map<number, number>();
  if (options.ruler) {
    const tiers = rulerTiers(idx, gen, gens, height);
    ruler = tiers.ruler;
    for (const [id, x] of xs) xs.set(id, x + RULER_GUTTER);
    shiftByYear(idx, gen, gens, ruler, tiers.keep, height, y);
  } else {
    for (const person of tree.persons) y.set(person.id, TIER_TOP + gen.get(person.id)! * (height + metrics.tierGap));
  }

  if (options.rootAtBottom) {
    const rows = ruler ? [...ruler.rowY.values()] : gens.map((g) => TIER_TOP + g * (height + metrics.tierGap));
    const total = Math.max(...rows, ...y.values()) + height;
    for (const [id, value] of y) y.set(id, total - value - height);
    if (ruler) for (const [g, value] of ruler.rowY) ruler.rowY.set(g, total - value - height);
  }

  const kidsTop = Math.min(...tree.families.filter(parentless)
    .flatMap((f) => f.children.filter((c) => y.has(c)).map((c) => y.get(c)!)));
  const lift = Number.isFinite(kidsTop) ? Math.max(0, PARENTLESS_ROOM - kidsTop) : 0;
  if (lift) {
    for (const [id, value] of y) y.set(id, value + lift);
    if (ruler) {
      for (const [g, value] of ruler.rowY) ruler.rowY.set(g, value + lift);
      ruler.top += lift;
    }
  }

  const positions = new Map<number, Point>();
  for (const person of tree.persons) positions.set(person.id, { x: xs.get(person.id)!, y: y.get(person.id)! });

  let width = 0;
  let bottom = 0;
  for (const p of positions.values()) {
    width = Math.max(width, p.x + metrics.width);
    bottom = Math.max(bottom, p.y + height);
  }
  return {
    positions,
    generation: gen,
    cardWidth: metrics.width,
    cardHeight: height,
    width,
    height: bottom,
    ruler,
    rootAtBottom: options.rootAtBottom,
  };
}
