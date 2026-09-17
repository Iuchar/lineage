// Метки человека: цветные ярлыки произвольного набора. Цвет выбирается из палитры, а не любой:
// произвольный цвет легко даёт метку, невидимую на одном из двух фонов.

export interface Tag {
  id: string;
  name: string;
  color: TagColor;
}

export type TagColor = keyof typeof TAG_COLORS;

export const TAG_COLORS = {
  синий: "#3f6fa8",
  винный: "#a8433b",
  зелёный: "#5f8a45",
  охра: "#b98f22",
  лиловый: "#6b4f9a",
  морской: "#2f7f86",
  кирпичный: "#a9622a",
  дымный: "#56708a",
} as const;

export const MAX_ON_CARD = 4; // дальше «+N»

export interface TagSet {
  list: Tag[]; // все метки рода, в порядке создания
  of: ReadonlyMap<number, string[]>; // человек → идентификаторы его меток
}

export const NO_TAGS: TagSet = { list: [], of: new Map() };
