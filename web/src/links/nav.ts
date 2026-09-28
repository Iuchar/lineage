// Переход по связкам между родами: кто в роду связан, куда ведёт сноска, как вернуться обратно.

import type { ClanLink } from "../api/types";
import { escapeHtml } from "../format";

export interface NavActions {
  // открыть род и навести карту на человека
  goTo: (clanId: number, personId: number) => Promise<void>;
  // связки поменялись: перерисовать карту и панель
  changed: () => void;
}

interface Trail {
  clanId: number;
  clanName: string;
  personId: number;
  personName: string;
  via: number; // связка, по которой пришли: в панели она становится возвратом
}

export class LinkNav {
  byPerson: ReadonlyMap<number, readonly ClanLink[]> = new Map();
  private trail: Trail | null = null;
  private readonly ribbon: HTMLElement;

  constructor(host: HTMLElement, private readonly actions: NavActions) {
    this.ribbon = document.createElement("div");
    this.ribbon.className = "trail";
    this.ribbon.hidden = true;
    this.ribbon.addEventListener("click", (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act;
      if (act === "back") void this.back();
      if (act === "close") this.forget();
    });
    host.append(this.ribbon);
  }

  asViewer: number | null = null; // редактор смотрит «глазами зрителя рода N»

  async load(clanId: number): Promise<ReadonlyMap<number, readonly ClanLink[]>> {
    const eyes = this.asViewer == null ? "" : `?as_viewer=${this.asViewer}`;
    const response = await fetch(`/api/clans/${clanId}/links${eyes}`);
    const links = response.ok ? ((await response.json()) as ClanLink[]) : [];
    const map = new Map<number, ClanLink[]>();
    for (const link of links) map.set(link.person_id, [...(map.get(link.person_id) ?? []), link]);
    this.byPerson = map;
    return map;
  }

  linksOf(personId: number): readonly ClanLink[] {
    return this.byPerson.get(personId) ?? [];
  }

  isReturn(link: ClanLink): boolean {
    return this.trail?.via === link.link_id;
  }

  // пройти по связке; если она ведёт туда, откуда пришли, — это возврат, и лента гаснет
  async open(link: ClanLink, here: { clanId: number; clanName: string; personName: string }): Promise<void> {
    if (this.isReturn(link)) return this.back();
    this.trail = { clanId: here.clanId, clanName: here.clanName, personId: link.person_id, personName: here.personName,
      via: link.link_id };
    await this.actions.goTo(link.other.clan_id, link.other.id);
    this.drawRibbon();
  }

  async back(): Promise<void> {
    const trail = this.trail;
    if (!trail) return;
    this.forget();
    await this.actions.goTo(trail.clanId, trail.personId);
  }

  // человек ушёл из пути сам — сменил род вкладкой
  forget(): void {
    this.trail = null;
    this.drawRibbon();
  }

  async unlink(link: ClanLink): Promise<void> {
    const response = await fetch(`/api/links/${link.link_id}`, { method: "DELETE" });
    if (!response.ok && response.status !== 404) return;
    if (this.trail?.via === link.link_id) this.forget();
    this.actions.changed();
  }

  private drawRibbon(): void {
    const trail = this.trail;
    this.ribbon.hidden = !trail;
    if (!trail) return;
    this.ribbon.innerHTML =
      `<span class="mk">связка</span>Пришли из «${escapeHtml(trail.clanName)}», карточка «${escapeHtml(trail.personName)}»` +
      '<button data-act="back">← Вернуться</button><button class="x" data-act="close" title="Убрать ленту">×</button>';
  }
}
