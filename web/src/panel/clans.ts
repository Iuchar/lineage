// Столбец родовых деревьев слева от карты: поиск, порядок (имя, люди, статус), счёт людей, загрузка файла.
// Кнопка «‹» прячет столбец — остаётся полоска «Родовые деревья»; выбор и порядок помнит браузер.

import type { ClanSummary } from "../api/types";
import { STATUS_NAMES, STATUS_ORDER } from "../canvas/status";
import { escapeHtml } from "../format";

const HIDDEN_KEY = "rodoslovnye.clans";
const SORT_KEY = "rodoslovnye.clansSort";
type Sort = "name" | "size" | "status";

export interface ClanRailActions {
  pick: (clanId: number) => void;
  add: () => void; // загрузить новый род файлом
  share: (clanId: number, name: string) => void; // ссылка зрителям на это дерево
}

export class ClanRail {
  readonly element: HTMLElement;
  private clans: ClanSummary[] = [];
  private current = 0;
  private query = "";
  private hidden = false;
  private sort: Sort = "name";
  private editing = false; // ссылку зрителям выдаёт только редактор

  constructor(private readonly actions: ClanRailActions) {
    this.element = document.createElement("aside");
    this.element.className = "rail";
    try {
      this.hidden = localStorage.getItem(HIDDEN_KEY) === "off";
      const sort = localStorage.getItem(SORT_KEY);
      if (sort === "size" || sort === "status") this.sort = sort;
    } catch {
      this.hidden = false;
    }
    this.element.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      if (target.closest("[data-rail=toggle]")) return this.toggle();
      if (target.closest("[data-rail=add]")) return this.actions.add();
      const sort = target.closest<HTMLElement>("[data-sort]");
      if (sort) {
        this.sort = sort.dataset.sort as Sort;
        try {
          localStorage.setItem(SORT_KEY, this.sort);
        } catch {
          // без хранилища порядок вернётся к имени
        }
        return this.draw();
      }
      const share = target.closest<HTMLElement>("[data-share]");
      if (share) {
        const id = Number(share.dataset.share);
        return this.actions.share(id, this.clans.find((c) => c.id === id)?.name ?? "");
      }
      const row = target.closest<HTMLElement>("[data-clan]");
      if (row) this.actions.pick(Number(row.dataset.clan));
    });
    this.element.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const row = e.target instanceof HTMLElement && e.target.matches("[data-clan]") ? e.target : null;
      if (!row) return;
      e.preventDefault();
      this.actions.pick(Number(row.dataset.clan));
    });
    this.element.addEventListener("input", (e) => {
      const input = e.target as HTMLInputElement;
      if (input.dataset.rail !== "q") return;
      this.query = input.value.trim().toLowerCase();
      this.drawRows();
    });
  }

  setClans(clans: ClanSummary[], current: number): void {
    this.clans = clans;
    this.current = current;
    this.draw();
  }

  setEditing(editing: boolean): void {
    if (this.editing === editing) return;
    this.editing = editing;
    this.draw();
  }

  private toggle(): void {
    this.hidden = !this.hidden;
    try {
      localStorage.setItem(HIDDEN_KEY, this.hidden ? "off" : "on");
    } catch {
      // без хранилища столбец просто вернётся открытым
    }
    this.draw();
  }

  private draw(): void {
    this.element.classList.toggle("mini", this.hidden);
    if (this.hidden) {
      this.element.innerHTML = '<button class="railBtn" data-rail="toggle" title="Показать родовые деревья">›</button>' +
        '<span class="vert">Родовые деревья</span>';
      return;
    }
    this.element.innerHTML =
      '<div class="railTop"><div class="find"><i>⌕</i><input data-rail="q" placeholder="найти дерево"></div>' +
      '<button class="railBtn" data-rail="toggle" title="Спрятать столбец">‹</button></div>' +
      '<div class="sortRow"><div class="sw">' +
      ([["name", "имени"], ["size", "людям"], ["status", "статусу"]] as [Sort, string][])
        .map(([key, title]) => `<button data-sort="${key}"${this.sort === key ? ' aria-pressed="true"' : ""}>${title}</button>`).join("") +
      "</div></div>" +
      '<div class="rows" data-role="rows"></div>' +
      '<button class="railAdd" data-rail="add">+ загрузить .ged</button>';
    const input = this.element.querySelector<HTMLInputElement>("[data-rail=q]");
    if (input) input.value = this.query;
    this.drawRows();
  }

  private drawRows(): void {
    const rows = this.element.querySelector<HTMLElement>("[data-role=rows]");
    if (!rows) return;
    const words = this.query.split(/\s+/).filter(Boolean);
    const found = this.clans.filter((c) => words.every((w) => c.name.toLowerCase().includes(w)));
    const order = (c: ClanSummary) => STATUS_ORDER.indexOf(c.status);
    found.sort((a, b) => this.sort === "size" ? b.persons - a.persons
      : this.sort === "status" ? order(a) - order(b) || a.name.localeCompare(b.name, "ru")
        : a.name.localeCompare(b.name, "ru"));
    // строка рода — кнопка: до неё доходит Tab, Enter и пробел открывают дерево
    const row = (c: ClanSummary) => `<div class="row${c.id === this.current ? " on" : ""}" data-clan="${c.id}" role="button" ` +
      `tabindex="0"${c.id === this.current ? ' aria-current="true"' : ""} aria-label="${escapeHtml(c.name)}, людей: ${c.persons}">` +
      `<b>${escapeHtml(c.name)}</b><small>${c.persons}</small>` +
      (this.editing ? `<i class="railShare" data-share="${c.id}" title="Ссылка зрителям на это дерево">⋯</i>` : "") +
      "</div>";
    // по статусу — группами с подписью, в остальных порядках подписей нет
    const html = this.sort === "status"
      ? STATUS_ORDER.map((key) => {
        const group = found.filter((c) => c.status === key);
        return group.length ? `<div class="railGroup">${STATUS_NAMES[key]}</div>${group.map(row).join("")}` : "";
      }).join("")
      : found.map(row).join("");
    rows.innerHTML = html || `<div class="railNote">Ни одного дерева на «${escapeHtml(this.query)}»</div>`;
  }
}
