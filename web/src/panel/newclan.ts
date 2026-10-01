// Новая родословная с нуля: имя рода, титул и первый человек. Остальных добавляют плюсами на карте.

import type { ClanSummary } from "../api/types";
import { STATUS_NAMES } from "../canvas/status";
import { send } from "../editor/api";
import { escapeHtml } from "../format";
import { holdDialog, type DialogHold } from "./dialog";

export class NewClan {
  readonly element: HTMLElement;
  private hold: DialogHold | null = null;

  constructor(host: HTMLElement, private readonly created: (clan: ClanSummary) => void) {
    this.element = document.createElement("div");
    this.element.className = "gate";
    this.element.hidden = true;
    this.element.addEventListener("click", (e) => {
      if (e.target === this.element) this.close();
    });
    this.element.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.close();
    });
    host.append(this.element);
  }

  open(): void {
    this.hold = holdDialog(this.element, "Новая родословная");
    this.element.hidden = false;
    this.element.innerHTML =
      '<form class="gateBox wide">' +
      "<b>Новая родословная</b><p>Род начинается с первого человека — остальных добавите плюсами на карте.</p>" +
      '<label><span>имя рода</span><input name="name" autocomplete="off" required></label>' +
      `<label><span>титул</span><select name="status">${Object.entries(STATUS_NAMES).map(([key, title]) =>
        `<option value="${key}"${key === "plain" ? " selected" : ""}>${escapeHtml(title)}</option>`).join("")}</select></label>` +
      '<div class="gateRule"></div><span class="gateLbl">первый человек</span>' +
      '<div class="gateTwo"><label><span>имя</span><input name="given" autocomplete="off"></label>' +
      '<label><span>фамилия</span><input name="surname" autocomplete="off"></label></div>' +
      '<div class="gateTwo"><div class="sw gateSex" role="group" aria-label="Пол">' +
      '<button type="button" data-sex="M" aria-pressed="true">мужчина</button>' +
      '<button type="button" data-sex="F" aria-pressed="false">женщина</button></div>' +
      '<label><span>год рождения</span><input name="birth" autocomplete="off" placeholder="1748 или «около 1750»"></label></div>' +
      '<div class="gateNo" role="alert" hidden></div>' +
      '<div class="gateRow"><button type="submit" class="gateGo">Создать</button>' +
      '<button type="button" class="gateOff">Отмена</button></div></form>';
    const form = this.element.querySelector("form")!;
    let sex = "M";
    form.querySelector(".gateSex")!.addEventListener("click", (e) => {
      const button = (e.target as HTMLElement).closest<HTMLElement>("[data-sex]");
      if (!button) return;
      sex = button.dataset.sex ?? "M";
      form.querySelectorAll("[data-sex]").forEach((b) => b.setAttribute("aria-pressed", String(b === button)));
    });
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      void this.create(form, sex);
    });
    form.querySelector(".gateOff")!.addEventListener("click", () => this.close());
    form.querySelector<HTMLInputElement>("[name=name]")?.focus();
  }

  close(): void {
    this.element.hidden = true;
    this.element.innerHTML = "";
    this.hold?.release();
    this.hold = null;
  }

  private async create(form: HTMLFormElement, sex: string): Promise<void> {
    const data = new FormData(form);
    const text = (key: string) => String(data.get(key) ?? "").trim();
    const no = form.querySelector<HTMLElement>(".gateNo")!;
    const result = await send<ClanSummary>("POST", "/api/clans", {
      name: text("name"),
      status: text("status") || "plain",
      person: { given: text("given"), surname: text("surname"), sex, birth: text("birth") },
    });
    if (!result.ok) {
      no.hidden = false;
      no.textContent = result.detail;
      return;
    }
    this.close();
    this.created(result.data);
  }
}
