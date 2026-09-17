// Только для разработки: адрес с ?demo=marks ставит те же пометки, что были на стенде,
// чтобы сверить знаки «выжжен», «скрыт» и «также в другом роду» во всех стилях.
// В данных рода этих состояний пока нет — они появятся с редактором и доступом.

import type { ClanTree } from "./api/types";
import { NO_MARKS, type PersonMarks } from "./canvas/cards";
import { NO_TAGS, type Tag, type TagSet } from "./canvas/tags";

const STAND_MARKS: Record<string, { burnt: string[]; hidden: string[]; linked: string[] }> = {
  "Монад Кройве": { burnt: ["@I524@", "@I528@"], hidden: ["@I531@"], linked: ["@I57@"] }, // @I528@ — Лаклан
  "Гленн Уриск": { burnt: ["@I1008@"], hidden: ["@I1009@"], linked: ["@I1004@"] },
};

// меток в данных тоже нет: набор придуман, чтобы посмотреть знаки и фильтр в пяти стилях
const DEMO_TAGS: Tag[] = [
  { id: "move", name: "Переселенец", color: "синий" },
  { id: "war", name: "Военный", color: "винный" },
  { id: "chron", name: "Летописец", color: "зелёный" },
  { id: "check", name: "Проверить", color: "охра" },
];
const STAND_TAGS: Record<string, Record<string, string[]>> = {
  "Монад Кройве": { "@I538@": ["war", "check"], "@I555@": ["move"], "@I536@": ["chron"],
    "@I556@": ["move", "war", "chron", "check"], "@I557@": ["move"], "@I526@": ["war"] },
  "Гленн Уриск": { "@I1016@": ["war"], "@I1019@": ["move", "check"], "@I1024@": ["chron"], "@I1029@": ["move"] },
};

export function demoTags(tree: ClanTree): TagSet {
  if (new URLSearchParams(location.search).get("demo") !== "marks") return NO_TAGS;
  const sample = STAND_TAGS[tree.clan.name];
  if (!sample) return NO_TAGS;
  const of = new Map<number, string[]>();
  for (const person of tree.persons) {
    const tags = sample[person.xref];
    if (tags) of.set(person.id, tags);
  }
  return { list: DEMO_TAGS, of };
}

export function demoMarks(tree: ClanTree): PersonMarks {
  if (new URLSearchParams(location.search).get("demo") !== "marks") return NO_MARKS;
  const sample = STAND_MARKS[tree.clan.name];
  if (!sample) return NO_MARKS;
  const id = (xrefs: string[]) => tree.persons.filter((p) => xrefs.includes(p.xref)).map((p) => p.id);
  return { burnt: new Set(id(sample.burnt)), hidden: new Set(id(sample.hidden)), linked: new Set(id(sample.linked)) };
}
