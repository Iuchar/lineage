// Карточки людей в HTML. Оформление целиком в CSS стиля, здесь только разметка и состояния.

import type { ClanLink, ClanTree } from "../api/types";
import { cardName, escapeHtml, lifeYears } from "../format";
import { silhouette } from "./portrait";
import { MAX_ON_CARD, NO_TAGS, TAG_COLORS, type TagSet } from "./tags";
import type { FoldInfo } from "../layout/fold";
import { type LayoutResult, primaryFamilies } from "../layout/layout";
import type { StyleName } from "../layout/metrics";
import type { FoldAnchor } from "./links";
import { LINK_STYLES, ORDINAL_WORDS, ROMAN } from "./styles";

export interface PersonMarks {
  burnt: ReadonlySet<number>; // выжжен из рода
  hidden: ReadonlySet<number>; // скрыт от зрителей — редактор видит с пометкой
}

export const NO_MARKS: PersonMarks = { burnt: new Set(), hidden: new Set() };

export interface CardExtras {
  portraits: boolean; // портреты включены; снимка нет — рисуется заглушка
  photos?: ReadonlyMap<number, string>; // адрес снимка человека, когда он есть
  noPortrait?: ReadonlySet<number>; // у этих людей портрет выключен поштучно
  tags?: TagSet;
  filter?: string | null; // выбранная метка: её люди в полную силу, остальные в тени
  heirs?: ReadonlySet<number>; // люди на главной линии рода — имя акцентом
  broken?: number | null; // последний на линии, если детей у него нет: линия пресеклась
  links?: ReadonlyMap<number, readonly ClanLink[]>; // двойники в других родах — сноска «также в …» под именем
}

export const NO_EXTRAS: CardExtras = { portraits: false };

// метки разбора перезалива: живут, пока идёт разбор, и не берут цвет «выжжен»
export type ReviewMark = "new" | "mod" | "gone";
const REVIEW_TEXT: Record<ReviewMark, string> = { new: "новый", mod: "изменён", gone: "нет в файле" };

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
  lineage?: ReadonlySet<number>, // люди на подсвеченной линии рода
  review?: ReadonlyMap<number, ReviewMark>,
  extras: CardExtras = NO_EXTRAS,
): string {
  const tags = extras.tags ?? NO_TAGS;
  const color = new Map(tags.list.map((t) => [t.id, TAG_COLORS[t.color]]));
  const ordinal = LINK_STYLES[style].ordinal;
  const order = marriageOrder(tree);
  const fostered = fosteredKids(tree);
  let html = "";
  for (const person of tree.persons) {
    const point = layout.positions.get(person.id)!;
    const classes = ["node"];
    if (person.id === selected) classes.push("sel");
    if (lineage?.has(person.id)) classes.push("lin");
    const reviewed = review?.get(person.id);
    if (reviewed) classes.push(`up-${reviewed}`);

    // портрет: снимок или заглушка-профиль; у заглушек «Ветвь» портрета нет
    const photo = extras.portraits && !person.is_branch_stub && !extras.noPortrait?.has(person.id)
      ? (extras.photos?.get(person.id) ?? silhouette(person))
      : null;
    if (photo) classes.push("has-por");

    const own = tags.of.get(person.id) ?? [];
    if (extras.filter && own.includes(extras.filter)) classes.push("tagged");
    if (extras.heirs?.has(person.id)) classes.push("heir");
    const shown = own.slice(0, MAX_ON_CARD);
    const rest = own.length - shown.length;
    const tagsHtml = shown.length
      ? `<span class="tags">${shown.map((id) => `<i style="--c:${color.get(id) ?? "#888"}"></i>`).join("")}` +
        `${rest > 0 ? `<small>+${rest}</small>` : ""}</span>`
      : "";
    if (marks.burnt.has(person.id)) classes.push("burnt");
    if (person.is_branch_stub) classes.push("stub");

    const idx = order.get(person.id);
    const ordLine =
      ordinal === "medallion"
        ? `<div class="ord">${idx != null ? (ORDINAL_WORDS[idx] ?? String(idx + 1)) : ""}</div>`
        : "";
    const sup = idx != null && ordinal === "name" ? `<sup>${ROMAN[idx] ?? idx + 1}</sup>` : "";

    let badge = "";
    if (reviewed) {
      badge = `<span class="badge calm"><i>${REVIEW_TEXT[reviewed]}</i></span>`;
    } else if (marks.burnt.has(person.id)) {
      // у газеты знак говорит её голосом
      badge = `<span class="badge"><i>${style === "gazeta" ? "сведения изъяты" : "выжжен из рода"}</i></span>`;
    } else if (extras.broken === person.id) {
      badge = '<span class="badge calm"><i>линия пресеклась</i></span>';
    } else if (marks.hidden.has(person.id)) {
      badge = '<span class="badge calm"><i>скрыт от зрителей</i></span>';
    }
    if (badge) classes.push("badged");
    // строки под именем раскладываются по порядку: знак состояния, сноска связки, метки — классы говорят, что есть
    if (shown.length) classes.push("has-tags");

    // связка — не плашка, а отсылка набором текста: состояния рисуются заливкой, дверь — только буквами
    const twins = extras.links?.get(person.id) ?? [];
    const also = twins.length
      ? `<span class="also" data-person="${person.id}"><i>также в</i> ${escapeHtml(twins[0]!.other.clan_name)}` +
        `${twins.length > 1 ? `<b> +${twins.length - 1}</b>` : ""}</span>`
      : "";
    if (twins.length) classes.push("linked");

    // у газеты метки стоят отдельной строкой под именем, у остальных стилей — своим знаком поверх карточки
    const underName = style === "gazeta" ? tagsHtml : "";
    const overCard = style === "gazeta" ? "" : tagsHtml;
    const porStyle = photo ? ` style="--img:${photo}"` : "";
    // приёмный или под опекой — ярлык над карточкой, спуск к нему пунктиром
    const kind = fostered.get(person.id);
    const pedi = kind ? `<span class="pedi">${PEDIGREE_WORD[kind]?.[person.sex === "F" ? 1 : 0] ?? ""}</span>` : "";
    html +=
      `<div class="${classes.join(" ")}" data-id="${person.id}" style="left:${point.x}px;top:${point.y}px;width:${layout.cardWidth}px;height:${layout.cardHeight}px">${pedi}` +
      `<div class="box">${ordLine}<div class="por"${porStyle}></div>` +
      `<div class="nm">${escapeHtml(cardName(person))}${sup}</div>${underName}` +
      `<div class="yr">${escapeHtml(lifeYears(person))}</div>${badge}${also}${overCard}</div></div>`;
  }
  return html;
}

const PEDIGREE_WORD: Record<string, [string, string]> = { adopted: ["приёмный", "приёмная"], foster: ["под опекой", "под опекой"] };

// кто стоит на карте под приёмной или опекунской семьёй
function fosteredKids(tree: ClanTree): Map<number, string> {
  const primary = primaryFamilies(tree);
  const out = new Map<number, string>();
  for (const family of tree.families) {
    family.children.forEach((id, i) => {
      const kind = family.child_pedigree?.[i] ?? "birth";
      if (kind !== "birth" && primary.get(id) === family.id) out.set(id, kind);
    });
  }
  return out;
}

const CASCADE = 3; // сколько имён детей показывает каскад полотна

// Стопка под свёрнутым союзом. Рамочные стили — стопка карточек, газета — стопка верхних линеек,
// полотно — каскад имён детей. Щелчок по стопке разворачивает ветку.
export function drawFolds(anchors: FoldAnchor[], folds: ReadonlyMap<number, FoldInfo>, style: StyleName): string {
  let html = "";
  for (const anchor of anchors) {
    const fold = folds.get(anchor.family);
    if (!fold) continue;
    const total = `${fold.descendants} в ветке`;
    let inner: string;
    if (style === "polotno") {
      const names = fold.children.slice(0, CASCADE).map((p) => `<span>${escapeHtml(cardName(p))}</span>`).join("");
      const rest = fold.children.length - CASCADE;
      inner = `${names}<small>${rest > 0 ? `ещё ${rest} · ${total}` : total}</small>`;
    } else if (style === "gazeta") {
      inner = `<i></i><i></i><i></i><span>${total}</span><small>свёрнуто</small>`;
    } else {
      inner = `<i></i><i></i><span>${total}</span>`;
    }
    html += `<div class="fold${anchor.up ? " up" : ""}" data-fold="${anchor.family}" title="Развернуть ветку" style="left:${anchor.x}px;top:${anchor.y}px">${inner}</div>`;
  }
  return html;
}
