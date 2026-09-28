// Первый заход в витрину: заставка на время, пока поднимается ядро, и короткая заметка о том,
// где гость оказался. Заметка показывается один раз на браузер.

const SEEN = "rodoslovnye.witness";

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

/** Заметка о витрине: чем она отличается от настоящего сервера. Один раз на браузер. */
export function witnessNote(host: HTMLElement, editor: { name: string; password: string }): void {
  let seen = false;
  try {
    seen = localStorage.getItem(SEEN) === "yes";
  } catch {
    seen = false; // без хранилища заметка покажется снова, беды нет
  }
  if (seen) return;

  const box = document.createElement("div");
  box.className = "witness";
  box.innerHTML =
    "<b>Это показ инструмента</b>" +
    "<p>Всё работает по-настоящему: смотрите деревья, правьте, загружайте свой файл .ged и выгружайте обратно. " +
    "Только ядро здесь работает не на сервере, а прямо в вашем браузере.</p>" +
    `<p>Данные лежат в этом браузере и никуда не уходят: ни ко мне, ни к другим гостям. Чтобы посмотреть правку, ` +
    `войдите именем <b>${editor.name}</b> и паролем <b>${editor.password}</b>.</p>` +
    "<p>На настоящем сервере тот же инструмент раздаёт ссылки семьям и хранит общее дерево; здесь ссылки " +
    "зрителям показаны устройством, но открыть их некому.</p>" +
    '<button type="button">Понятно</button>';
  box.querySelector("button")?.addEventListener("click", () => {
    box.remove();
    try {
      localStorage.setItem(SEEN, "yes");
    } catch {
      // не запомнилось — покажем ещё раз, это не страшно
    }
  });
  host.append(box);
}
