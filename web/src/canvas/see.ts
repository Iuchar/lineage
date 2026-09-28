// Уровни видимости: те же ключи, что у сервера (app/gedcom/meta.py).

export type See = "all" | "clan" | "hidden";

export const SEE_NAMES: Record<See, string> = {
  all: "общее",
  clan: "родовое",
  hidden: "скрытое",
};

// знак уровня: чем плотнее ромб, тем уже круг тех, кому видно
export const SEE_SIGNS: Record<See, string> = { all: "◇", clan: "◈", hidden: "◆" };
