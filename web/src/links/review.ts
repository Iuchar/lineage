// Проверка очереди связок. Автопоиск ничего не связывает сам: он предлагает пары, у которых сошлись
// личное имя и год рождения, а решает человек, глядя на окружение обоих — родителей, супругов, детей.
// На широком экране проверка живёт в панели сбоку, карта остаётся на месте и наведена на кандидата (П3);
// на узком — очередь во весь экран: слева пары, справа оба окружения и построчное сравнение (П2).

import type { Candidate, ClanTree, Kin, KinPerson } from "../api/types";
import { drawCards, NO_MARKS } from "../canvas/cards";
import { drawLinks } from "../canvas/links";
import { escapeHtml } from "../format";
import { layoutTree } from "../layout/layout";
import { STYLE_METRICS, type StyleName } from "../layout/metrics";
import { around } from "./around";

export interface ReviewActions {
  tree: (clanId: number) => Promise<ClanTree>;
  show: (clanId: number, personId: number) => Promise<void>; // навести карту на кандидата (П3)
  style: () => StyleName;
  portraits: () => boolean;
  opened: () => void; // спрятать панель человека
  closed: () => void; // вернуть её
  decided: () => void; // связка поставлена или пара отвергнута: перечитать связки и счёт очереди
}

// уже́ этого окно — очередь во весь экран, иначе окружения в панели становятся мелкими
const NARROW = 1280;

const names = (items: readonly KinPerson[]) => items.map((k) => k.name).join(", ") || "—";
const span = (kin: Kin) => `${kin.person.born ?? "?"} — ${kin.person.died ?? "…"}`;
const surname = (kin: Kin, given: string) => kin.person.name.replace(given, "").trim() || "—";

export class LinkReview {
  private readonly pane: HTMLElement;
  private readonly full: HTMLElement;
  private queue: Candidate[] = [];
  private at = 0;
  private busy = false;
  // пришли сюда по пометке «ждёт проверки» — куда вернуться: к паре с этим кандидатом
  private back: { personId: number; title: string } | null = null;
  reviewing = false;

  constructor(host: HTMLElement, private readonly actions: ReviewActions) {
    this.pane = document.createElement("aside");
    this.pane.className = "side review";
    this.pane.setAttribute("aria-label", "Проверка связок");
    this.pane.hidden = true;
    this.full = document.createElement("div");
    this.full.className = "queueWrap";
    this.full.hidden = true;
    for (const el of [this.pane, this.full]) {
      el.addEventListener("click", (e) => {
        const target = (e.target as HTMLElement).closest<HTMLElement>("[data-act]");
        if (!target || this.busy) return;
        const act = target.dataset.act;
        if (act === "same") void this.decide("same");
        if (act === "different") void this.decide("different");
        if (act === "later") this.go(this.at + 1);
        if (act === "close") this.close();
        if (act === "pick") this.go(Number(target.dataset.i));
        if (act === "kin") this.toKin(Number(target.dataset.person));
        if (act === "linked") void this.actions.show(Number(target.dataset.clan), Number(target.dataset.person));
        if (act === "back") this.goBack();
      });
    }
    host.append(this.pane, this.full);
    window.addEventListener("resize", () => this.reviewing && void this.draw());
    document.addEventListener("keydown", (e) => {
      // Esc закрывает проверку всегда; в очереди ещё ← разные, → один человек, пробел — отложить
      if (!this.reviewing || this.busy) return;
      if ((e.target as HTMLElement).closest("input, textarea")) return;
      if (e.key === "Escape") return this.close();
      if (this.full.hidden) return;
      if (e.key === "ArrowLeft") void this.decide("different");
      else if (e.key === "ArrowRight") void this.decide("same");
      else if (e.key === " ") this.go(this.at + 1);
      else return;
      e.preventDefault();
    });
  }

  async count(): Promise<number> {
    const response = await fetch("/api/links/candidates");
    this.queue = response.ok ? ((await response.json()) as Candidate[]) : [];
    return this.queue.length;
  }

  async open(): Promise<void> {
    await this.count();
    this.at = 0;
    this.back = null;
    this.reviewing = true;
    this.actions.opened();
    await this.draw(true);
  }

  close(): void {
    this.reviewing = false;
    this.pane.hidden = true;
    this.full.hidden = true;
    this.actions.closed();
  }

  // обновить, если окружение поменялось снаружи (стиль, тема, портреты)
  refresh(): void {
    if (this.reviewing) void this.draw();
  }

  // родня в строках пары: кто сам ждёт проверки — кнопка к его проверке, кто связан — кнопка к нему в другой род
  private listOf(items: readonly KinPerson[]): string {
    if (!items.length) return "—";
    const waiting = new Set(this.queue.flatMap((p) => [p.a.person.id, p.b.person.id]));
    return items.map((k) => {
      const name = escapeHtml(k.name);
      if (k.linked) {
        return `${name}<button class="qk link" data-act="linked" data-clan="${k.linked.clan_id}" data-person="${k.linked.id}" ` +
          `title="Открыть в роду ${escapeHtml(k.linked.clan_name)}">связан · ${escapeHtml(k.linked.clan_name)} →</button>`;
      }
      if (waiting.has(k.id)) {
        return `${name}<button class="qk" data-act="kin" data-person="${k.id}" title="Открыть проверку: ${name}">ждёт проверки →</button>`;
      }
      return name;
    }).join(", ");
  }

  private toKin(personId: number): void {
    const index = this.queue.findIndex((p) => p.a.person.id === personId || p.b.person.id === personId);
    const here = this.queue[this.at];
    if (index < 0 || !here) return;
    this.back = { personId: here.a.person.id, title: this.title(here) };
    this.go(index);
  }

  private goBack(): void {
    const back = this.back;
    this.back = null;
    if (!back) return;
    const index = this.queue.findIndex((p) => p.a.person.id === back.personId);
    this.go(index < 0 ? this.at : index);
  }

  private backHtml(): string {
    return this.back ? `<button class="qBack" data-act="back">← назад к проверке: ${this.back.title}</button>` : "";
  }

  private go(index: number): void {
    this.at = this.queue.length ? ((index % this.queue.length) + this.queue.length) % this.queue.length : 0;
    void this.draw(true);
  }

  private async decide(verdict: "same" | "different"): Promise<void> {
    const pair = this.queue[this.at];
    if (!pair) return;
    this.busy = true;
    try {
      const body = JSON.stringify({ a: pair.a.person.id, b: pair.b.person.id });
      const headers = { "Content-Type": "application/json" };
      await fetch(verdict === "same" ? "/api/links" : "/api/links/reject", { method: "POST", headers, body });
      await this.count();
      this.actions.decided();
      // решённая пара ушла из очереди — на её месте уже следующая
      this.at = Math.min(this.at, Math.max(0, this.queue.length - 1));
      await this.draw(true);
    } finally {
      this.busy = false;
    }
  }

  private async draw(moveMap = false): Promise<void> {
    const narrow = window.innerWidth < NARROW;
    this.pane.hidden = narrow;
    this.full.hidden = !narrow;
    const pair = this.queue[this.at];
    if (!pair) {
      const empty =
        '<div class="sideIn"><span class="lbl">связки · проверка</span><h3>Очередь пуста</h3>' +
        '<div class="note">Все пары, у которых совпали имя и год рождения, разобраны. Связать вручную можно из панели человека.</div>' +
        '<div class="rActs"><button data-act="close">Закрыть</button></div></div>';
      (narrow ? this.full : this.pane).innerHTML = narrow ? `<div class="qEmpty">${empty}</div>` : empty;
      return;
    }
    const [treeA, treeB] = await Promise.all([this.actions.tree(pair.a.person.clan_id), this.actions.tree(pair.b.person.clan_id)]);
    if (narrow) this.drawQueue(pair, treeA, treeB);
    else {
      this.drawSide(pair, treeA, treeB);
      if (moveMap) await this.actions.show(pair.a.person.clan_id, pair.a.person.id);
    }
    this.fitScenes();
  }

  private title(pair: Candidate): string {
    const given = pair.a.person.name.split(" ")[0] ?? pair.a.person.name;
    return `${escapeHtml(given)}, ${pair.a.person.born ?? "год неизвестен"}`;
  }

  // П3: панель сбоку, карта на месте
  private drawSide(pair: Candidate, treeA: ClanTree, treeB: ClanTree): void {
    const card = (kin: Kin, tree: ClanTree) =>
      `<div class="rCard"><div class="who"><b>${escapeHtml(kin.person.name)}</b><span>${escapeHtml(kin.person.clan_name)}</span></div>` +
      this.scene(tree, kin.person.id) +
      `<div class="kinText"><i>годы:</i> ${span(kin)}<br><i>родители:</i> ${this.listOf(kin.parents)}` +
      `<br><i>супруги:</i> ${this.listOf(kin.spouses)}<br><i>дети:</i> ${this.listOf(kin.children)}</div></div>`;
    this.pane.innerHTML =
      '<div class="rClose"><button data-act="close" title="Закрыть проверку (Esc)">× Закрыть</button></div>' +
      `<div class="sideIn"><span class="lbl">связка · проверка · ${this.at + 1} из ${this.queue.length}</span>` +
      `${this.backHtml()}<h3>${this.title(pair)}</h3>${card(pair.a, treeA)}${card(pair.b, treeB)}` +
      '<div class="rActs"><button class="pri" data-act="same">Один человек</button>' +
      '<button data-act="different">Разные люди</button><button data-act="later">Отложить</button></div>' +
      '<div class="note">Связка не сливает людей: каждый остаётся в своём роду со своими данными, ' +
      'добавляется только переход и пометка «также в …». «Разные люди» больше не всплывут.</div></div>';
  }

  // П2: очередь во весь экран
  private drawQueue(pair: Candidate, treeA: ClanTree, treeB: ClanTree): void {
    const given = pair.a.person.name.split(" ")[0] ?? "";
    // совпадение строк сравнивается по именам, пометки — поверх
    const rows: [string, string, string, boolean][] = [
      ["Годы", span(pair.a), span(pair.b), span(pair.a) === span(pair.b)],
      ["Фамилия", escapeHtml(surname(pair.a, given)), escapeHtml(surname(pair.b, given)), surname(pair.a, given) === surname(pair.b, given)],
      ["Родители", this.listOf(pair.a.parents), this.listOf(pair.b.parents), names(pair.a.parents) === names(pair.b.parents)],
      ["Супруги", this.listOf(pair.a.spouses), this.listOf(pair.b.spouses), names(pair.a.spouses) === names(pair.b.spouses)],
      ["Дети", this.listOf(pair.a.children), this.listOf(pair.b.children), names(pair.a.children) === names(pair.b.children)],
    ];
    const list = this.queue.map((p, i) =>
      `<button class="qRow${i === this.at ? " on" : ""}" data-act="pick" data-i="${i}">` +
      `<b>${escapeHtml(p.a.person.name.split(" ")[0] ?? "")}, ${p.a.person.born ?? "?"}</b>` +
      `<small>${escapeHtml(p.a.person.clan_name)} · ${escapeHtml(p.b.person.clan_name)}</small></button>`).join("");
    const half = (kin: Kin, tree: ClanTree) =>
      `<div class="qHalf"><div class="who"><b>${escapeHtml(kin.person.name)}</b><span>${escapeHtml(kin.person.clan_name)}</span></div>` +
      `${this.scene(tree, kin.person.id)}</div>`;
    this.full.innerHTML =
      `<div class="qList"><span class="lbl">очередь · ${this.queue.length}</span>${list}</div>` +
      `<div class="qMain"><div class="qTop"><h3>${this.title(pair)}</h3><span class="lbl">пара ${this.at + 1} из ${this.queue.length}</span>${this.backHtml()}` +
      '<button class="qClose" data-act="close" title="Закрыть проверку (Esc)">× Закрыть</button></div>' +
      `<div class="qPair">${half(pair.a, treeA)}${half(pair.b, treeB)}</div>` +
      `<div class="qCmp">${rows.map(([k, x, y, same]) =>
        `<div class="k">${k}</div><div class="v${same ? " same" : ""}">${x}</div><div class="v${same ? " same" : ""}">${y}</div>`).join("")}</div>` +
      '<div class="qFoot"><button class="pri" data-act="same">Один человек</button><button data-act="different">Разные люди</button>' +
      '<button data-act="later">Отложить</button><span class="hint">← разные · → один · пробел — позже · Esc — закрыть</span></div></div>';
  }

  // маленькое дерево тем же раскладчиком и тем же почерком, что карта; кандидат выделен
  private scene(tree: ClanTree, personId: number): string {
    const style = this.actions.style();
    const small = around(tree, personId);
    const layout = layoutTree(small, STYLE_METRICS[style], { ruler: false, rootAtBottom: false });
    const links = drawLinks(small, layout, style, (name) => `var(${name})`);
    const width = layout.width + 40;
    const height = layout.height + 40;
    return `<div class="rScene" data-w="${width}" data-h="${height}"><div class="canvas" style="width:${width}px;height:${height}px">` +
      `<svg class="links" width="${width}" height="${height}">${links.paths}${links.marks}</svg>` +
      drawCards(small, layout, style, personId, NO_MARKS, undefined, undefined, { portraits: this.actions.portraits() }) +
      "</div></div>";
  }

  private fitScenes(): void {
    for (const scene of document.querySelectorAll<HTMLElement>(".rScene")) {
      const w = Number(scene.dataset.w);
      const h = Number(scene.dataset.h);
      const k = Math.min(scene.clientWidth / w, scene.clientHeight / h, 0.8);
      const canvas = scene.querySelector<HTMLElement>(".canvas")!;
      canvas.style.transform = `translate(${(scene.clientWidth - w * k) / 2}px,${(scene.clientHeight - h * k) / 2}px) scale(${k})`;
    }
  }
}
