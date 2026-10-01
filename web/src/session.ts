// Память на один заход. Что человек настроил — ширины панелей, порядок списка, открытая легенда, —
// переживает перезагрузку страницы, но не закрытие браузера: открыл заново — всё исходное.
// Долгой памяти у интерфейса нет намеренно.
//
// Спросить у браузера «тебя закрывали?» нельзя, а при восстановлении вкладок он возвращает и cookie,
// и память захода — для страницы это выглядит как обычная перезагрузка. Поэтому заход считаем сами:
// открытая страница раз в несколько секунд ставит отметку, и если при загрузке отметка старше
// трёх минут — страницу закрывали всерьёз, заход новый.

const ALIVE = "rodoslovnye.alive";
const BEAT_MS = 10_000;
export const VISIT_GAP_MS = 3 * 60_000; // столько страница может быть закрыта, оставаясь в том же заходе

/** Тот же это заход или новый — по возрасту последней отметки. Чистая функция: её и проверяют. */
export function isNewVisit(lastBeat: string | null, now: number): boolean {
  const last = Number(lastBeat);
  return !lastBeat || !Number.isFinite(last) || now - last > VISIT_GAP_MS;
}

/** Начать работу страницы: решить, новый ли заход, и дальше ставить отметки. true — заход новый. */
export function beginVisit(): boolean {
  let fresh = true;
  try {
    fresh = isNewVisit(localStorage.getItem(ALIVE), Date.now());
    if (fresh) sessionStorage.clear(); // всё настроенное в прошлый заход — долой
    const beat = () => localStorage.setItem(ALIVE, String(Date.now()));
    beat();
    window.setInterval(beat, BEAT_MS);
    // последняя отметка — в момент ухода: от неё и считается, сколько страница была закрыта
    window.addEventListener("pagehide", beat);
    document.addEventListener("visibilitychange", beat);
  } catch {
    // без хранилища заходы не различить — пусть каждый будет новым
  }
  return fresh;
}

/** Прочитать запомненное в этом заходе; нет хранилища или значения — null. */
export function recall(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null; // без хранилища всё просто встанет по умолчанию
  }
}

/** Запомнить до закрытия браузера. */
export function remember(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    // не запомнилось — после перезагрузки вернётся исходное, беды нет
  }
}

/** Прежние версии держали то же самое в долгой памяти браузера — убрать, чтобы не лежало мёртвым грузом. */
export function dropLongMemory(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // хранилища нет — и убирать нечего
  }
}
