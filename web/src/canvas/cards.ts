// Карточки людей в HTML. Оформление целиком в CSS стиля, здесь только разметка и состояния.

import type { ClanTree } from "../api/types";
import { cardName, escapeHtml, lifeYears } from "../format";
import type { LayoutResult } from "../layout/layout";
import type { StyleName } from "../layout/metrics";
import { LINK_STYLES, ORDINAL_WORDS, ROMAN } from "./styles";

export interface PersonMarks {
  burnt: ReadonlySet<number>; // выжжен из рода
  hidden: ReadonlySet<number>; // скрыт от зрителей — редактор видит с пометкой
  linked: ReadonlySet<number>; // также в другом роду
}

export const NO_MARKS: PersonMarks = { burnt: new Set(), hidden: new Set(), linked: new Set() };

// очередь брака у супругов многобрачного: «первый», «второй» или I, II
function marriageOrder(tree: ClanTree): Map<number, number> {
  const families = new Map(tree.families.map((f) => [f.id, f]));
  const order = new Map<number, number>();
  for (const person of tree.persons) {
    if (person.spouse_families.length < 2) continue;
    person.spouse_families.forEach((fid, i) => {
      const family = families.get(fid);
      if (!family) return;
      const spouse = family.husband === person.id ? family.wife : family.husband;
      if (spouse != null) order.set(spouse, i);
    });
  }
  return order;
}

export function drawCards(
  tree: ClanTree,
  layout: LayoutResult,
  style: StyleName,
  selected: number | null,
  marks: PersonMarks,
): string {
  const ordinal = LINK_STYLES[style].ordinal;
  const order = marriageOrder(tree);
  let html = "";
  for (const person of tree.persons) {
    const point = layout.positions.get(person.id)!;
    const classes = ["node"];
    if (person.id === selected) classes.push("sel");
    if (marks.burnt.has(person.id)) classes.push("burnt");
    if (person.is_branch_stub) classes.push("stub");

    const idx = order.get(person.id);
    const ordLine =
      ordinal === "medallion"
        ? `<div class="ord">${idx != null ? (ORDINAL_WORDS[idx] ?? String(idx + 1)) : ""}</div>`
        : "";
    const sup = idx != null && ordinal === "name" ? `<sup>${ROMAN[idx] ?? idx + 1}</sup>` : "";

    let badge = "";
    if (marks.burnt.has(person.id)) {
      // у газеты знак говорит её голосом
      badge = `<span class="badge"><i>${style === "gazeta" ? "сведения изъяты" : "выжжен из рода"}</i></span>`;
    } else if (marks.hidden.has(person.id)) {
      badge = '<span class="badge calm"><i>скрыт от зрителей</i></span>';
    } else if (marks.linked.has(person.id)) {
      badge = '<span class="badge calm"><i>также в другом роду</i></span>';
    }

    html +=
      `<div class="${classes.join(" ")}" data-id="${person.id}" style="left:${point.x}px;top:${point.y}px;width:${layout.cardWidth}px;height:${layout.cardHeight}px">` +
      `<div class="box">${ordLine}<div class="por"></div>` +
      `<div class="nm">${escapeHtml(cardName(person))}${sup}</div><div class="yr">${escapeHtml(lifeYears(person))}</div>${badge}</div></div>`;
  }
  return html;
}
