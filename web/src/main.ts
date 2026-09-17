import "./styles/app.css";
import "./styles/cards.css";
import "./styles/gobelen.css";
import "./styles/viktorian.css";
import "./styles/gazeta.css";
import "./styles/kabinet.css";
import "./styles/polotno.css";
import "./styles/fold.css";
import "./styles/ruler.css";
import "./styles/panel.css";
import "./styles/upload.css";

import type { ClanSummary, ClanTree } from "./api/types";
import { NO_MARKS } from "./canvas/cards";
import { TreeCanvas } from "./canvas/canvas";
import { demoMarks } from "./demo";
import { PersonPanel } from "./panel/panel";
import { SearchBox } from "./panel/search";
import { UploadFlow } from "./upload/upload";
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

  let clans = await getJson<ClanSummary[]>("/api/clans");
  if (!clans.length) {
    // родов нет — только загрузка; после создания первого рода страница собирается заново
    const upload = new UploadFlow(stage, { created: () => location.reload(), review: () => {}, finished: () => {}, focus: () => {} });
    const add = document.createElement("button");
    add.className = "add";
    add.textContent = "+ Загрузить .ged";
    add.addEventListener("click", () => upload.choose());
    const group = document.createElement("div");
    group.className = "grp";
    group.innerHTML = '<b>Род</b><div class="sw"></div>';
    group.querySelector(".sw")!.append(add);
    bar.append(group);
    stage.insertAdjacentHTML("afterbegin", '<div class="empty">Родов пока нет — загрузите файл .ged</div>');
    return;
  }

  const canvas = new TreeCanvas(stage);
  let tree: ClanTree | null = null;

  const focus = (id: number) => {
    canvas.reveal(id);
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
    toggleFold: (familyId) => canvas.toggleFold(familyId),
    isFolded: (familyId) => canvas.folded.has(familyId),
  });
  // панель показывает, свёрнута ли ветка, — перерисовать после щелчка по стопке на карте
  canvas.onFoldChange = () => {
    if (tree && canvas.selected != null) void panel.show(tree, canvas.selected);
  };
  canvas.onSelect = (id) => {
    if (upload.reviewing) return upload.highlight(id); // в разборе панель занята сводкой
    if (tree && id != null) void panel.show(tree, id);
    else panel.clear();
  };
  const search = new SearchBox(focus);

  let currentClan = clans[0]!.id;
  let beforeReview = currentClan; // куда вернуться, если разбор отменён
  const loadClan = async (id: number) => {
    currentClan = id;
    tree = await getJson<ClanTree>(`/api/clans/${id}/tree`);
    search.setTree(tree);
    canvas.setTree(tree, demoMarks(tree));
    stat.textContent = `${tree.persons.length} человек · ${tree.families.length} семей`;
  };

  const upload = new UploadFlow(stage, {
    created: async (clan) => {
      clans = await getJson<ClanSummary[]>("/api/clans");
      drawClanTabs(clan.id);
      await loadClan(clan.id);
    },
    review: (preview, marks) => {
      beforeReview = currentClan;
      panel.element.hidden = true;
      tree = preview.tree;
      search.setTree(preview.tree);
      canvas.setTree(preview.tree, NO_MARKS, marks);
      stat.textContent = "разбор файла · карта из нового файла";
      const first = marks.keys().next();
      if (!first.done) canvas.centreOnPerson(first.value); // сразу к первому изменению
    },
    finished: async (clanId, report) => {
      panel.element.hidden = false;
      const target = report ? clanId : beforeReview;
      clans = await getJson<ClanSummary[]>("/api/clans");
      drawClanTabs(target);
      await loadClan(target);
      if (report) {
        stat.textContent += ` · перезалито: добавлено ${report.added}, изменено ${report.changed}, удалено ${report.deleted}`;
      }
    },
    focus: (id) => canvas.centreOnPerson(id),
  });

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

  // вкладки родов и кнопка загрузки; перерисовываются, когда родов или людей в них становится больше
  const clanTabs = document.createElement("div");
  const drawClanTabs = (current: number) => {
    const group = switcher("Род", clans.map((c) => [c.id, `${c.name} · ${c.persons}`]), current, (id) => {
      if (upload.reviewing) {
        upload.cancel(false);
        panel.element.hidden = false;
      }
      void loadClan(id);
    });
    const add = document.createElement("button");
    add.className = "add";
    add.textContent = "+ Загрузить .ged";
    add.addEventListener("click", () => upload.choose());
    group.querySelector(".sw")!.append(add);
    clanTabs.replaceChildren(group);
  };
  drawClanTabs(currentClan);

  bar.append(
    clanTabs,
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
