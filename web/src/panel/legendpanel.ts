// Легенда карты: плашка внизу слева. Свёрнутая — значок стиля и примета дерева; раскрытая — знаки
// в несколько колонок и метки рода отдельной вкладкой. Что раскрыто, помнит браузер.

import { legendBadge, legendSigns, placeGlyphs, tagGlyph, type LegendFacts } from "../canvas/legend";
import { TAG_COLORS, type TagSet } from "../canvas/tags";
import type { ClanTree } from "../api/types";
import { escapeHtml } from "../format";
import type { StyleName } from "../layout/metrics";

const KEY = "rodoslovnye.legend";
const LINE = 60; // ширина рисованного знака — линии, спуска, ромба
const COLUMN_MAX = 320; // дальше длинное пояснение переносится, а не растягивает всю сетку
const COLUMN_MIN = 120;
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
  private rows: number[] = []; // ширины строк набора, по ним раскладываются колонки

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

  // колонки не равны между собой: каждая шириной со свою самую длинную строку. Берётся
  // наибольшее число колонок, при котором сумма их ширин ещё помещается в карту, —
  // поэтому короткие строки («Дети») не занимают место под длинные («щелчок — карточка семьи»)
  private fit(): void {
    const room = this.host.clientWidth - 28 - FRAME;
    const rows = this.rows;
    if (!rows.length) return;
    let widths = [Math.max(...rows)];
    for (let cols = rows.length; cols > 1; cols--) {
      const take: number[] = [];
      for (let k = 0; k < cols; k++) {
        let wide = 0;
        for (let i = k; i < rows.length; i += cols) wide = Math.max(wide, rows[i]!);
        take.push(wide);
      }
      const total = take.reduce((sum, w) => sum + w, 0) + GAP * (cols - 1);
      if (total <= room) {
        widths = take;
        break;
      }
    }
    this.element.style.setProperty("--tpl", widths.map((w) => `${w}px`).join(" "));
    this.element.style.setProperty("--body", `${widths.reduce((sum, w) => sum + w, 0) + GAP * (widths.length - 1)}px`);
  }

  // всё меряется по тому, что стоит в строках: окошко знака — по самому широкому знаку набора,
  // ширина каждой строки — по её собственному тексту. Фиксированных размеров в легенде нет
  private measure(): void {
    let sign = LINE;
    // два прохода: первый ставит окошко по знакам, второй уточняет его
    for (let pass = 0; pass < 2; pass++) {
      // минимум в ширину рисованного знака нужен только там, где такие знаки есть:
      // у меток рода знак бывает с ноготок, и окошко под линию оставляло бы пустое поле
      const lines = this.element.querySelector(".sym") ? LINE : 16;
      sign = Math.max(lines, Math.ceil(placeGlyphs(this.element)) + 6);
      this.element.style.setProperty("--sign", `${sign}px`);
    }
    this.measureRows();
    placeGlyphs(this.element);
  }

  // строки на миг разворачиваются в одну линию: видно их настоящую ширину — со знаком,
  // подписью и счётом. Заодно меряется шапка: плашка не бывает уже собственного заголовка
  private measureRows(): void {
    this.element.classList.add("measuring");
    this.rows = [...this.element.querySelectorAll<HTMLElement>(".lgItem")]
      .map((row) => Math.min(COLUMN_MAX, Math.max(COLUMN_MIN, Math.ceil(row.getBoundingClientRect().width) + 4)));
    const top = this.element.querySelector<HTMLElement>(".lgTop");
    this.element.style.setProperty("--head", `${Math.ceil(top?.getBoundingClientRect().width ?? 0) + 2}px`);
    this.element.classList.remove("measuring");
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
      `<span class="chev">${this.open ? "▾" : "▴"}</span>` +
      `${s.line ? `<span>${escapeHtml(s.line)}</span>` : ""}</div>`;
    if (!this.open) {
      this.element.innerHTML = head;
      return;
    }
    const tabs = '<div class="lgTabs">' +
      `<button type="button" data-tab="signs"${this.tab === "signs" ? ' aria-pressed="true"' : ""}>знаки</button>` +
      `<button type="button" data-tab="tags"${this.tab === "tags" ? ' aria-pressed="true"' : ""}>метки рода</button></div>`;
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
      return '<div class="lgNote">Меток в этом дереве нет — их ставят человеку в правке.</div>';
    }
    // у метки стоит счёт её людей, как у дерева в столбце
    const counts = new Map<string, number>();
    for (const ids of s.tags.of.values()) {
      for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return `<div class="lgGrid">${s.tags.list.map((tag) => {
      const on = s.filter === tag.id;
      return `<div class="lgItem tag" data-tag="${escapeHtml(tag.id)}" aria-pressed="${on}" ` +
        `title="${on ? "Вернуть всех" : "Оставить на виду только этих"}">` +
        `<span class="lgSign">${tagGlyph(s.style, TAG_COLORS[tag.color])}</span>` +
        `<div><b>${escapeHtml(tag.name)}</b></div><small>${counts.get(tag.id) ?? 0}</small></div>`;
    }).join("")}</div>` +
      '<div class="lgNote">Метки ставят человеку в правке; щелчок по метке отбирает помеченных на карте.</div>';
  }
}
