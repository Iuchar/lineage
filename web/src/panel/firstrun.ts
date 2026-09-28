// Первый заход в витрину: заставка на время, пока поднимается ядро.

export interface Splash {
  say: (text: string) => void;
  close: () => void;
}

/** Заставка: имя инструмента и строка состояния вместо пустого экрана на пять секунд. */
export function splash(host: HTMLElement): Splash {
  const box = document.createElement("div");
  box.className = "splash";
  box.innerHTML = '<b>Родословные</b><i>инструмент работает прямо в браузере</i><span class="step">…</span>';
  host.append(box);
  const step = box.querySelector<HTMLElement>(".step");
  return {
    say: (text) => {
      if (step) step.textContent = `${text}…`;
    },
    close: () => box.remove(),
  };
}
