import "./styles/app.css";
import "./styles/cards.css";
import "./styles/gobelen.css";
import "./styles/viktorian.css";
import "./styles/gazeta.css";
import "./styles/kabinet.css";
import "./styles/polotno.css";
import "./styles/ruler.css";
import "./styles/panel.css";

import type { ClanSummary, ClanTree } from "./api/types";
import { TreeCanvas } from "./canvas/canvas";
import { demoMarks } from "./demo";
import { PersonPanel } from "./panel/panel";
import { SearchBox } from "./panel/search";
import type { StyleName } from "./layout/metrics";

const STYLES: [StyleName, string][] = [
  ["gobelen", "Гобелен"],
  ["viktorian", "Викторианский"],
  ["gazeta", "Газета"],
  ["kabinet", "Ночной кабинет"],
  ["polotno", "Полотно II"],
];

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return (await response.json()) as T;
}

function switcher<T extends string | number>(
  label: string,
  options: [T, string][],
  current: T,
  onPick: (value: T) => void,
): HTMLElement {
  const group = document.createElement("div");
  group.className = "grp";
  group.innerHTML = `<b>${label}</b>`;
  const row = document.createElement("div");
  row.className = "sw";
  for (const [value, text] of options) {
    const button = document.createElement("button");
    button.textContent = text;
    button.setAttribute("aria-pressed", String(value === current));
    button.addEventListener("click", () => {
      row.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b === button)));
      onPick(value);
    });
    row.append(button);
  }
  group.append(row);
  return group;
}

async function start(root: HTMLElement): Promise<void> {
  document.body.dataset.style = "gobelen";
  document.body.dataset.theme = "dark";

  const bar = document.createElement("div");
  bar.className = "bar";
  const stage = document.createElement("div");
  stage.className = "stage";
  root.append(bar, stage);

  const clans = await getJson<ClanSummary[]>("/api/clans");
  if (!clans.length) {
    stage.innerHTML =
      '<div class="empty">Родов пока нет. Загрузите файл командой<br><code>uv run --project server rodoslovnye import ФАЙЛ.ged --name "Род"</code></div>';
    return;
  }

  const canvas = new TreeCanvas(stage);
  let tree: ClanTree | null = null;

  const focus = (id: number) => {
    canvas.select(id);
    canvas.goToSelected();
  };
  const panel = new PersonPanel(stage, {
    select: focus,
    centre: () => canvas.goToSelected(),
    nudge: (id, direction) => {
      canvas.nudge(id, direction);
      if (tree) void panel.show(tree, id);
    },
    manualOffset: (id) => canvas.manual.get(id) ?? 0,
  });
  canvas.onSelect = (id) => {
    if (tree && id != null) void panel.show(tree, id);
    else panel.clear();
  };
  const search = new SearchBox(focus);

  const loadClan = async (id: number) => {
    tree = await getJson<ClanTree>(`/api/clans/${id}/tree`);
    search.setTree(tree);
    canvas.setTree(tree, demoMarks(tree));
    stat.textContent = `${tree.persons.length} человек · ${tree.families.length} семей`;
  };

  const zoomValue = document.createElement("button");
  zoomValue.title = "Сбросить к 100%";
  zoomValue.addEventListener("click", () => canvas.resetZoom());
  canvas.onViewChange = (view) => {
    zoomValue.textContent = `${Math.round(view.k * 100)}%`;
  };

  const viewGroup = document.createElement("div");
  viewGroup.className = "grp";
  viewGroup.innerHTML = "<b>Вид</b>";
  const zoomRow = document.createElement("div");
  zoomRow.className = "sw";
  const button = (text: string, title: string, action: () => void) => {
    const b = document.createElement("button");
    b.textContent = text;
    b.title = title;
    b.addEventListener("click", action);
    return b;
  };
  zoomRow.append(
    button("−", "Отдалить", () => canvas.zoomBy(1 / 1.25)),
    zoomValue,
    button("+", "Приблизить", () => canvas.zoomBy(1.25)),
  );
  const placeRow = document.createElement("div");
  placeRow.className = "sw";
  placeRow.append(button("Целиком", "Показать род целиком", () => canvas.fit()), button("К выбранному", "Центр на выбранном", () => canvas.goToSelected()));
  viewGroup.append(zoomRow, placeRow);

  const rulerLabel = document.createElement("label");
  rulerLabel.className = "chk";
  rulerLabel.innerHTML = '<input type="checkbox"> линейка дат';
  rulerLabel.querySelector("input")!.addEventListener("change", (e) => {
    canvas.update({ ruler: (e.target as HTMLInputElement).checked });
  });

  const stat = document.createElement("div");
  stat.className = "hint";

  bar.append(
    switcher("Род", clans.map((c) => [c.id, `${c.name} · ${c.persons}`]), clans[0]!.id, (id) => void loadClan(id)),
    search.element,
    switcher("Стиль", STYLES, "gobelen", (style) => {
      document.body.dataset.style = style;
      canvas.update({ style });
    }),
    switcher("Тема", [["dark", "Тёмная"], ["light", "Светлая"]], "dark", (theme) => {
      document.body.dataset.theme = theme;
      canvas.render();
    }),
    viewGroup,
    switcher("Основатель", [["top", "сверху"], ["bottom", "снизу"]], "top", (side) => {
      canvas.update({ rootAtBottom: side === "bottom" });
    }),
    rulerLabel,
    stat,
  );

  await loadClan(clans[0]!.id);
}

const root = document.getElementById("app");
if (root) {
  start(root).catch((error: unknown) => {
    root.innerHTML = `<div class="empty">Не удалось загрузить роды: ${String(error)}</div>`;
  });
}
