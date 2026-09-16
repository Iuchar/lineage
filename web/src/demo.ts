// Только для разработки: адрес с ?demo=marks ставит те же пометки, что были на стенде,
// чтобы сверить знаки «выжжен», «скрыт» и «также в другом роду» во всех стилях.
// В данных рода этих состояний пока нет — они появятся с редактором и доступом.

import type { ClanTree } from "./api/types";
import { NO_MARKS, type PersonMarks } from "./canvas/cards";

const STAND_MARKS: Record<string, { burnt: string; hidden: string; linked: string }> = {
  "Монад Кройве": { burnt: "@I524@", hidden: "@I531@", linked: "@I57@" },
  "Гленн Уриск": { burnt: "@I1008@", hidden: "@I1009@", linked: "@I1004@" },
};

export function demoMarks(tree: ClanTree): PersonMarks {
  if (new URLSearchParams(location.search).get("demo") !== "marks") return NO_MARKS;
  const sample = STAND_MARKS[tree.clan.name];
  if (!sample) return NO_MARKS;
  const id = (xref: string) => tree.persons.filter((p) => p.xref === xref).map((p) => p.id);
  return { burnt: new Set(id(sample.burnt)), hidden: new Set(id(sample.hidden)), linked: new Set(id(sample.linked)) };
}
