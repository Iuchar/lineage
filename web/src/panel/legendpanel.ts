// Легенда карты: плашка внизу слева. Свёрнутая — значок стиля и примета дерева; раскрытая — знаки
// в несколько колонок и метки рода отдельной вкладкой. Что раскрыто, помнит браузер.

import { legendBadge, legendSigns, placeGlyphs, tagGlyph, type LegendFacts } from "../canvas/legend";
import { TAG_COLORS, type TagSet } from "../canvas/tags";
import type { ClanTree } from "../api/types";
import { escapeHtml } from "../format";
import type { StyleName } from "../layout/metrics";

const KEY = "rodoslovnye.legend";
const LINE = 60; // ширина рисованного знака — линии, спуска, ромба
const LABEL = 156; // место под подпись с пояснением
const GAP = 18; // просвет между колонками
const FRAME = 26; // поля плашки вместе с рамкой

export interface LegendState {
  tree: ClanTree | null;
  style: StyleName;
  facts: LegendFacts;
  line: string; // примета дерева: «8 поколений: Дункан — Кеннет»
  tags: TagSet;
  filter: string | null;
}

export interface LegendActions {
  filter: (tag: string | null) => void;
}

type Tab = "signs" | "tags";

export class LegendPanel {
  readonly element: HTMLElement;
  private open = false;
  private tab: Tab = "signs";
  private state: LegendState | null = null;

  private readonly host: HTMLElement;
  private column = LINE + 9 + LABEL;

  constructor(host: HTMLElement, private readonly actions: LegendActions) {
    this.host = host;
    try {
      this.open = localStorage.getItem(KEY) === "open";
    } catch {
      this.open = false;
    }
    this.element = document.createElement("div");
    this.element.className = "legend";
    this.element.hidden = true;
    this.element.addEventListener("pointerdown", (e) => e.stopPropagation());
    this.element.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      const tab = target.closest<HTMLElement>("[data-tab]");
      if (tab) {
        this.tab = tab.dataset.tab as Tab;
        return this.draw();
      }
      const tag = target.closest<HTMLElement>("[data-tag]");
      if (tag) return this.actions.filter(this.state?.filter === tag.dataset.tag ? null : tag.dataset.tag ?? null);
      if (target.closest(".lgTop")) {
        this.open = !this.open;
        try {
          localStorage.setItem(KEY, this.open ? "open" : "closed");
        } catch {
          // без хранилища легенда просто откроется заново
        }
        this.draw();
      }
    });
    host.append(this.element);
    // карта меняет ширину, когда открывают панели и столбец — колонки пересчитываются
    new ResizeObserver(() => this.fit()).observe(host);
  }

  // колонок столько, сколько есть чем занять, но не больше, чем помещается в карту
  private fit(): void {
    const count = Number(this.element.dataset.count ?? 0);
    const room = this.host.clientWidth - 28 - FRAME;
    const wide = Math.max(1, Math.floor((room + GAP) / (this.column + GAP)));
    this.element.style.setProperty("--cols", String(Math.max(1, Math.min(count, wide))));
  }

  // окошко знака — по самому широкому знаку набора: у одних линий оно узкое,
  // с плашкой «выжжен из рода» — шире, и пустого поля рядом со знаком не остаётся
  private measure(): void {
    // два прохода: первый ставит окошко по знакам, второй уточняет его и ставит знаки в середину
    for (let pass = 0; pass < 2; pass++) {
      // минимум в ширину рисованного знака нужен только там, где такие знаки есть:
      // у меток рода знак бывает с ноготок, и окошко под линию оставляло бы пустое поле
      const lines = this.element.querySelector(".sym") ? LINE : 16;
      const sign = Math.max(lines, Math.ceil(placeGlyphs(this.element)) + 6);
      this.column = sign + 9 + LABEL;
      this.element.style.setProperty("--sign", `${sign}px`);
      this.element.style.setProperty("--col", `${this.column}px`);
    }
    placeGlyphs(this.element);
  }

  show(state: LegendState): void {
    this.state = state;
    this.draw();
  }

  private draw(): void {
    const s = this.state;
    if (!s?.tree) {
      this.element.hidden = true;
      return;
    }
    const signs = legendSigns(s.tree, s.style, s.facts);
    this.element.hidden = !signs.length && !s.tags.list.length;
    this.element.classList.toggle("open", this.open);
    const head = `<div class="lgTop">${legendBadge(s.style)}<b>Легенда</b>` +
      `${s.line ? `<span>${escapeHtml(s.line)}</span>` : ""}<span class="chev">${this.open ? "▾" : "▴"}</span></div>`;
    if (!this.open) {
      this.element.innerHTML = head;
      return;
    }
    const tabs = '<div class="lgTabs">' +
      `<button type="button" data-tab="signs"${this.tab === "signs" ? ' aria-pressed="true"' : ""}>знаки</button>` +
      `<button type="button" data-tab="tags"${this.tab === "tags" ? ' aria-pressed="true"' : ""}>метки рода</button></div>`;
    this.element.dataset.count = String(this.tab === "signs" ? signs.length : s.tags.list.length);
    this.fit();
    const body = this.tab === "signs"
      ? `<div class="lgGrid">${signs.map((sign) =>
        `<div class="lgItem"><span class="lgSign">${sign.symbol}</span>` +
        `<div><b>${sign.title}</b>${sign.note ? `<i>${sign.note}</i>` : ""}</div></div>`).join("")}</div>`
      : this.tagsHtml(s);
    this.element.innerHTML = head + tabs + body;
    this.measure();
    this.fit();
    // рукописные и наборные знаки меряются верно только со своим шрифтом: пока он не применён,
    // ширина знака завышена — после загрузки окошко пересчитывается
    void document.fonts?.ready.then(() => {
      if (this.open && !this.element.hidden) {
        this.measure();
        this.fit();
      }
    });
  }

  private tagsHtml(s: LegendState): string {
    if (!s.tags.list.length) {
      return '<div class="lgNote">В этом дереве меток нет. Метку ставят человеку в правке.</div>';
    }
    return `<div class="lgGrid">${s.tags.list.map((tag) =>
      `<div class="lgItem tag" data-tag="${escapeHtml(tag.id)}" aria-pressed="${s.filter === tag.id}">` +
      `<span class="lgSign">${tagGlyph(s.style, TAG_COLORS[tag.color])}</span>` +
      `<div><b>${escapeHtml(tag.name)}</b></div></div>`).join("")}</div>` +
      '<div class="lgNote">Выбранная метка оставляет своих людей в полную силу, остальных уводит в тень.</div>';
  }
}
