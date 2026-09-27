// Две панели справа: «Вид» — стиль, тема и всё про показ древа; «Легенда» — что значат линии,
// знаки и пометки на карте, и метки этого рода. Открыты по одной, поверх панели человека.

import { TAG_COLORS, type TagSet } from "../canvas/tags";
import type { StyleName } from "../layout/metrics";
import { escapeHtml } from "../format";

export type ViewMode = "view" | "legend" | null;

export interface ViewState {
  style: StyleName;
  theme: "dark" | "light";
  mainLine: boolean;
  hasHeirs: boolean;
  rootAtBottom: boolean;
  surnames: "off" | "maiden" | "married";
  portraits: boolean;
  ruler: boolean;
  tags: TagSet;
  filter: string | null;
}

export interface ViewActions {
  style: (style: StyleName) => void;
  theme: (theme: "dark" | "light") => void;
  mainLine: (on: boolean) => void;
  rootAtBottom: (on: boolean) => void;
  surnames: (mode: "off" | "maiden" | "married") => void;
  portraits: (on: boolean) => void;
  ruler: (on: boolean) => void;
  foldAll: () => void;
  unfoldAll: () => void;
  filter: (tag: string | null) => void;
  closed: () => void;
}

export const STYLE_NAMES: [StyleName, string][] = [
  ["gobelen", "Зал предков"],
  ["viktorian", "Викторианский"],
  ["gazeta", "Типография"],
  ["kabinet", "Ночной кабинет"],
  ["polotno", "Афиша"],
];

// знаки карты: образец слева, объяснение справа
const LEGEND: [string, string, string][] = [
  ["line", "нить брака", "пара стоит рядом, нить между ними"],
  ["past", "прошлый брак", "приглушённая и пунктиром; так же рисуется развод"],
  ["ord", "первый, второй…", "очередь браков у многобрачного"],
  ["drop", "спуск к детям", "от нити союза вниз, к шине выводка"],
  ["foster", "спуск пунктиром", "приёмный или под опекой; у карточки ярлык"],
  ["knot", "узел без пары", "родители не записаны: братья и сёстры одной семьи"],
  ["dia", "◆ продолжатель", "через него идёт главная ветвь рода"],
  ["trunk", "ствол", "главная ветвь: от основателя через продолжателей"],
  ["burnt", "выжжен из рода", "карточка приглушена, портрет затемнён, знак под именем"],
  ["hidden", "скрыт от зрителей", "виден только в правке, с пометкой"],
  ["fold", "стопка «N в ветке»", "ветка свёрнута; щелчок открывает одно поколение"],
  ["also", "также в роду", "тот же человек есть в другом роду — переход"],
];

export class ViewPanel {
  readonly element: HTMLElement;
  mode: ViewMode = null;
  private state: ViewState | null = null;

  constructor(host: HTMLElement, private readonly actions: ViewActions) {
    this.element = document.createElement("aside");
    this.element.className = "viewPanel";
    this.element.hidden = true;
    this.element.addEventListener("click", (e) => {
      const target = (e.target as HTMLElement).closest<HTMLElement>("[data-set],[data-act]");
      if (!target) return;
      const value = target.dataset.v ?? "";
      switch (target.dataset.set) {
        case "style": return this.actions.style(value as StyleName);
        case "theme": return this.actions.theme(value as "dark" | "light");
        case "line": return this.actions.mainLine(value === "main");
        case "root": return this.actions.rootAtBottom(value === "bottom");
        case "surnames": return this.actions.surnames(value as "off" | "maiden" | "married");
        case "tag": return this.actions.filter(this.state?.filter === value ? null : value);
        default: break;
      }
      if (target.dataset.act === "fold") return this.actions.foldAll();
      if (target.dataset.act === "unfold") return this.actions.unfoldAll();
      if (target.dataset.act === "close") return this.actions.closed();
    });
    this.element.addEventListener("change", (e) => {
      const input = e.target as HTMLInputElement;
      if (input.dataset.flag === "portraits") this.actions.portraits(input.checked);
      if (input.dataset.flag === "ruler") this.actions.ruler(input.checked);
    });
    host.append(this.element);
  }

  show(mode: ViewMode, state: ViewState): void {
    this.mode = mode;
    this.state = state;
    this.element.hidden = mode === null;
    if (mode === null) return;
    this.element.innerHTML = mode === "view" ? this.viewHtml(state) : this.legendHtml(state);
  }

  private seg(name: string, options: [string, string][], current: string): string {
    return `<div class="seg2">${options.map(([v, t]) =>
      `<button type="button" data-set="${name}" data-v="${v}"${v === current ? ' aria-pressed="true"' : ""}>${t}</button>`).join("")}</div>`;
  }

  private head(title: string): string {
    return `<div class="vpTop"><b>${title}</b><button class="vpClose" data-act="close" title="Закрыть (Esc)">×</button></div>`;
  }

  private viewHtml(s: ViewState): string {
    return this.head("Вид") +
      '<div class="sec"><span class="lbl2">стиль</span><div class="styles">' +
      STYLE_NAMES.map(([id, name]) =>
        `<button type="button" class="vpBtn${id === s.style ? " on" : ""}" data-set="style" data-v="${id}">${name}</button>`).join("") +
      "</div></div>" +
      `<div class="sec"><span class="lbl2">тема</span>${this.seg("theme", [["dark", "☾ тёмная"], ["light", "☀ светлая"]], s.theme)}</div>` +
      '<div class="sec"><span class="lbl2">древо</span>' +
      (s.hasHeirs ? this.seg("line", [["plain", "стандарт"], ["main", "главная ветвь"]], s.mainLine ? "main" : "plain") : "") +
      this.seg("root", [["top", "основатель сверху"], ["bottom", "снизу"]], s.rootAtBottom ? "bottom" : "top") +
      '<div class="line"><button type="button" class="vpBtn" data-act="fold">свернуть все ветки</button>' +
      '<button type="button" class="vpBtn" data-act="unfold">развернуть все</button></div></div>' +
      '<div class="sec"><span class="lbl2">карточки</span>' +
      this.seg("surnames", [["off", "без фамилий"], ["maiden", "девичья"], ["married", "после брака"]], s.surnames) +
      `<label class="chk2"><input type="checkbox" data-flag="portraits"${s.portraits ? " checked" : ""}> портреты</label>` +
      `<label class="chk2"><input type="checkbox" data-flag="ruler"${s.ruler ? " checked" : ""}> линейка дат</label></div>`;
  }

  private legendHtml(s: ViewState): string {
    const tags = s.tags.list.length
      ? `<div class="tagFilter">${s.tags.list.map((t) =>
        `<button class="chip" data-set="tag" data-v="${escapeHtml(t.id)}" style="--c:${TAG_COLORS[t.color]}" ` +
        `aria-pressed="${s.filter === t.id}"><i></i>${escapeHtml(t.name)}</button>`).join("")}</div>` +
        '<div class="vpNote">Метка оставляет своих людей в полную силу, остальных уводит в тень.</div>'
      : '<div class="vpNote">В этом роду меток пока нет. Метку ставят человеку в правке.</div>';
    return this.head("Легенда") +
      '<div class="sec"><span class="lbl2">знаки карты</span><div class="legRows">' +
      LEGEND.map(([key, title, note]) =>
        `<div class="legRow"><span class="legSample lg-${key}"></span><span><b>${title}</b><i>${note}</i></span></div>`).join("") +
      '</div></div>' +
      `<div class="sec"><span class="lbl2">метки рода</span>${tags}</div>`;
  }
}
