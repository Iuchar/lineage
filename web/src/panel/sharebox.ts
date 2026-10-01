// Ссылка зрителям на род: срок действия, адрес целиком, сколько раз открывали, «выпустить заново» и «отозвать».
// Ссылка не вечна: срок выбирается при выпуске и показан и редактору здесь, и гостю над картой.
// Открывается из строки дерева в столбце слева.

import { holdDialog, type DialogHold } from "./dialog";
import { send } from "../editor/api";
import { escapeHtml, untilText } from "../format";

export interface ShareInfo {
  url: string;
  created_at: string;
  opened: number;
  opened_at?: string | null;
  expires_at: string; // до какого момента ссылка открывается
}

// на сколько выпускается ссылка; бессрочной нет
const TERMS: [number, string][] = [[30, "30 дней"], [90, "90 дней"], [180, "полгода"], [365, "год"]];
const DEFAULT_TERM = 90;
const termPick = (): string =>
  `<label class="shareTerm"><span>срок действия</span><select data-term>${TERMS.map(([days, title]) =>
    `<option value="${days}"${days === DEFAULT_TERM ? " selected" : ""}>${title}</option>`).join("")}</select></label>`;

const when = (iso: string | null | undefined): string => {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString("ru", { day: "numeric", month: "long" });
};

const openedWord = (n: number): string => {
  if (!n) return "ещё не открывали";
  const last = n % 10;
  const teen = n % 100 >= 11 && n % 100 <= 14;
  const word = !teen && last === 1 ? "раз" : !teen && last >= 2 && last <= 4 ? "раза" : "раз";
  return `открывали ${n} ${word}`;
};

export class ShareBox {
  readonly element: HTMLElement;
  private clanId = 0;
  private name = "";
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

  async open(clanId: number, name: string): Promise<void> {
    this.clanId = clanId;
    this.name = name;
    this.hold = holdDialog(this.element, `Ссылка зрителям · ${name}`);
    this.element.hidden = false;
    this.element.innerHTML = '<div class="shareBox"><b>Ссылка зрителям</b><p>…</p></div>';
    const result = await send<ShareInfo | null>("GET", `/api/clans/${clanId}/link`);
    this.draw(result.ok ? result.data : null);
  }

  close(): void {
    this.element.hidden = true;
    this.element.innerHTML = "";
    this.hold?.release();
    this.hold = null;
  }

  private draw(link: ShareInfo | null): void {
    const head = `<b>Ссылка зрителям · ${escapeHtml(this.name)}</b>`;
    if (!link) {
      this.element.innerHTML = `<div class="shareBox">${head}` +
        '<p>Ссылки пока нет. Кто её откроет, станет своим для этого рода: увидит даты жизни и родовые заметки,' +
        ' а чужие роды — только общим слоем. Ссылка действует выбранный срок и потом гаснет сама.</p>' +
        `<div class="shareRow">${termPick()}<span class="shareGap"></span>` +
        '<button class="gateGo" data-do="issue">Выпустить ссылку</button>' +
        '<button class="gateOff" data-do="close">Закрыть</button></div></div>';
    } else {
      const expired = new Date(link.expires_at).getTime() <= Date.now();
      this.element.innerHTML = `<div class="shareBox">${head}` +
        `<div class="shareUrl"><code>${escapeHtml(link.url)}</code>` +
        '<button class="gateOff" data-do="copy">Копировать</button></div>' +
        `<div class="shareTill${expired ? " over" : ""}">${expired ? "Срок вышел — ссылка не открывается, " : "Действует "}` +
        `${untilText(link.expires_at)}</div>` +
        `<div class="shareWhen">выпущена ${when(link.created_at)} · ${openedWord(link.opened)}` +
        `${link.opened_at ? ` · последний раз ${when(link.opened_at)}` : ""}</div>` +
        '<p>Открывший ссылку становится своим для этого рода — до того же дня; эту дату он видит у себя над картой.' +
        ' «Выпустить заново» гасит старую ссылку, «Отозвать» закрывает род и для тех, кто уже приходил.</p>' +
        `<div class="shareRow">${termPick()}<button class="gateOff" data-do="issue">Выпустить заново</button></div>` +
        '<div class="shareRow"><span class="shareGap"></span>' +
        '<button class="gateOff shareOff" data-do="revoke">Отозвать</button>' +
        '<button class="gateGo" data-do="close">Готово</button></div></div>';
    }
    this.element.querySelectorAll<HTMLElement>("[data-do]").forEach((button) => {
      button.addEventListener("click", () => void this.act(button.dataset.do ?? "", link));
    });
  }

  private async act(what: string, link: ShareInfo | null): Promise<void> {
    if (what === "close") return this.close();
    if (what === "copy" && link) {
      await navigator.clipboard?.writeText(link.url).catch(() => {});
      const button = this.element.querySelector<HTMLElement>("[data-do=copy]");
      if (button) button.textContent = "Скопировано";
      return;
    }
    if (what === "issue") {
      const days = Number(this.element.querySelector<HTMLSelectElement>("[data-term]")?.value) || DEFAULT_TERM;
      const made = await send<ShareInfo>("POST", `/api/clans/${this.clanId}/link`, { days });
      return this.draw(made.ok ? made.data : link);
    }
    if (what === "revoke") {
      await send<unknown>("DELETE", `/api/clans/${this.clanId}/link`);
      return this.draw(null);
    }
  }
}
