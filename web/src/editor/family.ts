// Форма союза: венчание, развод, дети по порядку. Открывается «Править» в карточке союза;
// «Сохранить» пишет всё разом одной записью журнала. Запись семьи одна — её видят оба супруга.

import type { ChangeInfo, ClanTree, FamilyFields, FamilyForm, TreePerson } from "../api/types";
import { escapeHtml, lifeYears } from "../format";
import { send } from "./api";
import { bindDateFields, dateFieldHtml } from "./datefield";

export interface FamilyActions {
  saved: (change: ChangeInfo) => void;
  closed: () => void;
  addChild: (familyId: number, at: DOMRect) => void;
}

export class FamilyEditor {
  private order: number[] = [];
  private unlinked = new Set<number>();

  constructor(private readonly host: HTMLElement, private readonly actions: FamilyActions) {}

  async edit(tree: ClanTree, familyId: number): Promise<void> {
    const result = await send<FamilyForm>("GET", `/api/families/${familyId}/form`);
    if (!result.ok) return this.actions.closed();
    const form = result.data;
    const persons = new Map(tree.persons.map((p) => [p.id, p]));
    const names = [form.husband, form.wife].map((id) => (id != null ? persons.get(id)?.given : null)).filter(Boolean);
    this.order = form.children.map((c) => c.id);
    this.unlinked.clear();
    const pedigree = new Map(form.children.map((c) => [c.id, c.pedigree]));

    this.host.innerHTML =
      `<div class="sideIn form"><span class="lbl" style="margin-top:0">правка · союз ${escapeHtml(names.join(" и ") || "без родителей")}</span>` +
      `<label class="fl">Венчание</label>${dateFieldHtml("marriage", form.marriage.input, "например, около 1780")}` +
      `<label class="fl">Место венчания</label><input class="field" data-field="place" value="${escapeHtml(form.place ?? "")}" placeholder="—">` +
      '<label class="fl">Союз</label><div class="seg" data-seg="state">' +
      `<button type="button" data-v="married"${form.divorced ? "" : ' class="on"'}>в браке</button>` +
      `<button type="button" data-v="divorced"${form.divorced ? ' class="on"' : ""}>развод</button></div>` +
      `<div data-role="divorce"${form.divorced ? "" : " hidden"}><label class="fl">Дата развода</label>` +
      `${dateFieldHtml("divorce", form.divorce.input, "если известна")}</div>` +
      '<div class="note2">Разведённый союз на карте рисуется как прошлый брак.</div>' +
      (this.order.length ? '<label class="fl">Дети — по порядку</label><div class="kinList" data-role="kids"></div>' +
        '<div class="note2">Порядок уходит в файл. На карте братья и сёстры стоят по годам рождения — порядок решает у тех, чей год неизвестен.</div>' : "") +
      `<div class="addGrid" style="margin-top:8px"><button type="button" class="wide" data-act="child">` +
      (form.husband != null || form.wife != null ? "+ сын или дочь<small>в этот союз</small>" : "+ брат или сестра<small>в эту семью без родителей</small>") +
      "</button></div>" +
      '<div class="err" data-role="err"></div>' +
      '<div class="btns"><button class="pri" data-act="save">Сохранить</button><button data-act="cancel">Отмена</button></div></div>';

    const kids = this.host.querySelector<HTMLElement>("[data-role=kids]");
    const word = (p: TreePerson) => {
      const kind = pedigree.get(p.id) ?? "birth";
      if (kind === "foster") return "под опекой";
      const f = p.sex === "F";
      return kind === "adopted" ? (f ? "приёмная" : "приёмный") : f ? "родная" : "родной";
    };
    const draw = () => {
      if (!kids) return;
      let n = 0;
      kids.innerHTML = this.order.map((id, i) => {
        const p = persons.get(id);
        if (!p) return "";
        const off = this.unlinked.has(id);
        const name = escapeHtml([p.given, p.surname].filter(Boolean).join(" ") || "без имени");
        return `<div${off ? ' class="off"' : ""} data-kid="${id}"><b class="num">${off ? "" : ++n}</b>` +
          `<span>${name}<small>${escapeHtml(lifeYears(p))} · ${off ? "отвязать при сохранении" : word(p)}</small></span>` +
          (off ? '<button type="button" data-k="back" title="Вернуть">↺</button>'
            : `<button type="button" data-k="up" title="Выше"${i === 0 ? " disabled" : ""}>↑</button>` +
              `<button type="button" data-k="down" title="Ниже"${i === this.order.length - 1 ? " disabled" : ""}>↓</button>` +
              '<button type="button" data-k="drop" title="Отвязать от союза — человек останется в роду">×</button>') + "</div>";
      }).join("");
    };
    draw();
    kids?.addEventListener("click", (e) => {
      const button = (e.target as HTMLElement).closest<HTMLElement>("[data-k]");
      const id = Number(button?.closest<HTMLElement>("[data-kid]")?.dataset.kid);
      if (!button || !id) return;
      const at = this.order.indexOf(id);
      const k = button.dataset.k;
      if (k === "up" && at > 0) this.order.splice(at - 1, 2, id, this.order[at - 1]!);
      if (k === "down" && at < this.order.length - 1) this.order.splice(at, 2, this.order[at + 1]!, id);
      if (k === "drop") this.unlinked.add(id);
      if (k === "back") this.unlinked.delete(id);
      draw();
    });

    bindDateFields(this.host);
    const state = this.host.querySelector<HTMLElement>("[data-seg=state]")!;
    state.addEventListener("click", (e) => {
      const button = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-v]");
      if (!button) return;
      state.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b === button));
      this.host.querySelector<HTMLElement>("[data-role=divorce]")!.hidden = button.dataset.v !== "divorced";
    });
    this.on("cancel", () => this.actions.closed());
    this.on("child", (e) => this.actions.addChild(familyId, (e.currentTarget as HTMLElement).getBoundingClientRect()));
    this.on("save", async () => {
      const divorced = state.querySelector<HTMLElement>(".on")?.dataset.v === "divorced";
      const date = (role: string) => this.host.querySelector<HTMLInputElement>(`[data-date=${role}]`)?.value.trim() || null;
      const body: FamilyFields = {
        marriage: date("marriage"),
        place: this.host.querySelector<HTMLInputElement>("[data-field=place]")?.value.trim() || null,
        divorced,
        divorce: divorced ? date("divorce") : null,
        children: this.order.filter((id) => !this.unlinked.has(id)),
        unlink: [...this.unlinked],
      };
      const saved = await send<ChangeInfo>("PUT", `/api/families/${familyId}`, body);
      if (!saved.ok) return this.error(saved.detail);
      this.actions.saved(saved.data);
    });
  }

  private on(act: string, handler: (e: Event) => void): void {
    this.host.querySelector(`[data-act=${act}]`)?.addEventListener("click", handler);
  }

  private error(text: string): void {
    const box = this.host.querySelector<HTMLElement>("[data-role=err]");
    if (box) box.textContent = text;
  }
}
