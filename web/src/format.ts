// Подписи на карточках: имя и годы жизни по-русски. Неточное остаётся неточным.

import type { LifeDate, TreePerson } from "./api/types";

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

// Заглушка «ветка уходит дальше» подписывается как пометка: «ветвь Кинкейд», «потомки Данбар».
export function cardName(person: TreePerson): string {
  if (person.is_branch_stub) {
    return [person.given?.toLowerCase(), person.surname].filter(Boolean).join(" ");
  }
  return person.given ?? person.surname ?? "без имени";
}

export function formatDate(date: LifeDate | null): string | null {
  if (!date || date.kind === null) return null;
  const start = date.year;
  const end = date.end_year;
  switch (date.kind) {
    case "exact":
      return start != null ? String(start) : null;
    case "about":
    case "calculated":
    case "estimated":
      return start != null ? `≈ ${start}` : null;
    case "before":
      return start != null ? `до ${start}` : null;
    case "after":
      return start != null ? `после ${start}` : null;
    case "between":
    case "period":
      return start != null && end != null ? `${start}–${end}` : null;
    case "from":
      return start != null ? `с ${start}` : null;
    case "to":
      return end != null ? `по ${end}` : null;
    case "interpreted":
      return start != null ? String(start) : null;
    default:
      return date.raw; // фраза или нераспознанное — как в файле
  }
}

export function lifeYears(person: TreePerson): string {
  const birth = formatDate(person.birth);
  const death = formatDate(person.death);
  if (!birth) return "год неизвестен";
  return death ? `${birth} — ${death}` : birth;
}
