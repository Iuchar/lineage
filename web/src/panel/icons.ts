// Иконки интерфейса одним набором: линия 1,5, без заливки, цвет — от текста рядом.
// Раньше стояли знаки из системного шрифта (⚙ ⌕ ☾ ↶ ‹), и у каждого была своя толщина и свой размер.

const PATHS = {
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.6-3.6"/>',
  view: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  moon: '<path d="M20.5 13.2A8.5 8.5 0 1 1 10.8 3.5a6.6 6.6 0 0 0 9.7 9.7z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M2.5 12h2M19.5 12h2M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
  left: '<path d="m15 18-6-6 6-6"/>',
  right: '<path d="m9 18 6-6-6-6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  more: '<circle cx="5" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="19" cy="12" r="1.3" fill="currentColor"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  tree: '<path d="M12 5.6V10M6 18.4V16a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v2.4M12 10v4"/><circle cx="12" cy="4" r="1.6"/><circle cx="6" cy="20" r="1.6"/><circle cx="18" cy="20" r="1.6"/>',
  person: '<circle cx="12" cy="8" r="3.6"/><path d="M5 20a7 7 0 0 1 14 0"/>',
  out: '<path d="M14 5h5v5M19 5l-8 8M11 7H6v11h11v-5"/>', // ссылка наружу, в новую вкладку
} as const;

export type IconName = keyof typeof PATHS;

/** Разметка иконки. Читалке с экрана она не нужна: имя кнопке даёт подпись или title.
 *  lead — иконка стоит перед подписью и отделяется от неё пробелом. */
export function icon(name: IconName, lead = false): string {
  return `<svg class="ico${lead ? " lead" : ""}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" ` +
    `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name]}</svg>`;
}
