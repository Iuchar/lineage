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
  // пустая дата бывает двух родов: год не записан — и год закрыт от этих глаз. Во втором случае
  // на месте годов ничего нет: «неизвестен» было бы неправдой, а «закрыто» — лишним намёком
  if (!birth) return person.dates_closed ? "" : "год неизвестен";
  return death ? `${birth} — ${death}` : birth;
}

/** Склеивает подпись через точку, пропуская пустое: закрытые годы не оставляют повисший разделитель. */
export function dotted(...parts: (string | null | undefined)[]): string {
  return parts.filter(Boolean).join(" · ");
}

/** «до 31 октября 2026», а в последнюю неделю — ещё и сколько дней осталось. Дни считаются по календарю:
 *  срок кончается шестого, сегодня первое — осталось пять дней, который бы ни был час. */
export function untilText(iso: string, now = Date.now()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const day = date.toLocaleDateString("ru", { day: "numeric", month: "long", year: "numeric" }).replace(" г.", "");
  if (date.getTime() <= now) return `закончился ${day}`;
  const midnight = (ms: number) => new Date(ms).setHours(0, 0, 0, 0);
  const left = Math.round((midnight(date.getTime()) - midnight(now)) / 86_400_000);
  if (left > 7) return `до ${day}`;
  if (left === 0) return `до ${day} · заканчивается сегодня`;
  const word = left === 1 ? "день" : left <= 4 ? "дня" : "дней";
  return `до ${day} · ${left === 1 ? "остался" : "осталось"} ${left} ${word}`;
}
