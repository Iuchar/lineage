// Почерк связей у каждого стиля свой: толщина, начертание прошлых союзов, знак на нити брака,
// где подписана очередь союза. Цвета берутся из CSS-переменных стиля.

import type { StyleName } from "../layout/metrics";

export type MarriageMark = "stitch" | "lozenge" | "equals" | "rivet" | "dot";
export type OrdinalPlace = "medallion" | "line" | "name";

export interface LinkStyle {
  width: number;
  pastDash: string;
  marriageDash: string;
  mark: MarriageMark;
  ordinal: OrdinalPlace;
  inset: number; // отступ нити от карточек
  descentGap: number; // зазор между спуском и карточкой
  tip: number; // точка на конце спуска
}

export const LINK_STYLES: Record<StyleName, LinkStyle> = {
  gobelen: { width: 1.2, pastDash: "1 6", marriageDash: "1 3", mark: "stitch", ordinal: "medallion", inset: 0, descentGap: 0, tip: 0 },
  viktorian: { width: 1.2, pastDash: "6 5", marriageDash: "none", mark: "lozenge", ordinal: "line", inset: 0, descentGap: 0, tip: 0 },
  gazeta: { width: 1, pastDash: "4 4", marriageDash: "none", mark: "equals", ordinal: "name", inset: 8, descentGap: 0, tip: 0 },
  kabinet: { width: 1.4, pastDash: "1 5", marriageDash: "none", mark: "rivet", ordinal: "line", inset: 0, descentGap: 0, tip: 0 },
  polotno: { width: 1, pastDash: "2 5", marriageDash: "none", mark: "dot", ordinal: "line", inset: 0, descentGap: 6, tip: 2 },
};

// Высота нити союза внутри карточки: у многобрачного каждый союз своей высотой, ранний выше.
export function marriageLevel(style: StyleName, index: number, top: number, count: number, cardHeight: number): number {
  switch (style) {
    case "gobelen":
      return count > 1 ? top + 38 + index * 20 : top + cardHeight / 2;
    case "viktorian":
    case "kabinet":
      return count > 1 ? top + 20 + index * 26 : top + cardHeight / 2;
    case "gazeta":
      return count > 1 ? top + 12 + index * 16 : top + cardHeight / 2;
    case "polotno":
      return count > 1 ? top - 6 + index * (36 / (count - 1)) : top + 30;
  }
}

export const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII"];
export const ORDINAL_WORDS = ["первый", "второй", "третий", "четвёртый", "пятый", "шестой"];
