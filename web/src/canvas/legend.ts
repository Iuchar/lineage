// Знаки легенды: рисуются теми же правилами, что связи и карточки на карте, поэтому у каждого стиля свои.
// Показываются только те знаки, которые в открытом дереве действительно есть.

import type { ClanTree } from "../api/types";
import { parentless } from "../layout/layout";
import { cardHeight, STYLE_METRICS, type StyleName } from "../layout/metrics";
import { LINK_STYLES } from "./styles";

export interface LegendSign {
  key: string;
  title: string;
  note: string;
  symbol: string; // готовая разметка знака
}

export interface LegendFacts {
  heirs: boolean;
  burnt: boolean;
  hidden: boolean;
  folded: boolean;
  links: boolean;
  editing: boolean;
}

const svg = (inner: string) => `<svg class="sym" viewBox="0 0 60 24">${inner}</svg>`;

// карточка под знаком нужна только как подложка разметки: видно один знак, остальное спрятано.
// Знак рисуется в полный размер — иначе шрифт, цвет и толщина линий расходятся с картой
const glyph = (style: StyleName, inner: string, extra: string, scale = 1) => {
  const metrics = STYLE_METRICS[style];
  const height = cardHeight(metrics, 1);
  return `<span class="glyph"><span class="gcanvas canvas" style="transform:scale(${scale})">` +
    `<div class="node has-por ${extra}" style="left:0;top:0;width:${metrics.width}px;height:${height}px">` +
    `<div class="box"><div class="por"></div><div class="nm">Дункан</div><div class="yr">1740 — 1842</div>${inner}</div></div></span></span>`;
};

const thread = (style: StyleName, past: boolean) => {
  const s = LINK_STYLES[style];
  const stroke = style === "gobelen" || style === "polotno" ? "var(--acc)" : "var(--link)";
  const dash = past ? ` stroke-dasharray="${s.pastDash}"` : "";
  const op = past ? ' opacity=".6"' : "";
  let out = `<path d="M4 12H56" stroke="${past ? "var(--link)" : stroke}" stroke-width="${past ? s.width : s.width + 0.5}" fill="none"${dash}${op}/>`;
  if (style === "gobelen") {
    for (let x = 9; x <= 48; x += 12) {
      out += `<path d="M${x} 16l6 -8" stroke="${past ? "#7c8a76" : "var(--acc)"}" stroke-width="${past ? 1.6 : 2.3}" ` +
        `stroke-linecap="round" fill="none"${op}/>`;
    }
    if (!past) out += '<circle cx="30" cy="12" r="3" fill="#e8dcb8"/>';
  } else if (style === "gazeta") {
    out += `<path d="M23 9h14M23 15h14" stroke="var(--link)" stroke-width="1.3" fill="none"${op}/>`;
  } else if (style === "viktorian") {
    out += `<path d="M30 6.5l5.5 5.5-5.5 5.5-5.5-5.5z" fill="var(--acc)"${past ? ' opacity=".85"' : ""}/>`;
  } else if (style === "kabinet") {
    out += `<circle cx="30" cy="12" r="${past ? 3 : 3.4}" fill="${past ? "var(--label-past)" : "var(--acc)"}"${op}/>`;
  } else {
    out += `<circle cx="30" cy="12" r="2" fill="${past ? "var(--mut)" : "var(--acc)"}"${op}/>`;
  }
  return svg(out);
};

const ordinal = (style: StyleName) => {
  if (style === "gobelen") {
    return svg('<text x="30" y="10" text-anchor="middle" fill="#a9b5a0" font-family="Caveat, cursive" font-size="12">второй</text>' +
      '<path d="M4 17H56" stroke="var(--acc)" stroke-width="1.7" fill="none"/>');
  }
  if (style === "gazeta") {
    return svg('<text x="30" y="17" text-anchor="middle" fill="var(--fg)" font-family="Playfair Display, serif" font-weight="700" ' +
      'font-size="13">Имя<tspan font-size="8" fill="var(--acc)" dy="-5">II</tspan></text>');
  }
  if (style === "polotno") {
    return svg('<text x="30" y="9" text-anchor="middle" fill="var(--acc)" font-family="IBM Plex Mono, monospace" font-size="9">02</text>' +
      '<path d="M4 16H56" stroke="var(--acc)" stroke-width="1.5" fill="none"/>');
  }
  return svg('<rect x="22" y="2" width="16" height="12" rx="2" fill="var(--acc)"/>' +
    '<text x="30" y="11" text-anchor="middle" fill="var(--bg)" font-family="IBM Plex Mono, monospace" font-size="8.5">II</text>' +
    `<path d="M4 20H56" stroke="var(--link)" stroke-width="${LINK_STYLES[style].width}" fill="none"/>`);
};

const union = (style: StyleName) =>
  svg(`<path d="M4 12H56" stroke="${style === "gobelen" || style === "polotno" ? "var(--acc)" : "var(--link)"}" ` +
    `stroke-width="${LINK_STYLES[style].width + 0.5}" fill="none"/>` +
    '<circle cx="30" cy="12" r="9" fill="none" stroke="var(--acc)" stroke-width="1.5" stroke-dasharray="3 3"/>');

const descent = (style: StyleName, dashed: boolean) => {
  const s = LINK_STYLES[style];
  return svg(`<path d="M14 4H46M30 4v16" stroke="var(--link)" stroke-width="${s.width}" fill="none"` +
    `${dashed ? ' stroke-dasharray="5 4"' : ""}/>` + (s.tip ? `<circle cx="30" cy="20" r="${s.tip}" fill="var(--link)"/>` : ""));
};

const curl = (style: StyleName) =>
  svg(`<path d="M30 2c8 0 8 7 0 7c-8 0-8 7 0 7v6" stroke="var(--link)" stroke-width="${LINK_STYLES[style].width}" ` +
    'fill="none" stroke-linecap="round"/>');

const knot = (style: StyleName) =>
  svg('<circle cx="30" cy="5" r="4.5" fill="var(--bg)" stroke="var(--link)" stroke-width="1.4"/>' +
    `<path d="M30 10v5M14 15H46M18 15v6M42 15v6" stroke="var(--link)" stroke-width="${LINK_STYLES[style].width}" fill="none"/>`);

const heir = () => svg('<text x="30" y="17" text-anchor="middle" fill="var(--acc)" font-size="14">◆</text>');
const trunk = () => svg('<path d="M30 2v20" stroke="var(--acc)" stroke-width="2.4" fill="none"/>');

const fold = (style: StyleName) => {
  const inner = style === "polotno"
    ? "<span>Ангус</span><span>Колин</span><small>ещё 10 · 12 в ветке</small>"
    : style === "gazeta" ? '<i></i><i></i><i></i><span>12 в ветке</span><small>свёрнуто</small>'
      : '<i></i><i></i><span>12 в ветке</span>';
  return '<span class="glyph tall"><span class="gcanvas canvas" style="transform:scale(.8)">' +
    `<div class="fold" data-mark style="left:0;top:0">${inner}</div></span></span>`;
};

// весь список знаков; в легенду попадут только те, что есть в дереве
export function legendSigns(tree: ClanTree, style: StyleName, facts: LegendFacts): LegendSign[] {
  const pairs = tree.families.some((f) => f.husband != null && f.wife != null);
  const many = tree.persons.some((p) => p.spouse_families.length > 1);
  const divorced = tree.families.some((f) => f.divorced);
  const kids = tree.families.some((f) => f.children.length && (f.husband != null || f.wife != null));
  const alone = tree.families.some((f) => f.children.length && (f.husband == null) !== (f.wife == null));
  const fostered = tree.families.some((f) => (f.child_pedigree ?? []).some((k) => k !== "birth"));
  const orphans = tree.families.some(parentless);
  const burntWord = style === "gazeta" ? "сведения изъяты" : "выжжен из рода";

  const all: (LegendSign & { when: boolean })[] = [
    { key: "marriage", title: "Брак", note: "", symbol: thread(style, false), when: pairs },
    { key: "past", title: "Прошлый брак", note: "или развод", symbol: thread(style, true), when: many || divorced },
    { key: "ordinal", title: "Очередь браков", note: "", symbol: ordinal(style), when: many },
    { key: "union", title: "Знак союза", note: "щелчок — карточка семьи", symbol: union(style), when: pairs },
    { key: "descent", title: "Дети", note: "", symbol: descent(style, false), when: kids },
    { key: "curl", title: "Один родитель", note: "второй неизвестен", symbol: curl(style), when: alone },
    { key: "foster", title: "Приёмный", note: "или под опекой", symbol: descent(style, true), when: fostered },
    { key: "knot", title: "Родители неизвестны", note: "братья одной семьи", symbol: knot(style), when: orphans },
    { key: "heir", title: "Продолжатель", note: "", symbol: heir(), when: facts.heirs },
    { key: "trunk", title: "Главная ветвь", note: "", symbol: trunk(), when: facts.heirs },
    {
      key: "burnt", title: "Выжжен из рода", note: "",
      symbol: glyph(style, `<span class="badge" data-mark><i>${burntWord}</i></span>`, "burnt badged"), when: facts.burnt,
    },
    {
      key: "hidden", title: "Скрыт от зрителей", note: "виден только в правке",
      symbol: glyph(style, '<span class="badge calm" data-mark><i>скрыт от зрителей</i></span>', "badged"),
      when: facts.hidden && facts.editing,
    },
    { key: "fold", title: "Свёрнутая ветка", note: "число потомков", symbol: fold(style), when: facts.folded },
    {
      key: "also", title: "Также в роду", note: "переход",
      symbol: glyph(style, '<span class="also" data-mark><i>также в</i> другом роду</span>', "linked"), when: facts.links,
    },
  ];
  return all.filter((sign) => sign.when).map(({ when: _when, ...sign }) => sign);
}

// знак метки рода — такой же, как на карточке этого стиля
export function tagGlyph(style: StyleName, color: string): string {
  return glyph(style, `<span class="tags" data-mark><i style="--c:${color}"></i></span>`, "has-tags");
}

// значок самой легенды — знак нити этого стиля
export function legendBadge(style: StyleName): string {
  const inner = {
    gobelen: '<circle cx="9" cy="9" r="4" fill="#e8dcb8"/>',
    viktorian: '<path d="M9 4l5 5-5 5-5-5z" fill="var(--acc)"/>',
    gazeta: '<path d="M3 6.5h12M3 11.5h12" stroke="var(--acc)" stroke-width="1.6"/>',
    kabinet: '<circle cx="9" cy="9" r="4.2" fill="var(--acc)"/>',
    polotno: '<circle cx="9" cy="9" r="2.6" fill="var(--acc)"/>',
  }[style];
  return `<svg class="lgBadge" width="18" height="18" viewBox="0 0 18 18">${inner}</svg>`;
}

// знак в окошке ставится по месту: подложка двигается так, чтобы знак оказался в середине.
// Заодно меряется самый широкий знак — по нему панель задаёт ширину окошка
export function placeGlyphs(root: HTMLElement): number {
  let widest = 0;
  for (const box of root.querySelectorAll<HTMLElement>(".glyph")) {
    const mark = box.querySelector<HTMLElement>("[data-mark]");
    const canvas = box.querySelector<HTMLElement>(".gcanvas");
    if (!mark || !canvas) continue;
    const scale = Number(/scale\(([\d.]+)\)/.exec(canvas.style.transform)?.[1] ?? 1);
    const outer = box.getBoundingClientRect();
    const at = mark.getBoundingClientRect();
    widest = Math.max(widest, at.width);
    // окошко под знак ровно по нему самому: в потоке колонок нет, и общая ширина только
    // отодвигала бы подпись от мелких знаков
    box.style.setProperty("--gw", `${Math.ceil(at.width) + 6}px`);
    // сдвиг накапливается: знак уже стоит со старым сдвигом, считается только поправка
    const dx = Number(canvas.dataset.dx ?? 0) + (outer.left + outer.width / 2 - (at.left + at.width / 2)) / scale;
    const dy = Number(canvas.dataset.dy ?? 0) + (outer.top + outer.height / 2 - (at.top + at.height / 2)) / scale;
    canvas.dataset.dx = String(dx);
    canvas.dataset.dy = String(dy);
    canvas.style.transform = `scale(${scale}) translate(${dx}px,${dy}px)`;
  }
  return widest;
}
