// Поведение окна поверх страницы: фокус не уходит за окно, а после закрытия возвращается туда, откуда открыли.

const REACH = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export interface DialogHold {
  release: () => void;
}

/** Пометить элемент окном и удержать в нём фокус. Заголовком служит первый <b> внутри. */
export function holdDialog(element: HTMLElement, label: string): DialogHold {
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  element.setAttribute("role", "dialog");
  element.setAttribute("aria-modal", "true");
  element.setAttribute("aria-label", label);
  const trap = (e: KeyboardEvent) => {
    if (e.key !== "Tab") return;
    const reach = [...element.querySelectorAll<HTMLElement>(REACH)].filter((el) => !el.hidden && el.offsetParent !== null);
    const first = reach[0];
    const last = reach[reach.length - 1];
    if (!first || !last) return;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };
  element.addEventListener("keydown", trap);
  return {
    release: () => {
      element.removeEventListener("keydown", trap);
      opener?.focus();
    },
  };
}
