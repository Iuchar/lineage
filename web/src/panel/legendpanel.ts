// Легенда карты: плашка внизу слева. Свёрнутая — значок стиля и примета дерева; раскрытая — знаки
// в несколько колонок и метки рода отдельной вкладкой. Что раскрыто, помнит браузер.

import { legendBadge, legendSigns, placeGlyphs, tagGlyph, type LegendFacts } from "../canvas/legend";
import { TAG_COLORS, type TagSet } from "../canvas/tags";
import type { ClanTree } from "../api/types";
import { escapeHtml } from "../format";
import type { StyleName } from "../layout/metrics";

const KEY = "rodoslovnye.legend";

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

  constructor(host: HTMLElement, private readonly actions: LegendActions) {
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
    const count = this.tab === "signs" ? signs.length : s.tags.list.length;
    // плашка шире там, где знаков много: колонок столько, сколько есть чем занять, но не больше трёх
    this.element.style.setProperty("--cols", String(Math.max(1, Math.min(3, Math.ceil(count / 3)))));
    const body = this.tab === "signs"
      ? `<div class="lgGrid">${signs.map((sign) =>
        `<div class="lgItem">${sign.symbol}<div><b>${sign.title}</b>${sign.note ? `<i>${sign.note}</i>` : ""}</div></div>`).join("")}</div>`
      : this.tagsHtml(s);
    this.element.innerHTML = head + tabs + body;
    placeGlyphs(this.element);
  }

  private tagsHtml(s: LegendState): string {
    if (!s.tags.list.length) {
      return '<div class="lgNote">В этом дереве меток нет. Метку ставят человеку в правке.</div>';
    }
    return `<div class="lgGrid">${s.tags.list.map((tag) =>
      `<div class="lgItem tag" data-tag="${escapeHtml(tag.id)}" aria-pressed="${s.filter === tag.id}">` +
      `${tagGlyph(s.style, TAG_COLORS[tag.color])}<div><b>${escapeHtml(tag.name)}</b></div></div>`).join("")}</div>` +
      '<div class="lgNote">Выбранная метка оставляет своих людей в полную силу, остальных уводит в тень.</div>';
  }
}
