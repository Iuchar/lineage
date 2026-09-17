// Холст рода: раскладка → карточки и связи → карта с протяжкой и зумом, линейка поверх.

import type { ClanTree } from "../api/types";
import { foldsHiding, foldTree } from "../layout/fold";
import { layoutTree, type LayoutResult } from "../layout/layout";
import { STYLE_METRICS, type StyleName } from "../layout/metrics";
import { drawCards, drawFolds, NO_MARKS, type PersonMarks, type ReviewMark } from "./cards";
import { mainLine, NO_LINE } from "./heirs";
import { NO_TAGS, type TagSet } from "./tags";
import { lineageOf } from "./lineage";
import { drawLinks } from "./links";
import { drawRuler } from "./ruler";
import { centreOn, fitAll, keepAnchor, type View, zoomAt } from "./view";

export interface CanvasState {
  style: StyleName;
  ruler: boolean;
  rootAtBottom: boolean;
}

// пыльца на фоне викторианского стиля — крошечные искры и точки, фактура бумаги
const POLLEN = (color: string, width: number, height: number) =>
  `<defs><pattern id="vic" width="58" height="58" patternUnits="userSpaceOnUse">` +
  `<g fill="none" stroke="${color}" stroke-width=".9" stroke-linecap="round">` +
  `<path d="M15 9 v5 M15 18 v5 M9 16 h5 M17 16 h5"/><path d="M44 38 v5 M44 47 v5 M38 45 h5 M46 45 h5"/></g>` +
  `<g fill="${color}"><circle cx="44" cy="16" r="1.3"/><circle cx="15" cy="45" r="1.3"/></g>` +
  `</pattern></defs><rect width="${width}" height="${height}" fill="url(#vic)"/>`;

export class TreeCanvas {
  readonly viewport: HTMLElement;
  private readonly surface: HTMLElement;
  private readonly rulerLayer: HTMLElement;

  private tree: ClanTree | null = null;
  private layout: LayoutResult | null = null;
  private size = { width: 1000, height: 1000 };
  private view: View = { k: 1, x: 0, y: 0 };
  private drag: { sx: number; sy: number; vx: number; vy: number; moved: number } | null = null;

  selected: number | null = null;
  marks: PersonMarks = NO_MARKS;
  // метки разбора перезалива; пусто — обычная карта
  review: ReadonlyMap<number, ReviewMark> = new Map();
  // портреты: включены ли и чьи снимки известны; без снимка рисуется заглушка-профиль
  portraits = true;
  photos: ReadonlyMap<number, string> = new Map();
  tags: TagSet = NO_TAGS;
  filter: string | null = null; // выбранная метка — её люди в полную силу, остальные в тени
  // отмеченные продолжатели главной линии; поля в данных пока нет, отметки приходят из демо-набора
  heirs: ReadonlySet<number> = new Set();
  // ручной сдвиг среди братьев: id → на сколько мест; живёт до смены рода, в базу не пишется
  readonly manual = new Map<number, number>();
  // свёрнутые союзы; живут до смены рода, как и ручной сдвиг
  readonly folded = new Set<number>();
  state: CanvasState = { style: "gobelen", ruler: false, rootAtBottom: false };

  onViewChange: (view: View) => void = () => {};
  onSelect: (id: number | null) => void = () => {};
  onFoldChange: () => void = () => {};

  constructor(host: HTMLElement) {
    this.viewport = document.createElement("div");
    this.viewport.className = "viewport";
    this.surface = document.createElement("div");
    this.surface.className = "canvas";
    this.rulerLayer = document.createElement("div");
    this.rulerLayer.className = "ruler";
    this.rulerLayer.hidden = true;
    this.viewport.append(this.surface, this.rulerLayer);
    host.append(this.viewport);
    this.bindEvents();
  }

  get zoom(): number {
    return this.view.k;
  }

  setTree(tree: ClanTree, marks: PersonMarks = NO_MARKS, review: ReadonlyMap<number, ReviewMark> = new Map(),
          tags: TagSet = NO_TAGS, heirs: ReadonlySet<number> = new Set()): void {
    this.tree = tree;
    this.marks = marks;
    this.review = review;
    this.tags = tags;
    this.heirs = heirs;
    this.filter = null;
    this.selected = null;
    this.manual.clear();
    this.folded.clear();
    this.render();
    this.fit();
    this.onSelect(null);
  }

  // сдвинуть человека среди братьев; вид остаётся на месте
  nudge(id: number, direction: -1 | 1): void {
    this.manual.set(id, (this.manual.get(id) ?? 0) + direction);
    this.keepView(() => this.render());
  }

  // показать или спрятать портреты; вид остаётся на месте
  showPortraits(on: boolean): void {
    this.portraits = on;
    this.keepView(() => this.render());
  }

  // оставить в полную силу людей с меткой; пусто — снять фильтр
  filterByTag(tag: string | null): void {
    this.filter = tag;
    this.render();
  }

  // свернуть или развернуть ветку под союзом; вид остаётся на месте
  toggleFold(familyId: number): void {
    if (!this.folded.delete(familyId)) this.folded.add(familyId);
    this.keepView(() => this.render());
    this.onFoldChange();
  }

  // развернуть ветки, за которыми спрятан человек, — перед переходом к нему из поиска или панели
  reveal(personId: number): void {
    if (!this.tree) return;
    const hiding = foldsHiding(this.tree, this.folded, personId);
    if (!hiding.length) return;
    for (const id of hiding) this.folded.delete(id);
    this.render();
    this.onFoldChange();
  }

  update(state: Partial<CanvasState>): void {
    const moved = (Object.keys(state) as (keyof CanvasState)[]).some((key) => state[key] !== this.state[key]);
    this.state = { ...this.state, ...state };
    // линейка, стиль и переворот основателя перестраивают полотно, но не вид: масштаб остаётся,
    // а выбранный человек или тот, кто был в центре, — на том же месте экрана
    if (moved) this.keepView(() => this.render());
    else this.render();
  }

  select(id: number | null): void {
    this.selected = id;
    this.render();
    this.onSelect(id);
  }

  fit(): void {
    this.setView(fitAll(this.size, this.viewportSize()));
  }

  zoomBy(factor: number): void {
    const { width, height } = this.viewportSize();
    this.setView(zoomAt(this.view, width / 2, height / 2, factor));
  }

  resetZoom(): void {
    this.zoomBy(1 / this.view.k);
  }

  // показать человека в центре, не выбирая его; на мелком плане сначала приблизить, чтобы метки читались
  centreOnPerson(id: number): void {
    const centre = this.cardCentre(id);
    if (!centre) return;
    const view = this.view.k < 0.8 ? { ...this.view, k: 1 } : this.view;
    this.setView(centreOn(view, centre, this.viewportSize()));
  }

  goToSelected(): void {
    const centre = this.selected != null ? this.cardCentre(this.selected) : null;
    if (centre) this.setView(centreOn(this.view, centre, this.viewportSize()));
  }

  render(): void {
    if (!this.tree) return;
    const { style } = this.state;
    const metrics = STYLE_METRICS[style];
    const { tree, folds } = foldTree(this.tree, this.folded);
    const foldedIds = new Set(folds.keys());
    this.layout = layoutTree(tree, metrics, {
      ruler: this.state.ruler,
      rootAtBottom: this.state.rootAtBottom,
      manual: this.manual,
      folded: foldedIds,
      heirs: this.heirs,
    });
    const layout = this.layout;

    const width = layout.width + 40;
    const height = layout.height + 60;
    this.size = { width, height };
    this.surface.style.width = `${width}px`;
    this.surface.style.height = `${height}px`;

    const styles = getComputedStyle(document.body);
    const color = (name: string, fallback: string) => (styles.getPropertyValue(name) || fallback).trim();
    const links = drawLinks(tree, layout, style, color, undefined, foldedIds);
    const defs = style === "viktorian" ? POLLEN(color("--orn", "transparent"), width, height) : "";
    // линия рода выбранного: путь акцентом, остальное дерево в тени
    const lineage = this.selected != null ? lineageOf(tree, layout, style, links, this.selected) : null;
    const lit = lineage?.paths ? lineage : null;
    // главная линия: ствол подсвечен всегда, дерево вокруг не глушится; при выборе человека
    // на карте остаётся одна нить — его линия рода
    // линия считается по всему роду, а не по свёрнутому виду: спрятанная ветка — не обрыв
    const line = this.heirs.size ? mainLine(this.tree, this.heirs) : NO_LINE;
    // свёрнутая ветка прячет конец линии — ствол тогда доходит до последнего видимого
    const deepest = [...line.persons].find((id) => layout.positions.has(id));
    const trunk = !lit && deepest != null ? lineageOf(tree, layout, style, links, deepest).paths : "";
    const shown = line.last != null && layout.positions.has(line.last);
    this.surface.classList.toggle("lineage", lit !== null);
    this.surface.classList.toggle("filtered", this.filter !== null);

    this.surface.innerHTML =
      (defs ? `<svg class="ornament" width="${width}" height="${height}">${defs}</svg>` : "") +
      `<svg class="links" width="${width}" height="${height}">${links.paths}${links.marks}</svg>` +
      (lit ? `<svg class="line" width="${width}" height="${height}"><path d="${lit.paths}"/></svg>` : "") +
      (trunk ? `<svg class="line main" width="${width}" height="${height}"><path d="${trunk}"/></svg>` : "") +
      drawCards(tree, layout, style, this.selected, this.marks, lit?.persons, this.review,
        { portraits: this.portraits, photos: this.photos, tags: this.tags, filter: this.filter,
          heirs: line.persons, broken: line.broken && shown ? line.last : null }) +
      drawFolds(links.folds, folds, style);

    // лампа «Ночного кабинета» ездит за выбранным
    const lamp = this.selected != null ? this.cardCentre(this.selected) : null;
    if (style === "kabinet" && lamp) {
      this.surface.style.setProperty("--lampx", `${lamp.x}px`);
      this.surface.style.setProperty("--lampy", `${lamp.y}px`);
    }
    this.apply();
  }

  private cardCentre(id: number): { x: number; y: number } | null {
    const p = this.layout?.positions.get(id);
    return p && this.layout ? { x: p.x + this.layout.cardWidth / 2, y: p.y + this.layout.cardHeight / 2 } : null;
  }

  private viewportSize() {
    return { width: this.viewport.clientWidth, height: this.viewport.clientHeight };
  }

  private setView(view: View): void {
    this.view = view;
    this.apply();
  }

  private apply(): void {
    const { k, x, y } = this.view;
    this.surface.style.transform = `translate(${x.toFixed(1)}px,${y.toFixed(1)}px) scale(${k.toFixed(3)})`;
    this.drawRuler();
    this.onViewChange(this.view);
  }

  private drawRuler(): void {
    const layout = this.layout;
    if (!layout?.ruler) {
      this.rulerLayer.hidden = true;
      return;
    }
    this.rulerLayer.hidden = false;
    const generation = this.selected != null ? (layout.generation.get(this.selected) ?? null) : null;
    this.rulerLayer.innerHTML = drawRuler(layout, this.view, this.viewport.clientHeight, generation);
  }

  // якорь — выбранный человек или ближайший к центру экрана
  private keepView(rebuild: () => void): void {
    const before = this.anchor();
    rebuild();
    if (!before) return;
    const after = this.cardCentre(before.id);
    if (after) this.setView(keepAnchor(this.view, before.point, after));
  }

  private anchor(): { id: number; point: { x: number; y: number } } | null {
    if (!this.layout) return null;
    if (this.selected != null) {
      const point = this.cardCentre(this.selected);
      if (point) return { id: this.selected, point };
    }
    const { width, height } = this.viewportSize();
    const cx = (width / 2 - this.view.x) / this.view.k;
    const cy = (height / 2 - this.view.y) / this.view.k;
    let best: { id: number; point: { x: number; y: number } } | null = null;
    let bestDistance = Infinity;
    for (const id of this.layout.positions.keys()) {
      const point = this.cardCentre(id)!;
      const d = (point.x - cx) ** 2 + (point.y - cy) ** 2;
      if (d < bestDistance) {
        bestDistance = d;
        best = { id, point };
      }
    }
    return best;
  }

  private bindEvents(): void {
    const vp = this.viewport;

    // колесо — зум к курсору; с Shift — горизонтальная протяжка
    vp.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const r = vp.getBoundingClientRect();
        if (e.ctrlKey || !e.shiftKey) {
          this.setView(zoomAt(this.view, e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.12 : 1 / 1.12));
        } else {
          this.setView({ ...this.view, x: this.view.x - e.deltaY });
        }
      },
      { passive: false },
    );

    document.addEventListener("dragstart", (e) => e.preventDefault());

    vp.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault(); // иначе браузер тянет выделение текста
      window.getSelection()?.removeAllRanges();
      this.drag = { sx: e.clientX, sy: e.clientY, vx: this.view.x, vy: this.view.y, moved: 0 };
      vp.setPointerCapture(e.pointerId);
      vp.classList.add("dragging");
    });
    vp.addEventListener("pointermove", (e) => {
      if (!this.drag) return;
      const dx = e.clientX - this.drag.sx;
      const dy = e.clientY - this.drag.sy;
      this.drag.moved = Math.max(this.drag.moved, Math.abs(dx) + Math.abs(dy));
      this.setView({ ...this.view, x: this.drag.vx + dx, y: this.drag.vy + dy });
    });
    const endDrag = (e: PointerEvent) => {
      vp.classList.remove("dragging");
      const drag = this.drag;
      this.drag = null;
      // короткое касание без протяжки — выбор человека
      if (drag && drag.moved <= 4 && e.type === "pointerup") {
        const hits = document.elementsFromPoint(e.clientX, e.clientY);
        const fold = hits.find((el) => el.closest(".fold"))?.closest<HTMLElement>(".fold");
        if (fold?.dataset.fold) return this.toggleFold(Number(fold.dataset.fold));
        const node = hits.find((el) => el.closest(".node"))?.closest<HTMLElement>(".node");
        if (node?.dataset.id) this.select(Number(node.dataset.id));
        else if (this.selected != null) this.select(null); // щелчок по пустому месту снимает выбор
      }
    };
    vp.addEventListener("pointerup", endDrag);
    vp.addEventListener("pointercancel", endDrag);

    window.addEventListener("resize", () => this.drawRuler());
  }
}
