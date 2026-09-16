// Геометрия карточки у каждого стиля своя: ширина, зазор внутри пары (его диктует почерк связи),
// шаг ярусов и уровни линий браков, от которых зависит высота карточки.

export type StyleName = "gobelen" | "viktorian" | "gazeta" | "kabinet" | "polotno";

export interface CardMetrics {
  width: number;
  minHeight: number;
  pairGap: number;
  tierGap: number;
  firstMarriageLevel: number;
  marriageLevelStep: number;
  bottomPad: number;
}

export const STYLE_METRICS: Record<StyleName, CardMetrics> = {
  gobelen: { width: 104, minHeight: 126, pairGap: 46, tierGap: 96, firstMarriageLevel: 38, marriageLevelStep: 20, bottomPad: 22 },
  viktorian: { width: 150, minHeight: 64, pairGap: 46, tierGap: 104, firstMarriageLevel: 20, marriageLevelStep: 26, bottomPad: 16 },
  gazeta: { width: 150, minHeight: 58, pairGap: 46, tierGap: 104, firstMarriageLevel: 12, marriageLevelStep: 16, bottomPad: 44 },
  kabinet: { width: 150, minHeight: 60, pairGap: 46, tierGap: 104, firstMarriageLevel: 20, marriageLevelStep: 26, bottomPad: 14 },
  polotno: { width: 150, minHeight: 68, pairGap: 46, tierGap: 110, firstMarriageLevel: -6, marriageLevelStep: 18, bottomPad: 34 },
};

// Высота карточки — ровно под уровни линий самого многобрачного человека рода, но не ниже текста.
export function cardHeight(metrics: CardMetrics, maxMarriages: number): number {
  const levels = Math.max(1, maxMarriages);
  return Math.max(
    metrics.minHeight,
    metrics.firstMarriageLevel + (levels - 1) * metrics.marriageLevelStep + metrics.bottomPad,
  );
}
