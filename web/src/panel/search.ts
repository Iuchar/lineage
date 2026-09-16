// Поиск по имени внутри рода: личное имя, фамилия, фамилия по мужу. Ё и е не различаются.

import type { ClanTree, TreePerson } from "../api/types";
import { cardName, escapeHtml, lifeYears } from "../format";

const normalise = (text: string) => text.toLocaleLowerCase("ru").replaceAll("ё", "е").trim();

export function findPersons(tree: ClanTree, query: string, limit = 12): TreePerson[] {
  const words = normalise(query).split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const scored: { person: TreePerson; score: number }[] = [];
  for (const person of tree.persons) {
    const fields = [person.given, person.surname, person.married_surname].map((f) => normalise(f ?? ""));
    if (!words.every((w) => fields.some((f) => f.includes(w)))) continue;
    // точное имя выше начала имени, начало — выше вхождения в середину, заглушки в конце
    const given = fields[0]!;
    const first = words[0]!;
    const score = (given === first ? 0 : given.startsWith(first) ? 1 : 2) + (person.is_branch_stub ? 3 : 0);
    scored.push({ person, score });
  }
  return scored.sort((a, b) => a.score - b.score).slice(0, limit).map((s) => s.person);
}

export class SearchBox {
  readonly element: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly list: HTMLElement;
  private tree: ClanTree | null = null;
  private results: TreePerson[] = [];
  private active = 0;

  constructor(private readonly onPick: (id: number) => void) {
    this.element = document.createElement("div");
    this.element.className = "grp search";
    this.element.innerHTML = '<b>Поиск</b><input type="search" placeholder="имя или фамилия" autocomplete="off"><div class="results" hidden></div>';
    this.input = this.element.querySelector("input")!;
    this.list = this.element.querySelector(".results")!;

    this.input.addEventListener("input", () => this.update());
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (!this.results.length) return;
        this.active = (this.active + (e.key === "ArrowDown" ? 1 : -1) + this.results.length) % this.results.length;
        this.draw();
      } else if (e.key === "Enter") {
        const person = this.results[this.active];
        if (person) this.pick(person.id);
      } else if (e.key === "Escape") {
        this.close();
      }
    });
    this.list.addEventListener("pointerdown", (e) => {
      const item = (e.target as HTMLElement).closest<HTMLElement>("[data-id]");
      if (item) {
        e.preventDefault();
        this.pick(Number(item.dataset.id));
      }
    });
    this.input.addEventListener("blur", () => this.close());
  }

  setTree(tree: ClanTree): void {
    this.tree = tree;
    this.input.value = "";
    this.close();
  }

  private update(): void {
    this.results = this.tree ? findPersons(this.tree, this.input.value) : [];
    this.active = 0;
    this.draw();
  }

  private draw(): void {
    if (!this.input.value.trim()) return this.close();
    this.list.hidden = false;
    this.list.innerHTML = this.results.length
      ? this.results
          .map(
            (p, i) =>
              `<div class="hit${i === this.active ? " on" : ""}" data-id="${p.id}">${escapeHtml([cardName(p), p.is_branch_stub ? null : p.surname].filter(Boolean).join(" "))}<small>${escapeHtml(lifeYears(p))}</small></div>`,
          )
          .join("")
      : '<div class="miss">никого не нашлось</div>';
  }

  private pick(id: number): void {
    this.close();
    this.input.blur();
    this.onPick(id);
  }

  private close(): void {
    this.list.hidden = true;
  }
}
