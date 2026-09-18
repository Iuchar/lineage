// Форма правки в панели человека (вариант В2): «Править» превращает панель в форму со всеми полями,
// «Сохранить» пишет всё разом одной записью журнала, «Отмена» возвращает как было.
// Та же форма создаёт нового человека — уже привязанного к тем, кого выбрали у плюса на карте.

import type { ChangeInfo, ClanTree, Created, DeletePreview, PersonFields, PersonForm, Relation, TreePerson } from "../api/types";
import { escapeHtml, lifeYears } from "../format";
import { TAG_COLORS, type TagColor } from "../canvas/tags";
import { silhouette } from "../canvas/portrait";
import { send } from "./api";
import { bindDateFields, dateFieldHtml } from "./datefield";

export interface FormActions {
  saved: (change: ChangeInfo, focus: number | null) => void; // правка записана: перечитать род, показать «Отменить»
  closed: () => void; // вернуться к обычной панели
}

export interface NewPersonPlan {
  relation: Relation;
  bind: string; // «сын Мурдо Гленн Уриск и Аины Драммонд»
  sex: "M" | "F" | "U" | null;
  surname: string | null; // по отцу, если он известен
  pedigree: boolean; // спросить тип родства — для детей
}

const SEXES: [string, string][] = [["M", "мужской"], ["F", "женский"], ["U", "неизвестен"]];
const PORTRAITS: [string, string][] = [["auto", "портрет"], ["silhouette", "заглушка"], ["none", "без портрета"]];
const PEDIGREES: [string, string][] = [["birth", "родной"], ["adopted", "приёмный"], ["foster", "под опекой"]];

const seg = (name: string, options: [string, string][], current: string | null) =>
  `<div class="seg" data-seg="${name}">${options.map(([v, t]) =>
    `<button type="button" data-v="${v}"${v === current ? ' class="on"' : ""}>${t}</button>`).join("")}</div>`;

export class PersonEditor {
  private tree: ClanTree | null = null;
  private newTags = new Map<string, TagColor>(); // метки, которых ещё нет в наборе рода

  constructor(private readonly host: HTMLElement, private readonly actions: FormActions) {}

  // ── правка записанного ──
  async edit(tree: ClanTree, personId: number): Promise<void> {
    this.tree = tree;
    const result = await send<PersonForm>("GET", `/api/persons/${personId}/form`);
    if (!result.ok) return this.actions.closed();
    const form = result.data;
    const hasParents = (tree.persons.find((p) => p.id === personId)?.parent_families.length ?? 0) > 0;
    this.host.innerHTML =
      `<div class="sideIn form"><span class="lbl" style="margin-top:0">правка</span>` +
      `<h3>${escapeHtml([form.given, form.surname].filter(Boolean).join(" ") || "без имени")}</h3>` +
      this.portraitHtml(form, true) +
      this.fieldsHtml(form) + this.metaHtml(form, hasParents, true) +
      '<div class="err" data-role="err"></div>' +
      '<div class="btns"><button class="pri" data-act="save">Сохранить</button><button data-act="cancel">Отмена</button></div>' +
      '<button class="danger" data-act="delete">Удалить человека…</button></div>';
    this.bind();
    this.on("save", async () => {
      const saved = await send<ChangeInfo>("PUT", `/api/persons/${personId}`, this.read());
      if (!saved.ok) return this.error(saved.detail);
      this.actions.saved(saved.data, personId);
    });
    this.on("delete", () => void this.confirmDelete(personId));
    this.bindPhoto(personId);
    this.bindTagSet(form.clan_id, personId);
  }

  // ── новый человек на выбранном месте ──
  create(tree: ClanTree, clanId: number, plan: NewPersonPlan, startExisting = false): void {
    this.tree = tree;
    const blank: PersonForm = {
      id: 0, clan_id: clanId, given: null, surname: plan.surname, married_surname: null, sex: plan.sex,
      birth: { gedcom: null, ru: "", input: "" }, death: { gedcom: null, ru: "", input: "" }, notes: [],
      tags: [], burnt: false, hidden: false, heir: false, portrait: "auto", photo: null,
    };
    this.host.innerHTML =
      `<div class="sideIn form"><span class="lbl" style="margin-top:0">новый человек</span>` +
      `<div class="bind">${plan.bind}</div>` +
      seg("source", [["new", "новый человек"], ["existing", "выбрать из рода"]], "new") +
      `<div data-role="new">${this.portraitHtml(blank, false)}${this.fieldsHtml(blank)}` +
      this.metaHtml(blank, plan.relation.kind === "child" || plan.relation.kind === "sibling") +
      (plan.pedigree ? `<label class="fl">Родство с родителями</label>${seg("pedigree", PEDIGREES, "birth")}` : "") +
      `</div><div data-role="existing" hidden><input class="field" data-role="q" placeholder="имя или фамилия">` +
      `<div class="pickList" data-role="list"></div></div>` +
      '<div class="err" data-role="err"></div>' +
      '<div class="btns"><button class="pri" data-act="create">Создать</button><button data-act="cancel">Отмена</button></div></div>';
    this.bind();
    this.host.querySelector<HTMLInputElement>("[data-field=given]")?.focus();

    let picked: number | null = null;
    const list = this.host.querySelector<HTMLElement>("[data-role=list]")!;
    const query = this.host.querySelector<HTMLInputElement>("[data-role=q]")!;
    const drawList = () => {
      const words = query.value.toLowerCase().split(/\s+/).filter(Boolean);
      const anchor = plan.relation.person_id;
      const found = (this.tree?.persons ?? [])
        .filter((p) => !p.is_branch_stub && p.id !== anchor)
        .filter((p) => words.every((w) => `${p.given ?? ""} ${p.surname ?? ""}`.toLowerCase().includes(w)))
        .slice(0, 30);
      list.innerHTML = found.map((p: TreePerson) =>
        `<div class="item go${p.id === picked ? " on" : ""}" data-pick="${p.id}"><b>${escapeHtml([p.given, p.surname].filter(Boolean).join(" "))}</b>` +
        `<small>${escapeHtml(lifeYears(p))}</small></div>`).join("") || '<div class="note">Никого не нашлось.</div>';
    };
    query.addEventListener("input", drawList);
    list.addEventListener("click", (e) => {
      const item = (e.target as HTMLElement).closest<HTMLElement>("[data-pick]");
      if (!item) return;
      picked = Number(item.dataset.pick);
      drawList();
    });
    this.onSeg("source", (value) => {
      this.host.querySelector<HTMLElement>("[data-role=new]")!.hidden = value !== "new";
      this.host.querySelector<HTMLElement>("[data-role=existing]")!.hidden = value !== "existing";
      this.host.querySelector<HTMLButtonElement>("[data-act=create]")!.textContent = value === "new" ? "Создать" : "Привязать";
      if (value === "existing") {
        drawList();
        query.focus();
      }
    });

    if (startExisting) this.host.querySelector<HTMLButtonElement>("[data-seg=source] [data-v=existing]")?.click();

    this.on("create", async () => {
      const existing = this.segValue("source") === "existing";
      if (existing && picked == null) return this.error("Выберите человека из списка");
      const relation: Relation = { ...plan.relation, pedigree: (this.segValue("pedigree") ?? "birth") as Relation["pedigree"] };
      const body = existing ? { relation, existing_id: picked } : { relation, fields: this.read() };
      const created = await send<Created>("POST", `/api/clans/${clanId}/persons`, body);
      if (!created.ok) return this.error(created.detail);
      this.actions.saved(created.data.change, created.data.person_id);
    });
  }

  // ── портрет: снимок, заглушка или без портрета; снимок грузится только уже записанному ──
  private portraitHtml(form: PersonForm, upload: boolean): string {
    // без снимка — та же заглушка-профиль, что на карточке
    const person = this.tree?.persons.find((p) => p.id === form.id);
    const img = form.photo ? `url('${form.photo}')` : person ? silhouette(person) : "none";
    return `<div class="porEd"><div class="por" style="background:${img} center / cover"></div><div class="porOpts">` +
      seg("portrait", PORTRAITS, form.portrait) +
      (upload
        ? `<div class="porBtns"><label class="chip">${form.photo ? "заменить снимок…" : "загрузить снимок…"}` +
          `<input type="file" accept="image/jpeg,image/png,image/webp,image/gif" data-role="photo" hidden></label>` +
          (form.photo ? '<button type="button" class="chip" data-act="unphoto">убрать снимок</button>' : "") + "</div>"
        : '<div class="parse">снимок можно загрузить после создания</div>') +
      "</div></div>";
  }

  private bindPhoto(personId: number): void {
    const input = this.host.querySelector<HTMLInputElement>("[data-role=photo]");
    input?.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) return;
      const response = await fetch(`/api/persons/${personId}/photo`, { method: "POST", body: file, headers: { "Content-Type": file.type } });
      const body = (await response.json().catch(() => ({}))) as ChangeInfo & { detail?: string };
      if (!response.ok) return this.error(body.detail ?? "Снимок не загрузился");
      this.actions.saved(body, personId);
    });
    this.on("unphoto", async () => {
      const result = await send<ChangeInfo>("DELETE", `/api/persons/${personId}/photo`);
      if (!result.ok) return this.error(result.detail);
      this.actions.saved(result.data, personId);
    });
  }

  // ── метки, состояния, главная линия ──
  private metaHtml(form: PersonForm, hasParents: boolean, manage = false): string {
    this.newTags.clear();
    const known = this.tree?.tags ?? [];
    const chip = (name: string, color: string, on: boolean) =>
      `<button type="button" class="tagChip${on ? " on" : ""}" data-tag="${escapeHtml(name)}" style="--c:${TAG_COLORS[color as TagColor] ?? "#888"}">` +
      `<i></i>${escapeHtml(name)}</button>`;
    const flag = (name: string, label: string, on: boolean, note: string) =>
      `<label class="flag"><input type="checkbox" data-flag="${name}"${on ? " checked" : ""}><span>${label}<i>${note}</i></span></label>`;
    return `<label class="fl">Метки</label><div class="tagChips" data-role="tags">` +
      known.map((t) => chip(t.name, t.color, form.tags.includes(t.name))).join("") +
      form.tags.filter((t) => !known.some((k) => k.name === t)).map((t) => chip(t, "дымный", true)).join("") +
      '<button type="button" class="chip" data-act="newtag">+ новая метка</button>' +
      (manage && known.length ? '<button type="button" class="chip quiet" data-act="tagset">набор меток…</button>' : "") +
      "</div>" + (manage ? '<div class="tagSet" data-role="tagset" hidden></div>' : "") +
      '<div class="newTag" data-role="newtag" hidden><input class="field" data-role="tagname" placeholder="название метки">' +
      `<div class="swatches">${Object.entries(TAG_COLORS).map(([name, hex], i) =>
        `<button type="button" data-color="${name}" title="${name}" style="--c:${hex}"${i === 0 ? ' class="on"' : ""}></button>`).join("")}</div>` +
      '<button type="button" class="chip" data-act="addtag">добавить</button></div>' +
      '<label class="fl">Состояние</label>' +
      flag("burnt", "выжжен из рода", form.burnt, "знак на карточке") +
      flag("hidden", "скрыт от зрителей", form.hidden, "редактор видит с пометкой") +
      (hasParents ? '<label class="fl">Главная линия</label>' +
        flag("heir", "продолжатель главной линии", form.heir, "пара родителей встанет над ним прямым стволом") : "");
  }

  private bindMeta(): void {
    const box = this.host.querySelector<HTMLElement>("[data-role=newtag]");
    this.host.querySelector("[data-role=tags]")?.addEventListener("click", (e) => {
      const chip = (e.target as HTMLElement).closest<HTMLElement>("[data-tag]");
      if (chip) chip.classList.toggle("on");
    });
    this.on("newtag", () => {
      if (!box) return;
      box.hidden = !box.hidden;
      box.querySelector<HTMLInputElement>("[data-role=tagname]")?.focus();
    });
    box?.querySelector(".swatches")?.addEventListener("click", (e) => {
      const swatch = (e.target as HTMLElement).closest<HTMLElement>("[data-color]");
      if (!swatch) return;
      box.querySelectorAll("[data-color]").forEach((b) => b.classList.toggle("on", b === swatch));
    });
    this.on("addtag", () => {
      const name = box?.querySelector<HTMLInputElement>("[data-role=tagname]")?.value.trim();
      const color = (box?.querySelector<HTMLElement>("[data-color].on")?.dataset.color ?? "синий") as TagColor;
      if (!name || !box) return;
      const exists = this.host.querySelector<HTMLElement>(`[data-tag="${CSS.escape(name)}"]`);
      if (exists) exists.classList.add("on");
      else {
        this.newTags.set(name, color);
        box.previousElementSibling?.querySelector("[data-act=newtag]")?.insertAdjacentHTML("beforebegin",
          `<button type="button" class="tagChip on" data-tag="${escapeHtml(name)}" style="--c:${TAG_COLORS[color]}"><i></i>${escapeHtml(name)}</button>`);
      }
      box.hidden = true;
      box.querySelector<HTMLInputElement>("[data-role=tagname]")!.value = "";
    });
  }

  // ── набор меток рода: переименовать, перекрасить, удалить — каждое действие одной правкой журнала ──
  private bindTagSet(clanId: number, personId: number): void {
    const box = this.host.querySelector<HTMLElement>("[data-role=tagset]");
    if (!box) return;
    const url = (name: string) => `/api/clans/${clanId}/tags/${encodeURIComponent(name)}`;
    const swatches = (current: string) => `<div class="swatches">${Object.entries(TAG_COLORS).map(([name, hex]) =>
      `<button type="button" data-color="${name}" title="${name}" style="--c:${hex}"${name === current ? ' class="on"' : ""}></button>`).join("")}</div>`;
    const draw = () => {
      box.innerHTML = (this.tree?.tags ?? []).map((t) =>
        `<div class="tagRow" data-name="${escapeHtml(t.name)}"><i style="--c:${TAG_COLORS[t.color as TagColor] ?? "#888"}"></i>` +
        `<span>${escapeHtml(t.name)}</span><button type="button" data-tag-act="edit">изменить</button>` +
        `<button type="button" data-tag-act="drop">удалить</button></div>`).join("") ||
        '<div class="note">В наборе рода меток нет.</div>';
    };
    this.on("tagset", () => {
      box.hidden = !box.hidden;
      draw();
    });
    box.addEventListener("click", async (e) => {
      const target = e.target as HTMLElement;
      const row = target.closest<HTMLElement>(".tagRow");
      const name = row?.dataset.name;
      if (!row || !name) return;
      const swatch = target.closest<HTMLElement>("[data-color]");
      if (swatch) {
        row.querySelectorAll("[data-color]").forEach((b) => b.classList.toggle("on", b === swatch));
        return;
      }
      const act = target.closest<HTMLElement>("[data-tag-act]")?.dataset.tagAct;
      const tag = this.tree?.tags.find((t) => t.name === name);
      if (act === "edit" && tag) {
        row.innerHTML = `<input class="field" data-role="rename" value="${escapeHtml(name)}">${swatches(tag.color)}` +
          '<button type="button" data-tag-act="save">сохранить</button><button type="button" data-tag-act="back">отмена</button>';
        row.querySelector<HTMLInputElement>("[data-role=rename]")?.select();
      } else if (act === "save") {
        const newName = row.querySelector<HTMLInputElement>("[data-role=rename]")?.value.trim() ?? "";
        const color = row.querySelector<HTMLElement>("[data-color].on")?.dataset.color ?? tag?.color ?? "синий";
        const result = await send<ChangeInfo>("PUT", url(name), { name: newName, color });
        if (!result.ok) return this.error(result.detail);
        this.actions.saved(result.data, personId);
      } else if (act === "drop") {
        const usage = await send<number>("GET", `${url(name)}/usage`);
        const count = usage.ok ? usage.data : 0;
        row.innerHTML = `<span>Удалить «${escapeHtml(name)}»?${count ? ` Снимется с ${count} ${count % 10 === 1 && count % 100 !== 11 ? "человека" : "человек"}.` : " Ни на ком не стоит."}</span>` +
          '<button type="button" data-tag-act="really">удалить</button><button type="button" data-tag-act="back">отмена</button>';
      } else if (act === "really") {
        const result = await send<ChangeInfo>("DELETE", url(name));
        if (!result.ok) return this.error(result.detail);
        this.actions.saved(result.data, personId);
      } else if (act === "back") {
        draw();
      }
    });
  }

  // ── удаление: не молча, с числом затронутых ──
  private async confirmDelete(personId: number): Promise<void> {
    const result = await send<DeletePreview>("GET", `/api/persons/${personId}/delete-preview`);
    if (!result.ok) return this.error(result.detail);
    const p = result.data;
    const parts = [
      p.children ? `детей — ${p.children}` : "детей нет",
      p.descendants ? `в ветке ${p.descendants} потомков` : "",
      p.inlaws ? `${p.inlaws} их супругов, пришедших в род через брак` : "",
      p.stubs ? `${p.stubs} пометок «Ветвь»` : "",
    ].filter(Boolean);
    const branch = p.branch_total > 1;
    this.host.innerHTML =
      `<div class="sideIn"><div class="warn"><b>Удалить ${escapeHtml(p.name)}?</b><p>${parts.join(", ")}.</p>` +
      `<label class="opt"><input type="radio" name="del" value="one" checked><span>Только этого человека` +
      `<i>дети и супруги останутся в роду</i></span></label>` +
      (branch ? `<label class="opt"><input type="radio" name="del" value="branch"><span>Вместе с веткой` +
        `<i>уйдут ${p.branch_total} записей; связки с другими родами снимутся</i></span></label>` : "") +
      '<div class="err" data-role="err"></div>' +
      '<div class="btns"><button class="pri danger-fill" data-act="drop">Удалить</button><button data-act="cancel">Отмена</button></div>' +
      '<p class="hint2">Удаление пишется в журнал и откатывается, как любая правка.</p></div></div>';
    this.bind();
    this.on("drop", async () => {
      const withBranch = this.host.querySelector<HTMLInputElement>("input[name=del]:checked")?.value === "branch";
      const done = await send<ChangeInfo>("DELETE", `/api/persons/${personId}${withBranch ? "?branch=true" : ""}`);
      if (!done.ok) return this.error(done.detail);
      this.actions.saved(done.data, null);
    });
  }

  // ── поля ──
  private fieldsHtml(form: PersonForm): string {
    const notes = form.notes.length ? form.notes : [];
    return `<label class="fl">Имя</label><input class="field" data-field="given" value="${escapeHtml(form.given ?? "")}" placeholder="имя">` +
      `<div class="two"><div><label class="fl">Фамилия</label><input class="field" data-field="surname" value="${escapeHtml(form.surname ?? "")}"></div>` +
      `<div><label class="fl">По мужу</label><input class="field" data-field="married_surname" value="${escapeHtml(form.married_surname ?? "")}" placeholder="—"></div></div>` +
      `<label class="fl">Пол</label>${seg("sex", SEXES, form.sex)}` +
      // даты — по одной на строку: подсказка разбора помещается в строку и не двигает форму при наборе
      `<label class="fl">Рождение</label>${dateFieldHtml("birth", form.birth.input, "например, около 1785")}` +
      `<label class="fl">Смерть</label>${dateFieldHtml("death", form.death.input, "—")}` +
      `<label class="fl">Заметки</label><div data-role="notes">${notes.map((n) => this.noteHtml(n)).join("")}</div>` +
      '<button type="button" class="chip" data-act="note">+ заметка</button>';
  }

  private noteHtml(text: string): string {
    return `<div class="noteRow"><textarea class="field" rows="2" data-note>${escapeHtml(text)}</textarea>` +
      '<button type="button" class="x" data-act="unnote" title="Убрать заметку">×</button></div>';
  }

  private read(): PersonFields {
    const value = (name: string) => this.host.querySelector<HTMLInputElement>(`[data-field=${name}]`)?.value.trim() || null;
    const date = (name: string) => this.host.querySelector<HTMLInputElement>(`[data-date=${name}]`)?.value.trim() || null;
    return {
      given: value("given"), surname: value("surname"), married_surname: value("married_surname"),
      sex: (this.segValue("sex") ?? null) as PersonFields["sex"],
      birth: date("birth"), death: date("death"),
      notes: [...this.host.querySelectorAll<HTMLTextAreaElement>("[data-note]")].map((t) => t.value).filter((t) => t.trim()),
      tags: [...this.host.querySelectorAll<HTMLElement>("[data-tag].on")].map((c) => c.dataset.tag!),
      new_tags: Object.fromEntries(this.newTags),
      burnt: this.checked("burnt"), hidden: this.checked("hidden"), heir: this.checked("heir"),
      portrait: (this.segValue("portrait") ?? "auto") as PersonFields["portrait"],
    };
  }

  private checked(name: string): boolean {
    return this.host.querySelector<HTMLInputElement>(`[data-flag=${name}]`)?.checked ?? false;
  }

  private bind(): void {
    bindDateFields(this.host);
    this.bindMeta();
    this.host.querySelectorAll<HTMLElement>("[data-seg]").forEach((group) => {
      group.addEventListener("click", (e) => {
        const button = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-v]");
        if (!button) return;
        group.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b === button));
        group.dispatchEvent(new CustomEvent("pick", { detail: button.dataset.v }));
      });
    });
    this.on("cancel", () => this.actions.closed());
    this.on("note", () => {
      this.host.querySelector("[data-role=notes]")?.insertAdjacentHTML("beforeend", this.noteHtml(""));
      [...this.host.querySelectorAll<HTMLTextAreaElement>("[data-note]")].pop()?.focus();
    });
    this.host.addEventListener("click", (e) => {
      const x = (e.target as HTMLElement).closest("[data-act=unnote]");
      x?.closest(".noteRow")?.remove();
    });
  }

  private on(act: string, handler: () => void): void {
    this.host.querySelector(`[data-act=${act}]`)?.addEventListener("click", handler);
  }

  private onSeg(name: string, handler: (value: string) => void): void {
    this.host.querySelector(`[data-seg=${name}]`)?.addEventListener("pick", (e) => handler((e as CustomEvent<string>).detail));
  }

  private segValue(name: string): string | null {
    return this.host.querySelector<HTMLButtonElement>(`[data-seg=${name}] button.on`)?.dataset.v ?? null;
  }

  private error(text: string): void {
    const box = this.host.querySelector<HTMLElement>("[data-role=err]");
    if (box) box.textContent = text;
  }
}
