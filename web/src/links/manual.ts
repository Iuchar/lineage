// Ручная связка: «Связать с…» — поиск по всем родам, минуя очередь автопоиска.
// Нужна, когда род залили позже, человек перешёл в другой род по браку или двойника выбрали неверно.
// Если у человека в том роду уже есть двойник, связку предлагают переставить, а не завести вторую.

import type { LinkPerson } from "../api/types";
import { escapeHtml } from "../format";

export interface ManualActions {
  linked: () => void; // связка поставлена: перечитать связки рода
}

const span = (p: LinkPerson) => (p.born == null && p.died == null ? "годы неизвестны" : `${p.born ?? "?"} — ${p.died ?? "…"}`);

export class ManualLink {
  private readonly wrap: HTMLElement;
  private person: LinkPerson | null = null;
  private found: LinkPerson[] = [];
  private clash: LinkPerson | null = null; // выбранный, когда сервер ответил «уже есть двойник»
  private timer = 0;

  constructor(host: HTMLElement, private readonly actions: ManualActions) {
    this.wrap = document.createElement("div");
    this.wrap.className = "sheetWrap";
    this.wrap.hidden = true;
    this.wrap.addEventListener("pointerdown", (e) => {
      if (e.target === this.wrap) this.close();
    });
    this.wrap.addEventListener("click", (e) => {
      const target = (e.target as HTMLElement).closest<HTMLElement>("[data-act]");
      if (!target) return;
      if (target.dataset.act === "pick") void this.link(this.found[Number(target.dataset.i)]!, false);
      if (target.dataset.act === "replace" && this.clash) void this.link(this.clash, true);
      if (target.dataset.act === "cancel") this.close();
    });
    this.wrap.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.close();
    });
    host.append(this.wrap);
  }

  open(person: LinkPerson): void {
    this.person = person;
    this.found = [];
    this.clash = null;
    this.wrap.hidden = false;
    this.wrap.innerHTML =
      `<div class="sheet up"><h3>Связать с человеком из другого рода</h3>` +
      `<div class="file">${escapeHtml(person.name)} · ${escapeHtml(person.clan_name)} · ${span(person)}</div>` +
      `<div class="lbl">Кого ищем</div><input class="field" data-role="q" placeholder="имя или фамилия">` +
      `<div class="lbl">Заметка к связке</div><input class="field" data-role="note" placeholder="необязательно">` +
      `<div data-role="list"><div class="note">Поиск идёт по всем родам, кроме «${escapeHtml(person.clan_name)}».</div></div>` +
      `<div class="acts"><button data-act="cancel">Закрыть</button></div></div>`;
    const query = this.wrap.querySelector<HTMLInputElement>("[data-role=q]")!;
    query.value = person.name.split(" ")[0] ?? "";
    query.addEventListener("input", () => {
      window.clearTimeout(this.timer);
      this.timer = window.setTimeout(() => void this.search(query.value), 180);
    });
    query.focus();
    query.select();
    void this.search(query.value);
  }

  close(): void {
    this.wrap.hidden = true;
    this.wrap.innerHTML = "";
    this.person = null;
  }

  private async search(q: string): Promise<void> {
    if (!this.person) return;
    const params = new URLSearchParams({ q, exclude_clan: String(this.person.clan_id) });
    const response = await fetch(`/api/persons?${params}`);
    this.found = response.ok ? ((await response.json()) as LinkPerson[]) : [];
    this.clash = null;
    this.drawList();
  }

  private drawList(message = ""): void {
    const list = this.wrap.querySelector<HTMLElement>("[data-role=list]");
    if (!list) return;
    if (this.clash) {
      list.innerHTML =
        `<div class="err">${escapeHtml(message)}</div>` +
        `<div class="note">Старая связка снимется, новая встанет на её место. Люди с обеих сторон останутся как есть.</div>` +
        `<div class="acts"><button class="pri" data-act="replace">Переставить на «${escapeHtml(this.clash.name)}»</button></div>`;
      return;
    }
    list.innerHTML = message ? `<div class="err">${escapeHtml(message)}</div>` : "";
    list.innerHTML += this.found.length
      ? this.found.map((p, i) =>
          `<div class="item go" data-act="pick" data-i="${i}"><b>${escapeHtml(p.name)}</b>` +
          `<small>${escapeHtml(p.clan_name)} · ${span(p)}</small></div>`).join("")
      : '<div class="note">Никого не нашлось.</div>';
  }

  private async link(other: LinkPerson, replace: boolean): Promise<void> {
    if (!this.person) return;
    const note = this.wrap.querySelector<HTMLInputElement>("[data-role=note]")?.value.trim() || null;
    const response = await fetch("/api/links", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ a: this.person.id, b: other.id, note, replace }),
    });
    if (response.ok) {
      this.close();
      this.actions.linked();
      return;
    }
    const detail = ((await response.json().catch(() => ({}))) as { detail?: string }).detail ?? "Связать не вышло";
    this.clash = response.status === 409 ? other : null;
    this.drawList(detail);
  }
}
