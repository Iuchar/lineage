// Две панели справа: «Вид» — стиль, тема и всё про показ древа; «Легенда» — что значат линии,
// знаки и пометки на карте, и метки этого рода. Открыты по одной, поверх панели человека.

import { icon } from "./icons";
import type { StyleName } from "../layout/metrics";

export type ViewMode = "view" | null;

export interface ViewState {
  style: StyleName;
  theme: "dark" | "light";
  mainLine: boolean;
  hasHeirs: boolean;
  rootAtBottom: boolean;
  surnames: "off" | "maiden" | "married";
  portraits: boolean;
  ruler: boolean;
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
  closed: () => void;
}

export const STYLE_NAMES: [StyleName, string][] = [
  ["gobelen", "Зал предков"],
  ["viktorian", "Викторианский"],
  ["gazeta", "Типография"],
  ["kabinet", "Ночной кабинет"],
  ["polotno", "Афиша"],
];

export class ViewPanel {
  readonly element: HTMLElement;
  mode: ViewMode = null;
  private state: ViewState | null = null;

  constructor(host: HTMLElement, private readonly actions: ViewActions) {
    this.element = document.createElement("aside");
    this.element.className = "viewPanel";
    this.element.setAttribute("aria-label", "Вид");
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
    this.element.innerHTML = this.viewHtml(state);
  }

  private seg(name: string, options: [string, string][], current: string): string {
    return `<div class="seg2">${options.map(([v, t]) =>
      `<button type="button" data-set="${name}" data-v="${v}"${v === current ? ' aria-pressed="true"' : ""}>${t}</button>`).join("")}</div>`;
  }

  private head(title: string): string {
    return `<div class="vpTop"><b>${title}</b><button class="vpClose" data-act="close" title="Закрыть (Esc)" aria-label="Закрыть">${icon("close")}</button></div>`;
  }

  private viewHtml(s: ViewState): string {
    return this.head("Вид") +
      '<div class="sec"><span class="lbl2">стиль</span><div class="styles">' +
      STYLE_NAMES.map(([id, name]) =>
        `<button type="button" class="vpBtn${id === s.style ? " on" : ""}" data-set="style" data-v="${id}">${name}</button>`).join("") +
      "</div></div>" +
      `<div class="sec"><span class="lbl2">тема</span>${this.seg("theme", [["dark", `${icon("moon", true)}тёмная`], ["light", `${icon("sun", true)}светлая`]], s.theme)}</div>` +
      '<div class="sec"><span class="lbl2">древо</span>' +
      // «главная ветвь» видна всегда: без отмеченных продолжателей — приглушённой, с подсказкой
      `<div class="seg2${s.hasHeirs ? "" : " off"}"${s.hasHeirs ? "" : ' title="Отметьте продолжателей в правке"'}>` +
      `<button type="button" data-set="line" data-v="plain"${s.mainLine ? "" : ' aria-pressed="true"'}>стандарт</button>` +
      `<button type="button" data-set="line" data-v="main"${s.mainLine ? ' aria-pressed="true"' : ""}` +
      `${s.hasHeirs ? "" : " disabled"}>главная ветвь</button></div>` +
      this.seg("root", [["top", "основатель сверху"], ["bottom", "снизу"]], s.rootAtBottom ? "bottom" : "top") +
      '<div class="line"><button type="button" class="vpBtn" data-act="fold">свернуть все ветки</button>' +
      '<button type="button" class="vpBtn" data-act="unfold">развернуть все</button></div></div>' +
      '<div class="sec"><span class="lbl2">карточки</span>' +
      this.seg("surnames", [["off", "без фамилий"], ["maiden", "девичья"], ["married", "после брака"]], s.surnames) +
      `<label class="chk2"><input type="checkbox" data-flag="portraits"${s.portraits ? " checked" : ""}> портреты</label>` +
      `<label class="chk2"><input type="checkbox" data-flag="ruler"${s.ruler ? " checked" : ""}> линейка дат</label></div>`;
  }

}
