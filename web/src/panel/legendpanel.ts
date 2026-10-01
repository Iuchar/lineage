// Легенда карты: плашка внизу слева. Свёрнутая — значок стиля и примета дерева; раскрытая — знаки
// в несколько колонок и метки рода отдельной вкладкой. Что раскрыто, помнит браузер.

import { icon } from "./icons";
import { legendBadge, legendSigns, placeGlyphs, tagGlyph, type LegendFacts } from "../canvas/legend";
import { TAG_COLORS, type TagSet } from "../canvas/tags";
import type { ClanTree } from "../api/types";
import { escapeHtml } from "../format";
import type { StyleName } from "../layout/metrics";

const KEY = "rodoslovnye.legend";
const TEXT_MAX = 230; // дальше длинное пояснение переносится, а не растягивает запись
const TEXT_MIN = 60;
const SPACE = 9; // просвет между знаком и подписью
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

interface Row {
  node: HTMLElement;
  sign: number; // ширина самого знака
  text: number; // ширина подписи со счётом
}

export class LegendPanel {
  readonly element: HTMLElement;
  private open = false;
  private tab: Tab = "signs";
  private state: LegendState | null = null;

  private readonly host: HTMLElement;
  private rows: Row[] = []; // замеры записей: по ним и раскладывается легенда

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

  // Всё влезает в строку — каждая запись своей ширины, окошко знака по её собственному знаку.
  // Не влезает — записи встают колонками: берётся наибольшее число колонок, при котором
  // раскладка помещается в карту, и внутри колонки знаки равняются по самому широкому из них
  private fit(): void {
    const room = this.host.clientWidth - 28 - FRAME;
    const rows = this.rows;
    if (!rows.length) return;
    const width = (r: Row) => r.sign + SPACE + r.text;
    const oneLine = rows.reduce((sum, r) => sum + width(r), 0) + GAP * (rows.length - 1);
    if (oneLine <= room) {
      rows.forEach((r) => this.lay(r, r.sign, width(r)));
      return this.element.style.setProperty("--body", `${oneLine}px`);
    }
    for (let cols = rows.length - 1; cols >= 1; cols--) {
      const signs: number[] = [];
      const widths: number[] = [];
      for (let k = 0; k < cols; k++) {
        let sign = 0;
        let text = 0;
        for (let i = k; i < rows.length; i += cols) {
          sign = Math.max(sign, rows[i]!.sign);
          text = Math.max(text, rows[i]!.text);
        }
        signs.push(sign);
        widths.push(sign + SPACE + text);
      }
      const total = widths.reduce((sum, w) => sum + w, 0) + GAP * (cols - 1);
      if (total <= room || cols === 1) {
        rows.forEach((r, i) => this.lay(r, signs[i % cols]!, widths[i % cols]!));
        return this.element.style.setProperty("--body", `${total}px`);
      }
    }
  }

  private lay(row: Row, sign: number, width: number): void {
    row.node.style.setProperty("--sw", `${sign}px`);
    row.node.style.setProperty("--w", `${width}px`);
  }

  // фиксированных размеров в легенде нет: окошко каждого знака — по нему самому
  // (это делает placeGlyphs), ширина записи — по её собственному тексту
  private measure(): void {
    placeGlyphs(this.element); // первый проход ставит окошки под знаки
    this.measureRows();
    placeGlyphs(this.element); // второй — ставит знаки в середину уже верных окошек
  }

  // записи на миг разворачиваются в одну линию: видно настоящую ширину знака и текста
  // по отдельности. Заодно меряется шапка: плашка не бывает уже собственного заголовка
  private measureRows(): void {
    this.element.classList.add("measuring");
    this.rows = [...this.element.querySelectorAll<HTMLElement>(".lgItem")].map((node) => {
      const sign = node.querySelector<HTMLElement>(".lgSign");
      const signW = Math.ceil(sign?.getBoundingClientRect().width ?? 0);
      const text = Math.ceil(node.getBoundingClientRect().width) - signW - SPACE;
      return { node, sign: signW, text: Math.min(TEXT_MAX, Math.max(TEXT_MIN, text + 4)) };
    });
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
    // свёрнутая — короткая кнопка со значком стиля; раскрытая добавляет примету дерева,
    // а знак сворачивания стоит в правом краю, как у всякой сворачиваемой плашки
    // подсказка висит на самом знаке, а не на шапке: у шапки она вставала поверх вкладок
    const head = `<div class="lgTop"${this.open ? "" : ' title="Развернуть легенду"'}>` +
      `${legendBadge(s.style)}<b>Легенда</b>` +
      (this.open
        ? `${s.line ? `<span>${escapeHtml(s.line)}</span>` : ""}` +
          `<span class="chev" title="Свернуть легенду">${icon("down")}</span>`
        : "") + "</div>";
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
      '<div class="lgNote">Выбранная метка выделяет людей на карте.</div>';
  }
}
