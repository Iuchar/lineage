// Панель выбранного человека справа: сведения, родня, браки, заметки, место среди братьев.

import type { ChangeInfo, ClanLink, ClanTree, PersonDetails, PersonEvent, TreePerson } from "../api/types";
import type { PlusKind } from "../canvas/canvas";
import { historyHtml, revertChange } from "../editor/journal";
import { cardName, escapeHtml, formatDate, lifeYears } from "../format";
import { silhouette } from "../canvas/portrait";
import { TAG_COLORS, type Tag } from "../canvas/tags";
import { descendantsOf } from "../layout/fold";
import { relativesOf } from "./relatives";

export interface PanelActions {
  select: (id: number) => void;
  centre: () => void;
  nudge: (id: number, direction: -1 | 1) => void;
  manualOffset: (id: number) => number;
  toggleFold: (familyId: number) => void;
  isFolded: (familyId: number) => boolean;
  // портрет человека: снимок, заглушка или ничего, когда портреты выключены
  portrait: (person: TreePerson) => string | null;
  tagsOf: (personId: number) => Tag[];
  // связки с другими родами: переход, возврат, снятие и ручная связка
  linksOf: (personId: number) => readonly ClanLink[];
  isReturn: (link: ClanLink) => boolean; // по этой связке человек сюда и пришёл
  openLink: (link: ClanLink) => void;
  unlink: (link: ClanLink) => void;
  linkWith: (personId: number) => void;
  // режим правки
  editing: () => boolean;
  startEdit: (personId: number) => void;
  addRelative: (kind: PlusKind, personId: number, at: DOMRect) => void;
  reverted: (change: ChangeInfo) => void;
}

const EVENT_LABELS: Record<string, string> = {
  BIRT: "Рождение", DEAT: "Смерть", BURI: "Погребение", CREM: "Кремация", CHR: "Крещение", BAPM: "Крещение",
  OCCU: "Занятие", TITL: "Титул", RESI: "Проживание", EDUC: "Образование", RELI: "Вероисповедание",
  NATI: "Происхождение", EMIG: "Эмиграция", IMMI: "Иммиграция", ADOP: "Усыновление", GRAD: "Выпуск",
  RETI: "Отставка", PROB: "Утверждение завещания", WILL: "Завещание", CENS: "Перепись",
  MARR: "Венчание", DIV: "Развод", ENGG: "Помолвка",
};
const ORDINAL = ["Первый", "Второй", "Третий", "Четвёртый", "Пятый", "Шестой"];

const kin = (person: TreePerson) =>
  `<button class="kin" data-id="${person.id}">${escapeHtml([cardName(person), person.is_branch_stub ? null : person.surname].filter(Boolean).join(" "))}</button>`;

const row = (label: string, value: string) => `<div class="row"><span>${label}</span><i>${value}</i></div>`;

function eventText(event: PersonEvent): string {
  return [event.value, formatDate(event.date), event.place].filter(Boolean).map((t) => escapeHtml(t!)).join(", ");
}

const lifeSpan = (born: number | null, died: number | null) =>
  born == null && died == null ? "годы неизвестны" : `${born ?? "?"} — ${died ?? "…"}`;

export class PersonPanel {
  readonly element: HTMLElement;
  private request = 0;
  private last: { tree: ClanTree; person: TreePerson; details: PersonDetails | null } | null = null;
  private confirming: number | null = null; // связка, которую просят снять: второе нажатие подтверждает
  private tab: "person" | "history" = "person";

  constructor(
    host: HTMLElement,
    private readonly actions: PanelActions,
  ) {
    this.element = document.createElement("aside");
    this.element.className = "side";
    this.element.addEventListener("click", (e) => {
      const target = (e.target as HTMLElement).closest<HTMLElement>("[data-id],[data-act],[data-add],[data-tab],[data-revert]");
      if (!target) return;
      if (target.dataset.id) this.actions.select(Number(target.dataset.id));
      const id = Number(target.dataset.person);
      if (target.dataset.act === "centre") this.actions.centre();
      if (target.dataset.act === "left") this.actions.nudge(id, -1);
      if (target.dataset.act === "right") this.actions.nudge(id, 1);
      if (target.dataset.act === "fold") this.actions.toggleFold(Number(target.dataset.family));
      const link = this.linkFor(Number(target.dataset.link));
      if (target.dataset.act === "link-go" && link) this.actions.openLink(link);
      if (target.dataset.act === "link-with") this.actions.linkWith(Number(target.dataset.person));
      if (target.dataset.act === "unlink" && link) {
        if (this.confirming === link.link_id) {
          this.confirming = null;
          this.actions.unlink(link);
        } else {
          this.confirming = link.link_id;
          this.redraw();
        }
      }
      if (target.dataset.act === "edit" && this.last) this.actions.startEdit(this.last.person.id);
      if (target.dataset.add && this.last) {
        this.actions.addRelative(target.dataset.add as PlusKind, this.last.person.id, target.getBoundingClientRect());
      }
      if (target.dataset.tab) {
        this.tab = target.dataset.tab as "person" | "history";
        this.redraw();
      }
      if (target.dataset.revert) void this.revert(Number(target.dataset.revert));
      if (target.dataset.act === "unlink-no") {
        this.confirming = null;
        this.redraw();
      }
    });
    host.append(this.element);
    this.clear();
  }

  private linkFor(id: number): ClanLink | undefined {
    if (!this.last || !id) return undefined;
    return this.actions.linksOf(this.last.person.id).find((l) => l.link_id === id);
  }

  // перерисовать то же самое: после снятия связки или смены подтверждения
  redraw(): void {
    if (this.last) this.render(this.last.tree, this.last.person, this.last.details);
  }

  clear(): void {
    this.last = null;
    this.confirming = null;
    this.request++;
    this.element.innerHTML = '<div class="empty">никто не выбран</div>';
  }

  async show(tree: ClanTree, personId: number): Promise<void> {
    const person = tree.persons.find((p) => p.id === personId);
    if (!person) return this.clear();
    if (this.last?.person.id !== personId) {
      this.confirming = null;
      this.tab = "person";
    }
    const request = ++this.request;
    this.render(tree, person, null); // сразу из дерева, подробности дорисуются
    const response = await fetch(`/api/persons/${personId}`);
    if (request !== this.request || !response.ok) return;
    this.render(tree, person, (await response.json()) as PersonDetails);
  }

  private render(tree: ClanTree, person: TreePerson, details: PersonDetails | null): void {
    this.last = { tree, person, details };
    const rel = relativesOf(tree, person.id);
    const editing = this.actions.editing() && !person.is_branch_stub;
    let h = "";
    if (editing) {
      h += `<div class="tabs2"><button data-tab="person"${this.tab === "person" ? ' class="on"' : ""}>Человек</button>` +
        `<button data-tab="history"${this.tab === "history" ? ' class="on"' : ""}>История</button></div>`;
      if (this.tab === "history") {
        this.element.innerHTML = `${h}<div class="sideIn jr" data-role="history"><div class="note">…</div></div>`;
        void historyHtml(person.id).then((html) => {
          const box = this.element.querySelector("[data-role=history]");
          if (box && this.last?.person.id === person.id && this.tab === "history") box.innerHTML = html;
        });
        return;
      }
    }
    h += '<div class="sideIn">';
    if (editing) h += '<div class="btns" style="margin:0 0 12px"><button class="pri" data-act="edit">Править</button></div>';

    if (person.is_branch_stub) {
      h += `<h3>${escapeHtml(cardName(person))}</h3><div class="sub">ветка уходит дальше · ${escapeHtml(person.xref)}</div>`;
    } else {
      const photo = this.actions.portrait(person);
      h += photo ? `<div class="por" style="background:${photo} center / cover"></div>` : '<div class="por"></div>';
      h += `<h3>${escapeHtml([person.given, person.surname].filter(Boolean).join(" ") || "без имени")}</h3>`;
      if (person.married_surname && person.married_surname !== person.surname) {
        h += `<div class="maiden">по мужу ${escapeHtml(person.married_surname)}</div>`;
      }
      h += `<div class="sub">${escapeHtml(lifeYears(person))} · ${escapeHtml(person.xref)}</div>`;
      const tags = this.actions.tagsOf(person.id);
      if (tags.length) {
        h += `<div class="chips">${tags
          .map((t) => `<span style="--c:${TAG_COLORS[t.color]}"><i></i>${escapeHtml(t.name)}</span>`)
          .join("")}</div>`;
      }
    }

    h += '<div class="lbl">Сведения</div>';
    if (!person.is_branch_stub) {
      h += row("Пол", person.sex === "M" ? "мужской" : person.sex === "F" ? "женский" : "—");
    }
    if (rel.father) h += row("Отец", kin(rel.father));
    if (rel.mother) h += row("Мать", kin(rel.mother));
    if (!rel.father && !rel.mother) h += row("Родители", "не указаны");
    for (const parent of rel.otherParents) h += row("Ещё родитель", kin(parent));
    for (const event of details?.events ?? []) {
      const label = EVENT_LABELS[event.tag];
      const text = eventText(event);
      // рождение и смерть уже в годах, если к ним нечего добавить
      if (!label || !text || ((event.tag === "BIRT" || event.tag === "DEAT") && !event.place)) continue;
      h += row(label, text);
    }

    if (editing) h += this.addHtml(tree, person);
    if (!person.is_branch_stub) h += this.linksHtml(person);

    if (rel.marriages.length) {
      h += `<div class="lbl">${rel.marriages.length > 1 ? "Браки" : "Брак"}</div>`;
      rel.marriages.forEach((marriage, i) => {
        const spouseLabel = marriage.spouse?.sex === "F" ? "Жена" : marriage.spouse?.sex === "M" ? "Муж" : "Супруг";
        const label = rel.marriages.length > 1 ? `${ORDINAL[i] ?? `${i + 1}-й`} брак` : spouseLabel;
        h += row(label, marriage.spouse ? kin(marriage.spouse) : "неизвестен");
        const events = details?.marriages.find((m) => m.family_id === marriage.family.id)?.events ?? [];
        for (const event of events) {
          const text = eventText(event);
          if (text || EVENT_LABELS[event.tag]) h += row(EVENT_LABELS[event.tag] ?? event.tag, text || "—");
        }
        h += row("Дети", marriage.children.length ? marriage.children.map(kin).join(", ") : "нет");
        if (marriage.children.length) {
          const folded = this.actions.isFolded(marriage.family.id);
          const count = descendantsOf(tree, marriage.family.id).size;
          h +=
            `<div class="foldRow"><button data-act="fold" data-family="${marriage.family.id}" aria-pressed="${folded}">` +
            `${folded ? "Развернуть ветку" : "Свернуть ветку"}</button><span>${count} в ветке</span></div>`;
        }
      });
    }

    const notes = (details?.events ?? []).filter((e) => e.tag === "EVEN" && e.value);
    if (notes.length) {
      h += '<div class="lbl">Заметки</div>';
      for (const note of notes) {
        const kind = note.type && note.type !== "Comment" ? `<b>${escapeHtml(note.type)}.</b> ` : "";
        h += `<div class="note">${kind}${escapeHtml(note.value!)}</div>`;
      }
    }

    if (rel.siblings.length) {
      const offset = this.actions.manualOffset(person.id);
      h +=
        '<div class="lbl">Место среди братьев</div>' +
        `<div class="nudge"><button data-act="left" data-person="${person.id}">← левее</button>` +
        `<span>${offset ? (offset > 0 ? "+" : "") + offset : "по дате"}</span>` +
        `<button data-act="right" data-person="${person.id}">правее →</button></div>`;
    }

    h += '<div class="actions"><button data-act="centre">В центр</button></div>';
    h += "</div>";
    this.element.innerHTML = h;
  }

  // раздел «Добавить»: те же места, что плюсы на карте; занятые приглушены
  private addHtml(tree: ClanTree, person: TreePerson): string {
    const rel = relativesOf(tree, person.id);
    const full = (p: TreePerson | null) => (p ? [p.given, p.surname].filter(Boolean).join(" ") : "");
    const parents = [rel.father, rel.mother].filter(Boolean).length;
    const spouses = rel.marriages.map((m) => m.spouse).filter(Boolean) as TreePerson[];
    const cell = (kind: PlusKind, title: string, note: string, off = false, wide = false) =>
      `<button type="button" class="${off ? "done" : ""}${wide ? " wide" : ""}" data-add="${kind}"${off ? " disabled" : ""}>` +
      `+ ${title}<small>${escapeHtml(note)}</small></button>`;
    return '<div class="lbl">Добавить</div><div class="addGrid">' +
      cell("parent", "родитель", parents === 2 ? `есть оба: ${full(rel.father).split(" ")[0]}, ${full(rel.mother).split(" ")[0]}`
        : parents === 1 ? `есть: ${full(rel.father ?? rel.mother)}` : "не записаны", parents === 2) +
      cell("spouse", person.sex === "F" ? "муж" : person.sex === "M" ? "жена" : "супруг",
        spouses.length ? `ещё один союз · сейчас ${spouses.length}` : "новый союз") +
      cell("sibling", "брат или сестра", parents ? `к ${[rel.father, rel.mother].filter(Boolean).map((p) => full(p).split(" ")[0]).join(" и ")}` : "сначала появятся родители", !parents) +
      cell("child", "сын или дочь", spouses.length ? `с ${full(spouses[0]!).split(" ")[0]} или без второго родителя` : "с другим родителем или без него") +
      "</div>";
  }

  private async revert(changeId: number): Promise<void> {
    const result = await revertChange(changeId);
    if (result.ok) return this.actions.reverted(result.change);
    const box = this.element.querySelector<HTMLElement>("[data-role=history] [data-role=err]");
    if (box) box.textContent = result.detail;
  }

  // «Также в роду»: каждая связка строкой с переходом; по той, что привела сюда, — возврат
  private linksHtml(person: TreePerson): string {
    const links = this.actions.linksOf(person.id);
    let h = links.length ? '<div class="lbl">Также в роду</div>' : '<div class="lbl">Связки</div>';
    for (const link of links) {
      const back = this.actions.isReturn(link);
      const clan = escapeHtml(link.other.clan_name);
      const sure = this.confirming === link.link_id;
      h +=
        `<div class="twin"><b>${clan}</b><small>${escapeHtml(link.other.name)} · ${lifeSpan(link.other.born, link.other.died)}</small>` +
        `<div class="acts">` +
        (sure
          ? `<button data-act="unlink" data-link="${link.link_id}">Снять связку</button>` +
            `<button data-act="unlink-no">Оставить</button>`
          : `<button class="go" data-act="link-go" data-link="${link.link_id}">${back ? `← Вернуться в «${clan}»` : `Перейти в «${clan}»`}</button>` +
            `<button data-act="unlink" data-link="${link.link_id}" title="Снять связку: люди останутся в своих родах">Снять</button>`) +
        `</div></div>`;
    }
    h += `<button class="linkBtn" data-act="link-with" data-person="${person.id}">Связать с человеком из другого рода…</button>`;
    return h;
  }
}
