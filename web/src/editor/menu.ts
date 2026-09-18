// Список у плюса: кого добавить и к кому привязать. Плюс ничего не решает сам — второго родителя,
// чьим ребёнком будет брат или сестра, отца или мать выбирает человек. Выбор ведёт в форму нового
// человека (или в поиск уже записанного) с готовой привязкой.

import type { ClanTree, TreePerson } from "../api/types";
import type { PlusKind } from "../canvas/canvas";
import { escapeHtml } from "../format";
import { relativesOf } from "../panel/relatives";
import type { NewPersonPlan } from "./form";

export interface MenuActions {
  chosen: (plan: NewPersonPlan, existing: boolean) => void;
  closed: () => void;
}

const full = (p: TreePerson | null) => (p ? [p.given, p.surname].filter(Boolean).join(" ") || "без имени" : "");

interface Option {
  label: string;
  hint: string;
  plan: (sex: "M" | "F") => NewPersonPlan;
  existing?: boolean;
}

export class RelativeMenu {
  private readonly box: HTMLElement;

  constructor(private readonly actions: MenuActions) {
    this.box = document.createElement("div");
    this.box.className = "pop";
    this.box.hidden = true;
    document.body.append(this.box);
    document.addEventListener("pointerdown", (e) => {
      if (this.box.hidden) return;
      const target = e.target as HTMLElement;
      if (!this.box.contains(target) && !target.closest("[data-plus], [data-add]")) this.close();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !this.box.hidden) this.close();
    });
  }

  close(): void {
    if (this.box.hidden) return;
    this.box.hidden = true;
    this.actions.closed();
  }

  // separate — родные родители отдельной семьёй, когда человек записан у приёмных
  open(tree: ClanTree, kind: PlusKind, personId: number, at: DOMRect, separate = false): void {
    const person = tree.persons.find((p) => p.id === personId);
    if (!person) return;
    const rel = relativesOf(tree, personId);
    const name = full(person);
    const sexes: [string, string] = kind === "parent" ? ["отец", "мать"] : kind === "sibling" ? ["брат", "сестра"] : ["сын", "дочь"];
    const word = (sex: "M" | "F") => (sex === "M" ? sexes[0] : sexes[1]);
    const base = { person_id: personId, other_id: null, parents: "both" as const, pedigree: "birth" as const, separate };
    let title = "";
    let options: Option[] = [];
    let askSex = true;

    if (kind === "parent") {
      title = separate ? `родные родители · ${name}` : `родитель · ${name}`;
      // пол решает место: отец в слот мужа, мать в слот жены; занятый слот не предлагаем
      const plan = (sex: "M" | "F"): NewPersonPlan => ({
        relation: { ...base, kind: "parent" }, sex, pedigree: false,
        surname: sex === "M" ? person.surname : null,
        bind: `<b>${word(sex)}</b> · ребёнок: ${escapeHtml(name)}` + (separate ? " · родная семья, отдельно от приёмной" : ""),
      });
      options = [{ label: "новый человек", hint: "запишется в род", plan }, { label: "выбрать уже записанного…", hint: "из рода", plan, existing: true }];
    } else if (kind === "spouse") {
      title = `новый союз · ${name}`;
      askSex = false;
      const sex = person.sex === "M" ? "F" : person.sex === "F" ? "M" : null;
      const plan = (): NewPersonPlan => ({
        relation: { ...base, kind: "spouse" }, sex, surname: null, pedigree: false,
        bind: `<b>новый союз</b> · с: ${escapeHtml(name)}` +
          (rel.marriages.length ? ` · встанет ${rel.marriages.length + 1}-м союзом` : ""),
      });
      options = [{ label: "новый человек", hint: "запишется в род", plan }, { label: "выбрать уже записанного…", hint: "из рода", plan, existing: true }];
    } else if (kind === "sibling") {
      title = `брат или сестра · ${name}`;
      const both = [rel.father, rel.mother].filter(Boolean) as TreePerson[];
      const plan = (parents: "both" | "father" | "mother") => (sex: "M" | "F"): NewPersonPlan => {
        const who = parents === "father" ? [rel.father] : parents === "mother" ? [rel.mother] : both;
        return {
          relation: { ...base, kind: "sibling", parents }, sex, pedigree: true,
          surname: parents !== "mother" ? (rel.father?.surname ?? person.surname) : null,
          bind: `<b>${word(sex)}</b> · ${escapeHtml(name)} · ` + (who.length
            ? `родители: ${who.map((p) => escapeHtml(full(p!))).join(" и ")}`
            : "родители не записаны — их общая семья появится без родителей; добавите их потом — встанут над всеми") +
            (parents !== "both" ? ` · ${parents === "father" ? "единокровный" : "единоутробный"}` : ""),
        };
      };
      if (both.length) options.push({ label: both.map(full).join(" и "), hint: both.length === 2 ? "родной" : "", plan: plan("both") });
      else options.push({ label: "родители не записаны", hint: "общая семья без них", plan: plan("both") });
      if (rel.father && rel.mother) {
        options.push({ label: `только ${full(rel.father)}`, hint: "единокровный", plan: plan("father") });
        options.push({ label: `только ${full(rel.mother)}`, hint: "единоутробный", plan: plan("mother") });
      }
      options.push({ label: "выбрать уже записанного…", hint: "из рода", plan: plan("both"), existing: true });
    } else {
      title = `ребёнок · ${name}`;
      const plan = (other: TreePerson | null) => (sex: "M" | "F"): NewPersonPlan => {
        const father = person.sex === "M" ? person : other?.sex === "M" ? other : null;
        return {
          relation: { ...base, kind: "child", other_id: other?.id ?? null }, sex, pedigree: true,
          surname: father?.surname ?? person.surname,
          bind: `<b>${word(sex)}</b> · родители: ${escapeHtml(name)}` + (other ? ` и ${escapeHtml(full(other))}` : ", второй неизвестен"),
        };
      };
      for (const marriage of rel.marriages) {
        if (marriage.spouse) options.push({ label: full(marriage.spouse), hint: marriage.spouse.sex === "F" ? "жена" : marriage.spouse.sex === "M" ? "муж" : "супруг", plan: plan(marriage.spouse) });
      }
      options.push({ label: "второй родитель неизвестен", hint: "союз с одним родителем", plan: plan(null) });
      options.push({ label: "другой — новый союз", hint: "сначала записать его", plan: () => ({
        relation: { ...base, kind: "spouse" }, sex: person.sex === "M" ? "F" : person.sex === "F" ? "M" : null,
        surname: null, pedigree: false, bind: `<b>новый союз</b> · с: ${escapeHtml(name)} · потом добавьте ребёнка к нему`,
      }) });
      options.push({ label: "выбрать уже записанного…", hint: "из рода", plan: plan(rel.marriages[0]?.spouse ?? null), existing: true });
    }

    this.box.innerHTML =
      `<div class="t">${escapeHtml(title)}</div>` +
      (askSex ? `<div class="seg" data-seg="sex"><button type="button" data-v="M" class="on">${sexes[0]}</button>` +
        `<button type="button" data-v="F">${sexes[1]}</button></div>` : "") +
      (kind === "child" ? '<div class="t" style="margin-top:8px">второй родитель</div>' : kind === "sibling" ? '<div class="t" style="margin-top:8px">чей ребёнок</div>' : "") +
      options.map((o, i) => `<button type="button" class="opt" data-i="${i}"><span>${escapeHtml(o.label)}</span><i>${escapeHtml(o.hint)}</i></button>`).join("");
    // у родителя занятое место не предлагается: отец записан — остаётся мать, и наоборот
    if (kind === "parent" && !separate && (rel.father || rel.mother)) {
      const taken = rel.father ? "M" : "F";
      const buttons = this.box.querySelectorAll<HTMLButtonElement>("[data-seg=sex] button");
      buttons.forEach((b) => {
        b.disabled = b.dataset.v === taken;
        b.classList.toggle("on", b.dataset.v !== taken);
      });
    }
    const sex = () => (this.box.querySelector<HTMLElement>("[data-seg=sex] .on")?.dataset.v ?? "M") as "M" | "F";
    this.box.onclick = (e) => {
      const target = e.target as HTMLElement;
      const segButton = target.closest<HTMLElement>("[data-seg] button");
      if (segButton) {
        segButton.parentElement?.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b === segButton));
        return;
      }
      const opt = target.closest<HTMLElement>("[data-i]");
      if (!opt) return;
      const option = options[Number(opt.dataset.i)]!;
      this.box.hidden = true;
      this.actions.chosen(option.plan(sex()), option.existing === true);
    };
    this.box.hidden = false;
    // список — сбоку от плюса, целиком на экране
    const w = this.box.offsetWidth;
    const h = this.box.offsetHeight;
    const right = at.right + 10 + w <= window.innerWidth - 8;
    this.box.style.left = `${right ? at.right + 10 : Math.max(8, at.left - 10 - w)}px`;
    this.box.style.top = `${Math.min(Math.max(8, at.top + at.height / 2 - h / 2), window.innerHeight - h - 8)}px`;
  }
}
