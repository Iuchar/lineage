// Панель выбранного человека справа: сведения, родня, браки, заметки, место среди братьев.

import type { ClanLink, ClanTree, PersonDetails, PersonEvent, TreePerson } from "../api/types";
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

  constructor(
    host: HTMLElement,
    private readonly actions: PanelActions,
  ) {
    this.element = document.createElement("aside");
    this.element.className = "side";
    this.element.addEventListener("click", (e) => {
      const target = (e.target as HTMLElement).closest<HTMLElement>("[data-id],[data-act]");
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
    if (this.last?.person.id !== personId) this.confirming = null;
    const request = ++this.request;
    this.render(tree, person, null); // сразу из дерева, подробности дорисуются
    const response = await fetch(`/api/persons/${personId}`);
    if (request !== this.request || !response.ok) return;
    this.render(tree, person, (await response.json()) as PersonDetails);
  }

  private render(tree: ClanTree, person: TreePerson, details: PersonDetails | null): void {
    this.last = { tree, person, details };
    const rel = relativesOf(tree, person.id);
    let h = '<div class="sideIn">';

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
