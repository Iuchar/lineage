// Память на один заход. Что человек настроил — ширины панелей, порядок списка, открытая легенда, —
// переживает перезагрузку страницы, но не закрытие браузера: открыл заново — всё исходное.
// Долгой памяти у интерфейса нет намеренно.

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
