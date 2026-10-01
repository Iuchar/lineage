// Общий журнал рода — в верхней панели: «Отменить», «Повторить» и список правок с «отменить это и всё после».
// История человека — во вкладке панели: только его правки, у каждой «вернуть» новой правкой.
// И короткое «Сохранено · Отменить» внизу карты после каждой правки.

import { icon } from "../panel/icons";
import type { ChangeInfo } from "../api/types";
import { escapeHtml } from "../format";
import { send } from "./api";

export interface JournalActions {
  clanId: () => number;
  changed: (focus: number | null) => void; // журнал сдвинулся: перечитать род
  goTo: (personId: number) => void;
}

const time = (iso: string) => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
const day = (iso: string) => {
  const d = new Date(iso);
  const today = new Date();
  const diff = Math.round((new Date(today.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 86400000);
  return diff === 0 ? "сегодня" : diff === 1 ? "вчера" : d.toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
};

export class Journal {
  readonly group: HTMLElement;
  private readonly undoBtn: HTMLButtonElement;
  private readonly redoBtn: HTMLButtonElement;
  private readonly listBtn: HTMLButtonElement;
  private readonly drop: HTMLElement;
  private readonly toastBox: HTMLElement;
  private toastTimer = 0;
  private changes: ChangeInfo[] = [];

  constructor(stage: HTMLElement, private readonly actions: JournalActions) {
    this.group = document.createElement("div");
    this.group.className = "grp";
    this.group.innerHTML = `<div class="sw"><button class="undo" title="Отменить последнюю правку (Ctrl+Z)">${icon("undo", true)}Отменить</button>` +
      `<button title="Повторить отменённое (Ctrl+Shift+Z)" aria-label="Повторить отменённое">${icon("redo")}</button><button>Журнал</button></div>`;
    const buttons = this.group.querySelectorAll("button");
    this.undoBtn = buttons[0]!;
    this.redoBtn = buttons[1]!;
    this.listBtn = buttons[2]!;
    this.undoBtn.addEventListener("click", () => void this.step("undo"));
    this.redoBtn.addEventListener("click", () => void this.step("redo"));
    this.listBtn.addEventListener("click", () => (this.drop.hidden ? void this.openList() : this.closeList()));

    this.drop = document.createElement("div");
    this.drop.className = "journalDrop";
    this.drop.hidden = true;
    document.body.append(this.drop);
    this.drop.addEventListener("click", (e) => void this.onDrop(e));
    document.addEventListener("pointerdown", (e) => {
      const target = e.target as HTMLElement;
      if (!this.drop.hidden && !this.drop.contains(target) && !this.listBtn.contains(target)) this.closeList();
    });

    this.toastBox = document.createElement("div");
    this.toastBox.className = "toast";
    this.toastBox.hidden = true;
    stage.append(this.toastBox);
    this.toastBox.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest("[data-act=undo]")) void this.step("undo");
    });

    document.addEventListener("keydown", (e) => {
      if (this.group.hidden || !(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "z") return;
      if ((e.target as HTMLElement).closest("input, textarea")) return; // в поле — отмена набора, не правки
      e.preventDefault();
      void this.step(e.shiftKey ? "redo" : "undo");
    });
  }

  // счёт и доступность кнопок
  async refresh(): Promise<void> {
    const result = await send<ChangeInfo[]>("GET", `/api/clans/${this.actions.clanId()}/changes`);
    this.changes = result.ok ? result.data : [];
    const active = this.changes.filter((c) => !c.undone).length;
    this.undoBtn.disabled = active === 0;
    this.redoBtn.disabled = !this.changes.some((c) => c.undone);
    this.listBtn.textContent = this.changes.length ? `Журнал · ${active}` : "Журнал";
    if (!this.drop.hidden) this.drawList();
  }

  toast(change: ChangeInfo): void {
    this.toastBox.innerHTML = `<span>Сохранено: ${escapeHtml(change.summary)}</span><button data-act="undo">Отменить</button>`;
    this.toastBox.hidden = false;
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => (this.toastBox.hidden = true), 8000);
  }

  private async step(kind: "undo" | "redo"): Promise<void> {
    const result = await send<ChangeInfo | null>("POST", `/api/clans/${this.actions.clanId()}/${kind}`);
    this.toastBox.hidden = true;
    if (!result.ok || !result.data) return;
    this.actions.changed(result.data.persons[0] ?? null);
    this.toastBox.innerHTML = `<span>${kind === "undo" ? "Отменено" : "Повторено"}: ${escapeHtml(result.data.summary)}</span>` +
      (kind === "undo" ? "" : '<button data-act="undo">Отменить</button>');
    this.toastBox.hidden = false;
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => (this.toastBox.hidden = true), 5000);
  }

  private async openList(): Promise<void> {
    await this.refresh();
    this.drop.hidden = false;
    this.drawList();
    const at = this.listBtn.getBoundingClientRect();
    this.drop.style.top = `${at.bottom + 6}px`;
    this.drop.style.left = `${Math.max(8, Math.min(at.left, window.innerWidth - this.drop.offsetWidth - 8))}px`;
  }

  private closeList(): void {
    this.drop.hidden = true;
  }

  private drawList(): void {
    if (!this.changes.length) {
      this.drop.innerHTML = '<div class="empty2">Правок пока нет.</div>';
      return;
    }
    let h = `<div class="head2"><span>Все правки рода · ${this.changes.length}</span>` +
      (this.changes.some((c) => c.undone) ? `<button data-redo>${icon("redo", true)}Повторить</button>` : "") + "</div>";
    let last = "";
    for (const change of this.changes) {
      const d = day(change.created_at);
      if (d !== last) h += `<div class="day">${d}</div>`;
      last = d;
      h += `<div class="e${change.undone ? " undone" : ""}" data-change="${change.id}"><time>${time(change.created_at)}</time>` +
        `<span data-goto="${change.persons[0] ?? ""}">${escapeHtml(change.summary)}` +
        (change.author ? `<i class="who">${escapeHtml(change.author)}</i>` : "") + "</span>" +
        (change.undone ? "" : `<button data-undo-to="${change.id}" title="Отменить эту правку и всё, что сделано после">отменить до сюда</button>`) +
        "</div>";
    }
    this.drop.innerHTML = h;
  }

  private async onDrop(e: MouseEvent): Promise<void> {
    const target = e.target as HTMLElement;
    const to = target.closest<HTMLElement>("[data-undo-to]");
    if (to) {
      const result = await send<ChangeInfo[]>("POST", `/api/changes/${to.dataset.undoTo}/undo-to`);
      if (result.ok) this.actions.changed(result.data.at(-1)?.persons[0] ?? null);
      return;
    }
    if (target.closest("[data-redo]")) return void this.step("redo");
    const person = target.closest<HTMLElement>("[data-goto]")?.dataset.goto;
    if (person) {
      this.closeList();
      this.actions.goTo(Number(person));
    }
  }
}

// ── история одной карточки ──

export async function historyHtml(personId: number): Promise<string> {
  const result = await send<ChangeInfo[]>("GET", `/api/persons/${personId}/changes`);
  const changes = result.ok ? result.data : [];
  if (!changes.length) return '<div class="note">Правок у этого человека пока нет — только то, что пришло из файла.</div>';
  let h = "";
  let last = "";
  for (const change of changes) {
    const d = day(change.created_at);
    if (d !== last) h += `<div class="day">${d}</div>`;
    last = d;
    h += `<div class="e"><time>${time(change.created_at)}</time><span>${escapeHtml(change.summary)}` +
      (change.author ? `<i class="who">${escapeHtml(change.author)}</i>` : "") + "</span>" +
      `<button data-revert="${change.id}">вернуть</button></div>`;
  }
  return h + '<div class="parse">«Вернуть» ставит прежнее значение новой правкой — она тоже попадёт в общий журнал.</div>' +
    '<div class="err" data-role="err"></div>';
}

export async function revertChange(changeId: number): Promise<{ ok: true; change: ChangeInfo } | { ok: false; detail: string }> {
  const result = await send<ChangeInfo>("POST", `/api/changes/${changeId}/revert`);
  return result.ok ? { ok: true, change: result.data } : { ok: false, detail: result.detail };
}
