// Вид карты: масштаб и сдвиг. Чистая математика, без DOM.

export interface View {
  k: number;
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export const MIN_ZOOM = 0.15;
export const MAX_ZOOM = 2.5;
// «100 %» на экране — этот масштаб полотна: прежняя единица мельчила
export const ZOOM_BASE = 0.8;
export const ZOOM_STEP = 10; // шаг кнопок, в процентах экрана

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

export const zoomPercent = (k: number): number => Math.round((k / ZOOM_BASE) * 100);
export const zoomFromPercent = (percent: number): number => clamp((percent / 100) * ZOOM_BASE, MIN_ZOOM, MAX_ZOOM);

// точка под курсором остаётся на месте
export function zoomAt(view: View, cx: number, cy: number, factor: number): View {
  const k = clamp(view.k * factor, MIN_ZOOM, MAX_ZOOM);
  const r = k / view.k;
  return { k, x: cx - (cx - view.x) * r, y: cy - (cy - view.y) * r };
}

export function fitAll(content: Size, viewport: Size): View {
  const k = clamp(
    Math.min((viewport.width - 40) / content.width, (viewport.height - 40) / content.height),
    MIN_ZOOM,
    MAX_ZOOM,
  );
  return { k, x: (viewport.width - content.width * k) / 2, y: (viewport.height - content.height * k) / 2 };
}

// поставить точку полотна в центр экрана при текущем масштабе
export function centreOn(view: View, point: { x: number; y: number }, viewport: Size): View {
  return { k: view.k, x: viewport.width / 2 - point.x * view.k, y: viewport.height / 2 - point.y * view.k };
}

// после перестройки полотна вернуть точку, на которую смотрел человек, под то же место экрана
export function keepAnchor(view: View, before: { x: number; y: number }, after: { x: number; y: number }): View {
  const sx = view.x + before.x * view.k;
  const sy = view.y + before.y * view.k;
  return { k: view.k, x: sx - after.x * view.k, y: sy - after.y * view.k };
}
