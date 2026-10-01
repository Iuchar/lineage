// Вход редактора: окно поверх карты, дерево за ним остаётся открытым. Зритель входа не видит —
// он приходит по ссылке, и пока в базе нет ни одного редактора, правка открыта всем.

import { holdDialog, type DialogHold } from "./dialog";
import { send } from "../editor/api";
import { escapeHtml } from "../format";

export interface Me {
  name: string | null; // кто вошёл
  guarded: boolean; // заведён ли хоть один редактор
  access?: { clan_id: number; until: string }[]; // роды, для которых гость свой по ссылке, и до какого дня
}

export async function whoami(): Promise<Me> {
  const result = await send<Me>("GET", "/api/me");
  return result.ok ? result.data : { name: null, guarded: false };
}

export class Gate {
  readonly element: HTMLElement;
  private onDone: (me: Me) => void = () => {};
  private hold: DialogHold | null = null;

  constructor(host: HTMLElement) {
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

  open(done: (me: Me) => void): void {
    this.onDone = done;
    this.hold = holdDialog(this.element, "Вход редактора");
    this.element.hidden = false;
    this.element.innerHTML =
      '<form class="gateBox">' +
      '<b>Вход редактора</b><p>Дерево останется открытым.</p>' +
      '<label><span>имя</span><input name="name" autocomplete="username" autofocus></label>' +
      '<label><span>пароль</span><input name="password" type="password" autocomplete="current-password"></label>' +
      '<div class="gateNo" role="alert" hidden></div>' +
      '<div class="gateRow"><button type="submit" class="gateGo">Войти</button>' +
      '<button type="button" class="gateOff">Отмена</button></div></form>';
    const form = this.element.querySelector("form")!;
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      void this.enter(form);
    });
    this.element.querySelector(".gateOff")!.addEventListener("click", () => this.close());
    this.element.querySelector<HTMLInputElement>("[name=name]")?.focus();
  }

  close(): void {
    this.element.hidden = true;
    this.element.innerHTML = "";
    this.hold?.release();
    this.hold = null;
  }

  private async enter(form: HTMLFormElement): Promise<void> {
    const data = new FormData(form);
    const no = this.element.querySelector<HTMLElement>(".gateNo")!;
    const result = await send<Me>("POST", "/api/login", {
      name: String(data.get("name") ?? ""),
      password: String(data.get("password") ?? ""),
    });
    if (!result.ok) {
      no.hidden = false;
      no.textContent = escapeHtml(result.detail);
      form.querySelector<HTMLInputElement>("[name=password]")?.focus();
      return;
    }
    this.close();
    this.onDone(result.data);
  }
}
