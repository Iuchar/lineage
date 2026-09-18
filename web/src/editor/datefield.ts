// Поле даты: пишешь как говоришь, под полем — как поняло. Разбор один — на сервере, как и при сохранении.

import type { ParsedDate } from "../api/types";
import { escapeHtml } from "../format";
import { send } from "./api";

export function dateFieldHtml(role: string, value: string, placeholder: string): string {
  return `<input class="field" data-date="${role}" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}">` +
    `<div class="parse" data-parse="${role}"></div>`;
}

// оживить поля дат внутри host: подсказка на лету, с небольшой задержкой после набора
export function bindDateFields(host: HTMLElement): void {
  for (const input of host.querySelectorAll<HTMLInputElement>("input[data-date]")) {
    const hint = host.querySelector<HTMLElement>(`[data-parse="${input.dataset.date}"]`);
    if (!hint) continue;
    let timer = 0;
    let asked = 0;
    const check = async () => {
      const ticket = ++asked;
      const text = input.value.trim();
      if (!text) {
        hint.className = "parse";
        hint.textContent = "не указана";
        return;
      }
      const result = await send<ParsedDate>("GET", `/api/dates/parse?text=${encodeURIComponent(text)}`);
      if (ticket !== asked) return; // пришёл ответ на старый ввод
      if (result.ok) {
        hint.className = "parse";
        hint.innerHTML = `понял: <b>${escapeHtml(result.data.ru)}</b> · в файл: ${escapeHtml(result.data.gedcom ?? "—")}`;
        input.classList.remove("bad");
      } else {
        hint.className = "parse err";
        hint.innerHTML = `<b>${escapeHtml(result.detail)}</b> — не сохранится`;
        input.classList.add("bad");
      }
    };
    input.addEventListener("input", () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void check(), 220);
    });
    void check();
  }
}
