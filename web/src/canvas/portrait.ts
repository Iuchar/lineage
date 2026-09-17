// Заглушка портрета — вырезной профиль, как на старых силуэтных портретах. Рисуется, когда портреты включены,
// а снимка у человека нет. Причёска по полу, тон по идентификатору, чтобы соседние карточки не были одинаковыми.

import type { TreePerson } from "../api/types";

const TONES = [
  ["#d9c7a4", "#3a2c20"], ["#cfc0a6", "#2f2a24"], ["#d6c3a8", "#40302a"],
  ["#cdbd9d", "#33291d"], ["#d4c6ab", "#2d2620"],
] as const;

const FACE =
  "M10 96C12 82 22 76 32 72L32 66C24 62 20 52 21 40C22 24 32 14 44 14C54 14 60 22 60 32C60 36 59 38 61 42L64 47C65 48 63 49 61 49L60 52C61 53 60 54 59 55C60 57 59 59 57 59C55 62 52 64 48 64L46 70C56 74 66 80 70 96Z";

export function silhouette(person: TreePerson): string {
  const [bg, ink] = TONES[person.id % TONES.length]!;
  const hair =
    person.sex === "F"
      ? `<circle cx="23" cy="31" r="10" fill="${ink}"/><path d="M21 38C20 22 30 12 44 12C54 12 60 18 61 26C52 20 36 22 26 42Z" fill="${ink}"/>`
      : `<path d="M21 38C21 22 31 12 44 12C54 12 60 18 60 25C50 21 36 24 25 44Z" fill="${ink}"/>`;
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 96">' +
    `<defs><radialGradient id="g" cx=".45" cy=".4" r=".75"><stop offset="0" stop-color="#f4ead6"/><stop offset="1" stop-color="${bg}"/></radialGradient></defs>` +
    `<rect width="80" height="96" fill="url(#g)"/><path d="${FACE}" fill="${ink}"/>${hair}</svg>`;
  return `url('data:image/svg+xml,${encodeURIComponent(svg)}')`;
}
