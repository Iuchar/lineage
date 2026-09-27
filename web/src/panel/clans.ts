// Столбец родов слева от карты: поиск, список со счётом людей, загрузка нового файла.
// Кнопка «‹» прячет столбец — остаётся полоска с названием рода; выбор помнит браузер.

import type { ClanSummary } from "../api/types";
import { escapeHtml } from "../format";

const HIDDEN_KEY = "rodoslovnye.clans";

export interface ClanRailActions {
  pick: (clanId: number) => void;
  add: () => void; // загрузить новый род файлом
}

export class ClanRail {
  readonly element: HTMLElement;
  private clans: ClanSummary[] = [];
  private current = 0;
  private query = "";
  private hidden = false;

  constructor(private readonly actions: ClanRailActions) {
    this.element = document.createElement("aside");
    this.element.className = "rail";
    try {
      this.hidden = localStorage.getItem(HIDDEN_KEY) === "off";
    } catch {
      this.hidden = false;
    }
    this.element.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      if (target.closest("[data-rail=toggle]")) return this.toggle();
      if (target.closest("[data-rail=add]")) return this.actions.add();
      const row = target.closest<HTMLElement>("[data-clan]");
      if (row) this.actions.pick(Number(row.dataset.clan));
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
    const name = this.clans.find((c) => c.id === this.current)?.name ?? "";
    if (this.hidden) {
      this.element.innerHTML = '<button class="railBtn" data-rail="toggle" title="Показать роды">›</button>' +
        `<span class="vert">${escapeHtml(name)}</span>`;
      return;
    }
    this.element.innerHTML =
      '<div class="railTop"><div class="find"><i>⌕</i><input data-rail="q" placeholder="найти род"></div>' +
      '<button class="railBtn" data-rail="toggle" title="Спрятать столбец">‹</button></div>' +
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
    rows.innerHTML = found.map((c) =>
      `<button class="row${c.id === this.current ? " on" : ""}" data-clan="${c.id}">` +
      `<b>${escapeHtml(c.name)}</b><small>${c.persons}</small></button>`).join("") ||
      `<div class="railNote">Ни одного рода на «${escapeHtml(this.query)}»</div>`;
  }
}
