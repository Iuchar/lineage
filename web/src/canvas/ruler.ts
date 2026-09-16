// Линейка дат: накладка поверх карты слева, едет вместе с ней по вертикали.
// Двойная: деления по годам и рядом полосы поколений — пересечение поколений видно.

import type { LayoutResult, RulerLayout } from "../layout/layout";
import type { View } from "./view";

// Год → координата полотна. Шкала кусочно-линейная: медиана поколения всегда напротив своего яруса.
export function yearToCanvas(ruler: RulerLayout, year: number): number {
  const points = ruler.generations
    .filter((g) => ruler.median.get(g) != null)
    .map((g) => ({ year: ruler.median.get(g)!, y: ruler.rowY.get(g)! }));
  if (!points.length) return 0;
  const direction = points.length > 1 && points[points.length - 1]!.y < points[0]!.y ? -1 : 1;
  const first = points[0]!;
  if (year <= first.year) return first.y - (first.year - year) * ruler.scale * direction;
  for (let i = 1; i < points.length; i++) {
    const b = points[i]!;
    if (year <= b.year) {
      const a = points[i - 1]!;
      return a.y + ((year - a.year) * (b.y - a.y)) / (b.year - a.year);
    }
  }
  const last = points[points.length - 1]!;
  return last.y + (year - last.year) * ruler.scale * direction;
}

// шаг делений прореживается по зуму: подписи не сходятся ближе 26 пикселей
export function tickStep(scale: number, zoom: number): number {
  return [5, 10, 20, 25, 50, 100, 200].find((step) => step * scale * zoom >= 26) ?? 200;
}

export function drawRuler(
  layout: LayoutResult,
  view: View,
  viewportHeight: number,
  selectedGeneration: number | null,
): string {
  const ruler = layout.ruler;
  if (!ruler) return "";
  const screen = (y: number) => view.y + y * view.k;
  const ranges = ruler.generations.map((g) => ruler.range.get(g)).filter((r) => r != null);
  const lo = Math.min(...ranges.map((r) => r.min));
  const hi = Math.max(...ranges.map((r) => r.max));
  const H = viewportHeight;
  const step = tickStep(ruler.scale, view.k);

  let html = "";
  const a0 = screen(yearToCanvas(ruler, lo));
  const a1 = screen(yearToCanvas(ruler, hi));
  html += `<div class="axis" style="top:${Math.min(a0, a1).toFixed(1)}px;height:${Math.abs(a1 - a0).toFixed(1)}px"></div>`;

  for (let year = Math.ceil(lo / step) * step; year <= hi; year += step) {
    const y = screen(yearToCanvas(ruler, year));
    if (y < -20 || y > H + 20) continue;
    const big = year % (step * 5) === 0 || year % 100 === 0;
    html +=
      `<div class="tick${big ? " big" : ""}" style="top:${y.toFixed(1)}px"></div>` +
      `<div class="yr${big ? " big" : ""}" style="top:${y.toFixed(1)}px">${year}</div>`;
  }

  for (const g of ruler.generations) {
    const range = ruler.range.get(g);
    const column = 78 + (g % 2 ? 0 : 16); // соседние поколения в разных колонках
    const on = g === selectedGeneration;
    const labelY = screen(ruler.rowY.get(g)! + layout.cardHeight / 2);
    if (!range) {
      if (labelY > -20 && labelY < H + 20) {
        html += `<div class="glab${on ? " on" : ""}" style="left:${column + 9}px;top:${labelY.toFixed(1)}px">поколение ${g + 1}<small>год неизвестен</small></div>`;
      }
      continue;
    }
    const at = (year: number) => screen(yearToCanvas(ruler, year));
    const band = (from: number, to: number, cls: string) => {
      const top = Math.min(at(from), at(to));
      const height = Math.abs(at(to) - at(from));
      if (top > H + 20 || top + height < -20) return "";
      return `<div class="band ${cls}${on ? " on" : ""}" style="left:${column}px;top:${top.toFixed(1)}px;height:${Math.max(1, height).toFixed(1)}px"></div>`;
    };
    html += band(range.min, range.max, "thin") + band(range.q1, range.q3, ""); // усы до крайних, плотная часть по квартилям
    for (const year of [range.min, range.max]) {
      const y = at(year);
      if (y > -20 && y < H + 20) html += `<div class="cap" style="left:${column - 3}px;top:${y.toFixed(1)}px"></div>`;
    }
    if (labelY > -24 && labelY < H + 24) {
      const years = range.min === range.max ? String(range.min) : `${range.min} – ${range.max}`;
      html += `<div class="glab${on ? " on" : ""}" style="left:${column + 9}px;top:${labelY.toFixed(1)}px">поколение ${g + 1}<small>${years}</small></div>`;
    }
  }
  return html;
}
