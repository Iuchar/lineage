import "./fonts/fonts.css";
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
import "./styles/portrait.css";
import "./styles/tags.css";
import "./styles/links.css";
import "./styles/editor.css";

import type { ClanSummary, ClanTree, LinkPerson, TreePerson } from "./api/types";
import { NO_MARKS } from "./canvas/cards";
import { TreeCanvas } from "./canvas/canvas";
import { demoHeirs, demoMarks, demoTags } from "./demo";
import { LinkNav } from "./links/nav";
import { ManualLink } from "./links/manual";
import { LinkReview } from "./links/review";
import { PersonEditor } from "./editor/form";
import { Journal } from "./editor/journal";
import { RelativeMenu } from "./editor/menu";
import { PersonPanel } from "./panel/panel";
import { SearchBox } from "./panel/search";
import { UploadFlow } from "./upload/upload";
import type { StyleName } from "./layout/metrics";
import { silhouette } from "./canvas/portrait";
import { TAG_COLORS, type TagSet } from "./canvas/tags";

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
  let currentClan = clans[0]!.id;
  const clanName = (id: number) => clans.find((c) => c.id === id)?.name ?? "";
  const fullName = (p: TreePerson) => [p.given, p.surname].filter(Boolean).join(" ") || "без имени";
  const brief = (p: TreePerson): LinkPerson => ({
    id: p.id, clan_id: currentClan, clan_name: clanName(currentClan), name: fullName(p),
    born: p.birth?.year ?? null, died: p.death?.year ?? null,
  });

  // связки: сноска на карте и строка в панели ведут в другой род, лента над картой — обратно
  const nav = new LinkNav(stage, {
    goTo: async (clanId, personId) => {
      drawClanTabs(clanId);
      await loadClan(clanId);
      arrive(personId);
    },
    changed: () => void refreshLinks(),
  });
  const refreshLinks = async () => {
    canvas.setLinks(await nav.load(currentClan));
    if (tree && canvas.selected != null) void panel.show(tree, canvas.selected);
    void countQueue();
  };
  const manual = new ManualLink(stage, { linked: () => void refreshLinks() });

  // очередь связок: пары с одинаковым именем и годом рождения ждут решения человека
  const trees = new Map<number, Promise<ClanTree>>();
  const treeOf = (clanId: number) => {
    if (!trees.has(clanId)) trees.set(clanId, getJson<ClanTree>(`/api/clans/${clanId}/tree`));
    return trees.get(clanId)!;
  };
  const review = new LinkReview(stage, {
    tree: treeOf,
    show: async (clanId, personId) => {
      if (clanId !== currentClan) {
        drawClanTabs(clanId);
        await loadClan(clanId);
      }
      arrive(personId);
    },
    style: () => canvas.state.style,
    portraits: () => canvas.portraits,
    opened: () => {
      panel.element.hidden = true;
    },
    closed: () => {
      panel.element.hidden = false;
      if (tree && canvas.selected != null) void panel.show(tree, canvas.selected);
    },
    decided: () => void refreshLinks(),
  });
  const queueBtn = document.createElement("button");
  queueBtn.className = "queueBtn";
  queueBtn.title = "Проверить пары с одинаковым именем и годом рождения";
  queueBtn.addEventListener("click", () => void review.open());
  const queueGroup = document.createElement("div");
  queueGroup.className = "grp";
  queueGroup.innerHTML = '<b>Связки</b><div class="sw"></div>';
  queueGroup.querySelector(".sw")!.append(queueBtn);
  queueGroup.hidden = true;
  const countQueue = async () => {
    const count = await review.count();
    queueGroup.hidden = count === 0 && !review.reviewing;
    queueBtn.innerHTML = count ? `Проверить<b>${count}</b>` : "Очередь пуста";
  };
  const openLink = (personId: number, index = 0) => {
    const link = nav.linksOf(personId)[index];
    const person = tree?.persons.find((p) => p.id === personId);
    if (!link || !person) return;
    void nav.open(link, { clanId: currentClan, clanName: clanName(currentClan), personName: fullName(person) });
  };
  // сноска на карте: одна связка — сразу туда, несколько — выбрать человека, строки связок в панели
  canvas.onLinkOpen = (personId) => {
    if (nav.linksOf(personId).length > 1) focus(personId);
    else openLink(personId);
  };

  // прийти к человеку из другого рода: карта открылась целиком, её надо приблизить, иначе его не найти
  const arrive = (id: number) => {
    canvas.reveal(id);
    canvas.select(id);
    canvas.centreOnPerson(id);
  };
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
    portrait: (person) =>
      canvas.portraits && !person.is_branch_stub ? (canvas.photos.get(person.id) ?? silhouette(person)) : null,
    tagsOf: (id) => {
      const own = canvas.tags.of.get(id) ?? [];
      return canvas.tags.list.filter((t) => own.includes(t.id));
    },
    toggleFold: (familyId) => canvas.toggleFold(familyId),
    isFolded: (familyId) => canvas.folded.has(familyId),
    linksOf: (id) => nav.linksOf(id),
    isReturn: (link) => nav.isReturn(link),
    openLink: (link) => openLink(link.person_id, nav.linksOf(link.person_id).indexOf(link)),
    unlink: (link) => void nav.unlink(link),
    linkWith: (id) => {
      const person = tree?.persons.find((p) => p.id === id);
      if (person) manual.open(brief(person));
    },
    editing: () => editing,
    startEdit: (id) => {
      if (tree) void editor.edit(tree, id);
    },
    addRelative: (kind, id, at) => {
      if (tree) menu.open(tree, kind, id, at);
    },
    reverted: (change) => {
      journal.toast(change);
      void afterEdit(change.persons[0] ?? null);
    },
  });

  // ── режим правки: форма В2 в панели, плюсы на карте, журнал с откатом ──
  let editing = false;
  const editor = new PersonEditor(panel.element, {
    saved: (change, focusId) => {
      journal.toast(change);
      void afterEdit(focusId);
    },
    closed: () => {
      if (tree && canvas.selected != null) void panel.show(tree, canvas.selected);
      else panel.clear();
    },
  });
  const menu = new RelativeMenu({
    chosen: (plan, existing) => {
      if (tree) editor.create(tree, currentClan, plan, existing);
    },
    closed: () => canvas.setEditing(editing),
  });
  canvas.onPlus = (kind, id, at) => {
    if (tree) menu.open(tree, kind, id, at);
  };
  const journal = new Journal(stage, {
    clanId: () => currentClan,
    changed: (focusId) => void afterEdit(focusId),
    goTo: (id) => {
      canvas.reveal(id);
      canvas.select(id);
      canvas.centreOnPerson(id);
    },
  });
  journal.group.hidden = true;
  // род после правки: перечитать, ничего не сбрасывая — вид, свёрнутые ветки и выбор остаются
  const afterEdit = async (focusId: number | null) => {
    trees.delete(currentClan);
    const [loaded, links, summaries] = await Promise.all([
      getJson<ClanTree>(`/api/clans/${currentClan}/tree`), nav.load(currentClan), getJson<ClanSummary[]>("/api/clans"),
    ]);
    tree = loaded;
    clans = summaries;
    drawClanTabs(currentClan);
    search.setTree(tree);
    canvas.links = links;
    canvas.refreshTree(tree, focusId);
    if (focusId != null) canvas.centreOnPerson(focusId);
    stat.textContent = `${tree.persons.length} человек · ${tree.families.length} семей`;
    void journal.refresh();
    void countQueue();
  };
  const modeSwitch = switcher("Режим", [["view", "Просмотр"], ["edit", "Правка"]], "view", (mode) => {
    editing = mode === "edit";
    journal.group.hidden = !editing;
    canvas.setEditing(editing);
    menu.close();
    if (editing) void journal.refresh();
    if (tree && canvas.selected != null) void panel.show(tree, canvas.selected);
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

  let beforeReview = currentClan; // куда вернуться, если разбор отменён
  const loadClan = async (id: number) => {
    currentClan = id;
    const [loaded, links] = await Promise.all([getJson<ClanTree>(`/api/clans/${id}/tree`), nav.load(id)]);
    tree = loaded;
    search.setTree(tree);
    const tags = demoTags(tree);
    const heirs = demoHeirs(tree);
    canvas.links = links;
    canvas.setTree(tree, demoMarks(tree), new Map(), tags, heirs);
    lineSwitch.hidden = !heirs.size;
    drawTagFilter(tags);
    void journal.refresh();
    stat.textContent = `${tree.persons.length} человек · ${tree.families.length} семей`;
  };

  const upload = new UploadFlow(stage, {
    created: async (clan) => {
      trees.clear();
      clans = await getJson<ClanSummary[]>("/api/clans");
      drawClanTabs(clan.id);
      await loadClan(clan.id);
      void countQueue();
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
      trees.clear();
      void countQueue();
    },
    focus: (id) => canvas.centreOnPerson(id),
  });

  // масштаб: щелчок по числу открывает ввод, Delete в нём возвращает к 100 %
  const zoomValue = document.createElement("button");
  zoomValue.title = "Задать масштаб";
  const zoomField = document.createElement("input");
  zoomField.className = "zoomIn";
  zoomField.type = "text";
  zoomField.inputMode = "numeric";
  zoomField.hidden = true;
  let typing = false;
  const closeZoom = () => {
    typing = false;
    zoomField.hidden = true;
    zoomValue.hidden = false;
  };
  // поле закрывается и по Delete, и по Escape — набранное при этом не применяется повторно с потерей фокуса
  const applyZoom = () => {
    if (!typing) return;
    const value = Number.parseInt(zoomField.value.replace(/[^\d]/g, ""), 10);
    closeZoom();
    if (Number.isFinite(value) && value > 0) canvas.setZoomPercent(value);
  };
  zoomValue.addEventListener("click", () => {
    typing = true;
    zoomValue.hidden = true;
    zoomField.hidden = false;
    zoomField.value = String(canvas.zoomPercent);
    zoomField.focus();
    zoomField.select();
  });
  zoomField.addEventListener("keydown", (e) => {
    if (e.key === "Enter") applyZoom();
    else if (e.key === "Escape") closeZoom();
    else if (e.key === "Delete") {
      e.preventDefault();
      closeZoom();
      canvas.resetZoom();
    }
  });
  zoomField.addEventListener("blur", applyZoom);
  canvas.onViewChange = () => {
    zoomValue.textContent = `${canvas.zoomPercent}%`;
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
    button("−", "Отдалить на 10%", () => canvas.stepZoom(-1)),
    zoomValue,
    zoomField,
    button("+", "Приблизить на 10%", () => canvas.stepZoom(1)),
  );
  const placeRow = document.createElement("div");
  placeRow.className = "sw";
  placeRow.append(button("Целиком", "Показать род целиком", () => canvas.fit()), button("К выбранному", "Центр на выбранном", () => canvas.goToSelected()));
  viewGroup.append(zoomRow, placeRow);

  // кнопки меток: выбранная оставляет своих людей в полную силу, остальных уводит в тень
  const tagFilter = document.createElement("div");
  tagFilter.className = "grp";
  const drawTagFilter = (tags: TagSet) => {
    if (!tags.list.length) {
      tagFilter.hidden = true;
      return;
    }
    tagFilter.hidden = false;
    tagFilter.innerHTML = '<b>Метки</b><div class="tagFilter"></div>';
    const row = tagFilter.querySelector(".tagFilter")!;
    for (const tag of tags.list) {
      const chip = document.createElement("button");
      chip.className = "chip";
      chip.style.setProperty("--c", TAG_COLORS[tag.color]);
      chip.innerHTML = `<i></i>${tag.name}`;
      chip.setAttribute("aria-pressed", "false");
      chip.addEventListener("click", () => {
        const on = chip.getAttribute("aria-pressed") !== "true";
        row.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b === chip && on)));
        canvas.filterByTag(on ? tag.id : null);
      });
      row.append(chip);
    }
  };

  const portraitLabel = document.createElement("label");
  portraitLabel.className = "chk";
  portraitLabel.innerHTML = '<input type="checkbox" checked> портреты';
  portraitLabel.querySelector("input")!.addEventListener("change", (e) => {
    canvas.showPortraits((e.target as HTMLInputElement).checked);
    review.refresh();
    if (tree && canvas.selected != null) void panel.show(tree, canvas.selected);
  });

  // режим «главная линия»: ствол по отметкам и постоянная подсветка; без отметок переключателя нет
  const lineSwitch = switcher("Линия", [["plain", "обычная"], ["main", "главная"]] as [string, string][], "plain",
    (mode) => canvas.update({ mainLine: mode === "main" }));
  lineSwitch.hidden = true;

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
      nav.forget(); // сменил род сам — дорога назад по связке больше не нужна
      void loadClan(id);
    });
    const add = document.createElement("button");
    add.className = "add";
    add.textContent = "+ Загрузить .ged";
    add.addEventListener("click", () => upload.choose());
    // выгрузка открытого рода файлом — со всеми правками и всем, что пришло из исходного файла
    const exportLink = document.createElement("a");
    exportLink.className = "swLink";
    exportLink.textContent = "↓ .ged";
    exportLink.title = "Выгрузить этот род файлом GEDCOM";
    exportLink.href = `/api/clans/${current}/export`;
    exportLink.setAttribute("download", "");
    group.querySelector(".sw")!.append(add, exportLink);
    clanTabs.replaceChildren(group);
  };
  drawClanTabs(currentClan);

  bar.append(
    clanTabs,
    modeSwitch,
    journal.group,
    queueGroup,
    search.element,
    switcher("Стиль", STYLES, "gobelen", (style) => {
      document.body.dataset.style = style;
      canvas.update({ style });
      review.refresh();
    }),
    switcher("Тема", [["dark", "Тёмная"], ["light", "Светлая"]], "dark", (theme) => {
      document.body.dataset.theme = theme;
      canvas.render();
    }),
    viewGroup,
    switcher("Основатель", [["top", "сверху"], ["bottom", "снизу"]], "top", (side) => {
      canvas.update({ rootAtBottom: side === "bottom" });
    }),
    lineSwitch,
    portraitLabel,
    rulerLabel,
    tagFilter,
    stat,
  );

  await loadClan(clans[0]!.id);
  void countQueue();
}

const root = document.getElementById("app");
if (root) {
  start(root).catch((error: unknown) => {
    root.innerHTML = `<div class="empty">Не удалось загрузить роды: ${String(error)}</div>`;
  });
}
