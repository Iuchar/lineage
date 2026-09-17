// Загрузка .ged: выбор файла → лист «куда залить» над картой → новый род сразу, перезалив — через разбор на карте.
// Разбор показывает род уже из нового файла с метками, справа сводка. Ничего не пишется в базу до «Применить».

import type { ClanSummary, PersonBrief, ReloadPreview, ReloadReport, UploadInfo } from "../api/types";
import type { ReviewMark } from "../canvas/cards";
import { escapeHtml } from "../format";

export interface UploadActions {
  // новый род создан — открыть его
  created: (clan: ClanSummary) => void;
  // разбор готов — показать дерево из нового файла с метками
  review: (preview: ReloadPreview, marks: Map<number, ReviewMark>) => void;
  // перезалив применён или отменён — вернуть обычную карту рода
  finished: (clanId: number, report: ReloadReport | null) => void;
  // щелчок по строке сводки
  focus: (personId: number) => void;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { detail?: unknown } | null;
    throw new Error(typeof body?.detail === "string" ? body.detail : `${response.status}`);
  }
  return (await response.json()) as T;
}

const esc = (text: string) => escapeHtml(text);
// сервер пишет ошибки со строчной буквы, как в командной строке
const sentence = (text: string) => text.charAt(0).toLocaleUpperCase("ru") + text.slice(1);

export class UploadFlow {
  private readonly input: HTMLInputElement;
  private readonly sheet: HTMLElement;
  readonly summary: HTMLElement; // панель сводки на месте панели человека
  private info: UploadInfo | null = null;
  private preview: ReloadPreview | null = null;
  private remove = new Set<number>(); // пропавшие, которых редактор решил удалить
  private active: number | null = null;

  constructor(
    stage: HTMLElement,
    private readonly actions: UploadActions,
  ) {
    this.input = document.createElement("input");
    this.input.type = "file";
    this.input.accept = ".ged";
    this.input.hidden = true;
    this.input.addEventListener("change", () => void this.read());

    this.sheet = document.createElement("div");
    this.sheet.className = "sheetWrap";
    this.sheet.hidden = true;
    this.sheet.addEventListener("click", (e) => this.onSheetClick(e));
    this.sheet.addEventListener("change", () => this.syncTarget());

    this.summary = document.createElement("aside");
    this.summary.className = "side";
    this.summary.hidden = true;
    this.summary.addEventListener("click", (e) => this.onSummaryClick(e));

    stage.append(this.input, this.sheet, this.summary);
  }

  get reviewing(): boolean {
    return this.preview !== null;
  }

  choose(): void {
    this.input.value = "";
    this.input.click();
  }

  // уйти из разбора без записи; при переключении рода возвращаться к прежнему не нужно
  cancel(returnToClan = true): void {
    const clanId = this.preview?.clan_id;
    this.close();
    if (clanId != null && returnToClan) this.actions.finished(clanId, null);
  }

  // выделить строку сводки, когда человек выбран на карте
  highlight(personId: number | null): void {
    this.active = personId;
    if (this.preview) this.drawSummary();
  }

  private async read(): Promise<void> {
    const file = this.input.files?.[0];
    if (!file) return;
    this.openSheet(`<div class="up"><h3>Загрузка файла</h3><div class="file">${esc(file.name)} · читается…</div></div>`);
    try {
      this.info = await request<UploadInfo>(`/api/uploads?file_name=${encodeURIComponent(file.name)}`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: file,
      });
      this.drawTarget();
    } catch (error) {
      this.openSheet(
        `<div class="up"><h3>Загрузка файла</h3><div class="file">${esc(file.name)}</div>` +
          `<div class="err">${esc(sentence((error as Error).message))}</div>` +
          '<div class="acts"><button data-act="close">Закрыть</button></div></div>',
      );
    }
  }

  private openSheet(html: string): void {
    this.sheet.innerHTML = `<div class="sheet">${html}</div>`;
    this.sheet.hidden = false;
  }

  private drawTarget(error = ""): void {
    const info = this.info!;
    // после ошибки форма рисуется заново с тем, что уже выбрано
    const was = error ? this.readTarget() : null;
    const best = [...info.clans].sort((a, b) => b.matched - a.matched)[0];
    const reload = was ? was.reload : best !== undefined && best.matched > 0;
    const chosen = was?.clan ?? best?.id;
    const options = info.clans
      .map((c) => `<option value="${c.id}"${c.id === chosen ? " selected" : ""}>${esc(c.name)} · ${c.persons}</option>`)
      .join("");
    const hint = best !== undefined && best.matched > 0
      ? `Свои узнаются по идентификаторам из файла. Совпало ${best.matched} из ${info.persons} — больше всего с ${esc(best.name)}.`
      : "Свои узнаются по идентификаторам из файла. С уже загруженными родами файл не совпал ни разу.";
    const choice = (value: string, checked: boolean, title: string, text: string, field: string) =>
      `<label class="choice"><input type="radio" name="target" value="${value}"${checked ? " checked" : ""}>` +
      `<span><b>${title}</b><small>${text}</small>${field}</span></label>`;

    this.openSheet(
      `<div class="up"><h3>Загрузка файла</h3>` +
        `<div class="file">${esc(info.file_name)} · ${info.persons} человек · ${info.families} семей</div>` +
        (info.warnings.length ? `<div class="note">В файле ${info.warnings.length} битых ссылок — они пропускаются.</div>` : "") +
        '<div class="lbl">Куда</div>' +
        choice("new", !reload, "Новый род", "Отдельное дерево со своей вкладкой.",
          `<input class="field" name="name" value="${esc(was?.name ?? info.suggested_name)}">`) +
        (info.clans.length
          ? choice("reload", reload, "Перезалить в существующий", hint, `<select class="field" name="clan">${options}</select>`)
          : "") +
        (error ? `<div class="err">${esc(sentence(error))}</div>` : "") +
        '<div class="acts"><button data-act="close">Отмена</button><button class="pri" data-act="go"></button></div></div>',
    );
    this.syncTarget();
  }

  private readTarget(): { reload: boolean; name: string; clan: number | null } {
    const clan = this.sheet.querySelector<HTMLSelectElement>('select[name="clan"]');
    return {
      reload: this.sheet.querySelector<HTMLInputElement>('input[value="reload"]')?.checked ?? false,
      name: this.sheet.querySelector<HTMLInputElement>('input[name="name"]')?.value ?? "",
      clan: clan ? Number(clan.value) : null,
    };
  }

  // поле неактивного пункта гаснет, кнопка называет действие
  private syncTarget(): void {
    const reload = this.sheet.querySelector<HTMLInputElement>('input[value="reload"]')?.checked ?? false;
    const name = this.sheet.querySelector<HTMLInputElement>('input[name="name"]');
    const clan = this.sheet.querySelector<HTMLSelectElement>('select[name="clan"]');
    if (name) name.disabled = reload;
    if (clan) clan.disabled = !reload;
    const go = this.sheet.querySelector<HTMLButtonElement>('[data-act="go"]');
    if (go) go.textContent = reload ? "Разобрать" : "Создать род";
  }

  private onSheetClick(e: Event): void {
    const act = (e.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act;
    if (act === "close") this.close();
    if (act === "go") void this.go();
  }

  private async go(): Promise<void> {
    const info = this.info;
    if (!info) return;
    const reload = this.sheet.querySelector<HTMLInputElement>('input[value="reload"]')?.checked ?? false;
    const go = this.sheet.querySelector<HTMLButtonElement>('[data-act="go"]');
    if (go) go.disabled = true;
    try {
      if (reload) {
        const clanId = Number(this.sheet.querySelector<HTMLSelectElement>('select[name="clan"]')!.value);
        const preview = await request<ReloadPreview>(`/api/uploads/${info.token}/reload/${clanId}`);
        this.sheet.hidden = true;
        this.startReview(preview);
      } else {
        const name = this.sheet.querySelector<HTMLInputElement>('input[name="name"]')!.value;
        const clan = await request<ClanSummary>(`/api/uploads/${info.token}/clan`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        });
        this.close();
        this.actions.created(clan);
      }
    } catch (error) {
      this.drawTarget((error as Error).message);
    }
  }

  private startReview(preview: ReloadPreview): void {
    this.preview = preview;
    this.remove.clear();
    this.active = null;
    const marks = new Map<number, ReviewMark>();
    for (const p of preview.added) marks.set(p.id, "new");
    for (const p of preview.changed) marks.set(p.id, "mod");
    for (const p of preview.missing) marks.set(p.id, "gone");
    this.summary.hidden = false;
    this.drawSummary();
    this.actions.review(preview, marks);
  }

  private drawSummary(): void {
    const p = this.preview!;
    const row = (id: number, name: string, body: string) =>
      `<div class="item go${this.active === id ? " on" : ""}" data-id="${id}"><b>${esc(name)}</b>${body}</div>`;
    const brief = (b: PersonBrief) => `<small>${esc([b.years, b.where].filter(Boolean).join(" · "))}</small>`;
    const section = (title: string, count: number, rows: string) =>
      count ? `<div class="lbl">${title} · ${count}</div>${rows}` : "";

    const added = section("Добавлено", p.added.length, p.added.map((b) => row(b.id, b.name, brief(b))).join(""));
    const changed = section(
      "Изменено",
      p.changed.length,
      p.changed
        .map((c) =>
          row(c.id, c.name, c.changes
            .map((f) => `<span class="diff">${esc(f.label)}: ${f.was ? `<s>${esc(f.was)}</s> → ` : ""}${esc(f.now)}</span>`)
            .join("")),
        )
        .join(""),
    );
    const missing = p.missing.length
      ? section(
          "Нет в файле",
          p.missing.length,
          p.missing
            .map((b) => {
              const gone = this.remove.has(b.id);
              return row(b.id, b.name, brief(b) +
                `<div class="keep"><button data-keep="${b.id}" aria-pressed="${!gone}">Оставить</button>` +
                `<button data-remove="${b.id}" aria-pressed="${gone}">Удалить</button></div>`);
            })
            .join(""),
        ) + '<div class="note">Ничего не удаляется молча: без нажатия «Удалить» человек остаётся в роду.</div>'
      : "";
    const nothing = !p.added.length && !p.changed.length && !p.missing.length
      ? '<div class="note">Файл совпадает с родом — менять нечего.</div>'
      : "";

    this.summary.innerHTML =
      `<div class="sideIn up"><h3>Перезалив · ${esc(p.clan_name)}</h3>` +
      `<div class="file">${esc(this.info?.file_name ?? "")} · совпало ${p.matched} из ${p.total}</div>` +
      added + changed + missing + nothing +
      '<div class="acts"><button data-act="cancel">Отмена</button><button class="pri" data-act="apply">Применить</button></div></div>';
  }

  private onSummaryClick(e: Event): void {
    const target = e.target as HTMLElement;
    const button = target.closest<HTMLButtonElement>("button");
    if (button?.dataset.keep) {
      this.remove.delete(Number(button.dataset.keep));
      return this.drawSummary();
    }
    if (button?.dataset.remove) {
      this.remove.add(Number(button.dataset.remove));
      return this.drawSummary();
    }
    if (button?.dataset.act === "cancel") return this.cancel();
    if (button?.dataset.act === "apply") return void this.apply(button);
    const item = target.closest<HTMLElement>(".item.go");
    if (item?.dataset.id) {
      this.active = Number(item.dataset.id);
      this.drawSummary();
      this.actions.focus(this.active);
    }
  }

  private async apply(button: HTMLButtonElement): Promise<void> {
    const p = this.preview;
    const info = this.info;
    if (!p || !info) return;
    button.disabled = true;
    try {
      const report = await request<ReloadReport>(`/api/uploads/${info.token}/reload/${p.clan_id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ delete: [...this.remove] }),
      });
      this.close();
      this.actions.finished(p.clan_id, report);
    } catch (error) {
      button.disabled = false;
      this.summary.querySelector(".acts")?.insertAdjacentHTML("beforebegin", `<div class="err">${esc(sentence((error as Error).message))}</div>`);
    }
  }

  private close(): void {
    this.sheet.hidden = true;
    this.sheet.innerHTML = "";
    this.summary.hidden = true;
    this.summary.innerHTML = "";
    this.preview = null;
    this.info = null;
    this.remove.clear();
    this.active = null;
  }
}
