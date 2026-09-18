// Раздел «Родня» в форме человека (Р2): родители и браки списком. У строки — «перенести…» или «заменить…» и ×.
// Крестик только помечает строку; всё применяется по «Сохранить» одной правкой журнала вместе с полями.
// Здесь же тип родства с каждой семьёй (П2) и очередь браков стрелками (О1).

import type { ClanTree, KinChanges, TreeFamily, TreePerson } from "../api/types";
import { escapeHtml, lifeYears } from "../format";
import { relativesOf } from "../panel/relatives";

const PEDIGREES: [string, string][] = [["birth", "родное"], ["adopted", "приёмное"], ["foster", "под опекой"]];

interface ParentState {
  action: "keep" | "drop" | "move";
  to: number | null;
  pedigree: string;
  was: string;
}

interface SpouseState {
  action: "keep" | "drop" | "replace";
  to: number | null;
}

export class KinSection {
  private parents = new Map<number, ParentState>();
  private spouses = new Map<number, SpouseState>();
  private order: number[] = [];
  private ruled: number[] = [];
  private auto = false;
  private picking: { kind: "parent" | "spouse"; family: number } | null = null;
  private host: HTMLElement | null = null;
  private readonly persons: Map<number, TreePerson>;
  private readonly families: Map<number, TreeFamily>;

  constructor(
    private readonly tree: ClanTree,
    private readonly personId: number,
    private readonly manual: boolean,
    private readonly addBirthParents: (at: DOMRect) => void,
  ) {
    this.persons = new Map(tree.persons.map((p) => [p.id, p]));
    this.families = new Map(tree.families.map((f) => [f.id, f]));
    const rel = relativesOf(tree, personId);
    for (const p of rel.parents) this.parents.set(p.family.id, { action: "keep", to: null, pedigree: p.pedigree, was: p.pedigree });
    for (const m of rel.marriages) this.spouses.set(m.family.id, { action: "keep", to: null });
    this.order = rel.marriages.map((m) => m.family.id);
    this.ruled = [...this.order];
  }

  html(): string {
    return '<label class="fl">Родители</label><div data-role="kinParents"></div>' +
      '<label class="fl">Браки</label><div data-role="kinSpouses"></div>' +
      '<div class="kinPick" data-role="kinPick" hidden><input class="field" data-role="kinQ" placeholder="имя или фамилия">' +
      '<div class="pickList" data-role="kinList"></div><button type="button" class="chip" data-kin="unpick">отмена</button></div>';
  }

  bind(host: HTMLElement): void {
    this.host = host;
    this.draw();
    host.querySelector("[data-role=kinParents]")?.addEventListener("click", (e) => this.onParent(e));
    host.querySelector("[data-role=kinSpouses]")?.addEventListener("click", (e) => this.onSpouse(e));
    host.querySelector("[data-role=kinQ]")?.addEventListener("input", () => this.drawPick());
    host.querySelector("[data-role=kinPick]")?.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      if (target.closest("[data-kin=unpick]")) return this.closePick();
      const item = target.closest<HTMLElement>("[data-pick]");
      if (!item || !this.picking) return;
      const id = Number(item.dataset.pick);
      if (this.picking.kind === "parent") this.parents.set(this.picking.family, { ...this.parents.get(this.picking.family)!, action: "move", to: id });
      else this.spouses.set(this.picking.family, { action: "replace", to: id });
      this.closePick();
    });
  }

  // что поменялось; ничего — null, и правка остаётся правкой полей
  read(): KinChanges | null {
    const parents = [...this.parents].filter(([, s]) => s.action !== "keep" || s.pedigree !== s.was)
      .map(([id, s]) => ({ family_id: id, action: s.action, to_family_id: s.to, pedigree: s.pedigree as "birth" | "adopted" | "foster" }));
    const spouses = [...this.spouses].filter(([, s]) => s.action !== "keep")
      .map(([id, s]) => ({ family_id: id, action: s.action, to_person_id: s.to }));
    // сервер сначала выводит из союзов, потом ставит очередь — очередь только тех, что остаются
    const kept = this.order.filter((id) => this.spouses.get(id)?.action === "keep");
    const reordered = !this.auto && this.order.join() !== this.ruled.join() && kept.length > 1;
    if (!parents.length && !spouses.length && !reordered && !this.auto) return null;
    return { parents, spouses, marriage_order: reordered ? kept : null, marriage_order_auto: this.auto };
  }

  // ── отрисовка ──
  private full(p: TreePerson | null | undefined): string {
    return p ? escapeHtml([p.given, p.surname].filter(Boolean).join(" ") || "без имени") : "";
  }

  private couple(family: TreeFamily | undefined): string {
    if (!family) return "";
    const names = [family.husband, family.wife].map((id) => (id != null ? this.persons.get(id)?.given : null)).filter(Boolean);
    return escapeHtml(names.join(" и ")) || "родители не записаны";
  }

  private draw(): void {
    const host = this.host;
    if (!host) return;
    const parentBox = host.querySelector<HTMLElement>("[data-role=kinParents]")!;
    const rel = relativesOf(this.tree, this.personId);
    const allFostered = rel.parents.length > 0 && rel.parents.every((p) => p.pedigree !== "birth");
    parentBox.innerHTML = rel.parents.length
      ? '<div class="kinList">' + rel.parents.map((p, i) => {
        const s = this.parents.get(p.family.id)!;
        const off = s.action === "drop";
        const where = rel.parents.length > 1 && i === 0 ? " · здесь стоит на карте" : "";
        const note = off ? "отвязать при сохранении"
          : s.action === "move" ? `перенести к: ${this.couple(this.families.get(s.to!))}` : `родство: ${PEDIGREES.find(([v]) => v === s.pedigree)?.[1] ?? ""}${where}`;
        return `<div class="${off ? "off" : s.action === "move" ? "moved" : ""}" data-par="${p.family.id}">` +
          `<span>${this.couple(p.family)}<small>${note}</small></span>` +
          (off || s.action === "move" ? '<button type="button" data-k="back" title="Вернуть как было">↺</button>'
            : '<button type="button" data-k="move">перенести…</button><button type="button" data-k="drop" title="Отвязать — человек останется в роду">×</button>') +
          (off || s.action === "move" ? "" : `<div class="seg mini" data-k="pedi">${PEDIGREES.map(([v, t]) =>
            `<button type="button" data-v="${v}"${v === s.pedigree ? ' class="on"' : ""}>${t}</button>`).join("")}</div>`) +
          "</div>";
      }).join("") + "</div>"
      : '<div class="note2">не записаны — добавьте плюсом на карте</div>';
    if (allFostered) parentBox.insertAdjacentHTML("beforeend",
      '<button type="button" class="chip" data-k="birth">+ записать родных…</button>');

    const spouseBox = host.querySelector<HTMLElement>("[data-role=kinSpouses]")!;
    const many = this.order.length > 1;
    spouseBox.innerHTML = this.order.length
      ? '<div class="kinList">' + this.order.map((id, i) => {
        const family = this.families.get(id)!;
        const other = this.persons.get((family.husband === this.personId ? family.wife : family.husband) ?? -1);
        const s = this.spouses.get(id)!;
        const off = s.action === "drop";
        const kids = family.children.length;
        const note = off ? "выйти из союза при сохранении" : s.action === "replace" ? `заменить на: ${this.full(this.persons.get(s.to!))}`
          : `${other ? escapeHtml(lifeYears(other)) : "супруг не записан"} · ${kids ? `детей: ${kids}` : "детей нет"}`;
        return `<div class="${off ? "off" : s.action === "replace" ? "moved" : ""}" data-sp="${id}">` +
          (many ? `<b class="num">${i + 1}</b>` : "") +
          `<span>${other ? this.full(other) : "не записан"}<small>${note}</small></span>` +
          (off || s.action === "replace" ? '<button type="button" data-k="back" title="Вернуть как было">↺</button>'
            : (many ? `<button type="button" data-k="up" title="Раньше"${i === 0 ? " disabled" : ""}>↑</button>` +
              `<button type="button" data-k="down" title="Позже"${i === this.order.length - 1 ? " disabled" : ""}>↓</button>` : "") +
              '<button type="button" data-k="replace">заменить…</button><button type="button" data-k="drop" title="Выйти из союза">×</button>') +
          "</div>";
      }).join("") + "</div>"
      : '<div class="note2">нет</div>';
    if (many) {
      const moved = this.order.join() !== this.ruled.join();
      spouseBox.insertAdjacentHTML("beforeend", this.manual && !moved && !this.auto
        ? '<div class="note2">Очередь задана вручную. <button type="button" class="linkish" data-k="auto">вернуть к правилу</button></div>'
        : this.auto ? '<div class="note2">Очередь вернётся к правилу. <button type="button" class="linkish" data-k="unauto">оставить свою</button></div>'
          : moved ? '<div class="note2">Ваша очередь запишется в файл и будет главнее правила.</div>'
            : '<div class="note2">Очередь по правилу: даты венчания, дети, годы рождения супругов. Поменяете стрелками — запишется ваша.</div>');
    }
  }

  private onParent(e: Event): void {
    const target = e.target as HTMLElement;
    if (target.closest("[data-k=birth]")) return this.addBirthParents(target.getBoundingClientRect());
    const row = target.closest<HTMLElement>("[data-par]");
    const id = Number(row?.dataset.par);
    const button = target.closest<HTMLElement>("button");
    if (!row || !button) return;
    const s = this.parents.get(id)!;
    const pedi = button.closest("[data-k=pedi]") ? button.dataset.v : null;
    if (pedi) this.parents.set(id, { ...s, pedigree: pedi });
    else if (button.dataset.k === "drop") this.parents.set(id, { ...s, action: "drop", to: null });
    else if (button.dataset.k === "back") this.parents.set(id, { ...s, action: "keep", to: null, pedigree: s.was });
    else if (button.dataset.k === "move") return this.openPick("parent", id);
    this.draw();
  }

  private onSpouse(e: Event): void {
    const target = e.target as HTMLElement;
    const k = target.closest<HTMLElement>("[data-k]")?.dataset.k;
    if (k === "auto" || k === "unauto") {
      this.auto = k === "auto";
      if (this.auto) this.order = [...this.ruled];
      return this.draw();
    }
    const row = target.closest<HTMLElement>("[data-sp]");
    const id = Number(row?.dataset.sp);
    if (!row || !k) return;
    const at = this.order.indexOf(id);
    if (k === "up" && at > 0) this.order.splice(at - 1, 2, id, this.order[at - 1]!);
    if (k === "down" && at < this.order.length - 1) this.order.splice(at, 2, this.order[at + 1]!, id);
    if (k === "up" || k === "down") this.auto = false;
    if (k === "drop") this.spouses.set(id, { action: "drop", to: null });
    if (k === "back") this.spouses.set(id, { action: "keep", to: null });
    if (k === "replace") return this.openPick("spouse", id);
    this.draw();
  }

  // ── выбор семьи или человека ──
  private openPick(kind: "parent" | "spouse", family: number): void {
    this.picking = { kind, family };
    const box = this.host?.querySelector<HTMLElement>("[data-role=kinPick]");
    if (!box) return;
    box.hidden = false;
    const row = this.host!.querySelector(kind === "parent" ? `[data-par="${family}"]` : `[data-sp="${family}"]`);
    row?.after(box);
    const q = box.querySelector<HTMLInputElement>("[data-role=kinQ]")!;
    q.value = "";
    q.placeholder = kind === "parent" ? "имя отца или матери" : "имя или фамилия";
    this.drawPick();
    q.focus();
  }

  private closePick(): void {
    this.picking = null;
    const box = this.host?.querySelector<HTMLElement>("[data-role=kinPick]");
    if (box) {
      box.hidden = true;
      this.host?.querySelector("[data-role=kinSpouses]")?.after(box);
    }
    this.draw();
  }

  private drawPick(): void {
    const box = this.host?.querySelector<HTMLElement>("[data-role=kinPick]");
    if (!box || !this.picking) return;
    const words = box.querySelector<HTMLInputElement>("[data-role=kinQ]")!.value.toLowerCase().split(/\s+/).filter(Boolean);
    const match = (text: string) => words.every((w) => text.toLowerCase().includes(w));
    const list = box.querySelector<HTMLElement>("[data-role=kinList]")!;
    let items: string[] = [];
    if (this.picking.kind === "parent") {
      // семьи, куда можно перенести: с записанным родителем, не свои и не своих потомков
      const own = new Set([...this.parents.keys(), ...(this.persons.get(this.personId)?.spouse_families ?? [])]);
      items = this.tree.families
        .filter((f) => (f.husband != null || f.wife != null) && !own.has(f.id))
        .map((f) => {
          const names = [f.husband, f.wife].map((id) => (id != null ? this.persons.get(id) : undefined)).filter((p): p is TreePerson => !!p);
          return { f, text: names.map((p) => [p.given, p.surname].filter(Boolean).join(" ")).join(" и "), names };
        })
        .filter((x) => match(x.text))
        .slice(0, 30)
        .map((x) => `<div class="item go" data-pick="${x.f.id}"><b>${escapeHtml(x.text)}</b>` +
          `<small>${x.names.map((p) => escapeHtml(lifeYears(p))).join(" · ")} · детей: ${x.f.children.length}</small></div>`);
    } else {
      items = this.tree.persons
        .filter((p) => !p.is_branch_stub && p.id !== this.personId && match(`${p.given ?? ""} ${p.surname ?? ""}`))
        .slice(0, 30)
        .map((p) => `<div class="item go" data-pick="${p.id}"><b>${this.full(p)}</b><small>${escapeHtml(lifeYears(p))}</small></div>`);
    }
    list.innerHTML = items.join("") || '<div class="note">Никого не нашлось.</div>';
  }
}
