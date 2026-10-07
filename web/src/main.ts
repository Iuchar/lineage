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

import type { ChangeInfo, ClanSummary, ClanTree, LinkPerson, TreePerson } from "./api/types";
import { NO_MARKS } from "./canvas/cards";
import { escapeHtml, untilText } from "./format";
import { TreeCanvas } from "./canvas/canvas";
import { STATUS_NAMES } from "./canvas/status";
import { mergeData, treeData } from "./canvas/treedata";
import { demoHeirs, demoMarks, demoTags } from "./demo";
import { LinkNav } from "./links/nav";
import { ManualLink } from "./links/manual";
import { LinkReview } from "./links/review";
import { FamilyEditor } from "./editor/family";
import { send } from "./editor/api";
import { PersonEditor } from "./editor/form";
import { Dock } from "./panel/dock";
import { icon } from "./panel/icons";
import { beginVisit } from "./session";
import { NewClan } from "./panel/newclan";
import { Gate, whoami, type Me } from "./panel/gate";
import { ShareBox } from "./panel/sharebox";
import { Journal } from "./editor/journal";
import { RelativeMenu } from "./editor/menu";
import { ClanRail } from "./panel/clans";
import { PersonPanel } from "./panel/panel";
import { LegendPanel } from "./panel/legendpanel";
import { ViewPanel, type ViewMode } from "./panel/viewpanel";
import { SearchBox } from "./panel/search";
import { UploadFlow } from "./upload/upload";
import { silhouette } from "./canvas/portrait";

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return (await response.json()) as T;
}

// сторона строки шапки: при нехватке ширины переносится целиком, а не рассыпается по кнопке
function side(kind: "left" | "right" | "grow", ...parts: HTMLElement[]): HTMLElement {
  const box = document.createElement("div");
  box.className = kind === "left" ? "barSide" : `barSide ${kind}`;
  box.append(...parts);
  return box;
}

// тонкая черта между кусками строки: вместо подписей у каждой группы
function sep(): HTMLElement {
  const line = document.createElement("span");
  line.className = "topSep";
  return line;
}

type Look = "all" | "clan" | "edit"; // чьими глазами редактор смотрит на дерево

function row(...parts: HTMLElement[]): HTMLElement {
  const line = document.createElement("div");
  line.className = "row";
  line.append(...parts);
  return line;
}

function switcher<T extends string | number>(
  title: string,
  options: [T, string][],
  current: T,
  onPick: (value: T) => void,
): HTMLElement {
  const group = document.createElement("div");
  group.className = "grp";
  group.title = title;
  const row = document.createElement("div");
  row.className = "sw";
  for (const [value, text] of options) {
    const button = document.createElement("button");
    button.dataset.value = String(value);
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
  const freshVisit = beginVisit();
  document.body.dataset.style = "gobelen";
  document.body.dataset.theme = "dark";

  // шапка и основная часть — ориентиры: по ним читалка с экрана прыгает, не перебирая всё подряд
  const bar = document.createElement("header");
  bar.className = "bar";
  const stage = document.createElement("main");
  stage.className = "stage";
  // Чьими глазами смотрит редактор. «all» — общий зритель: любой, кто открыл сайт, видит только общий слой.
  // «clan» — родовой зритель: гость по ссылке этого рода, видит общий слой и родовой. «edit» — правка, видно всё.
  // null — смотрит не редактор, а настоящий зритель: что ему видно, решает сервер.
  let look: Look | null = null;
  const viewerId = (): number | null => (look === "all" ? 0 : look === "clan" ? currentClan : null);
  const eyes = () => {
    const id = viewerId();
    return id == null ? "" : `?as_viewer=${id}`;
  };
  const ribbon = document.createElement("div");
  ribbon.className = "ribbon";
  ribbon.hidden = true;
  // подпись автора внизу страницы: видна всем, в любом режиме
  const foot = document.createElement("footer");
  foot.className = "foot";
  const outside = (href: string, text: string) =>
    `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}${icon("out")}</a>`;
  foot.innerHTML = `<span>Автор идеи <b>Тюр</b></span><i>·</i>${outside("https://vk.ru/max_gpt", "ВКонтакте")}` +
    `<i>·</i>${outside("https://t.me/Maks_GPT", "Telegram")}`;
  root.append(bar, stage, foot);

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
    const fresh = new NewClan(stage, () => location.reload());
    const start = document.createElement("button");
    start.className = "add";
    start.textContent = "+ Новая родословная";
    start.addEventListener("click", () => fresh.open());
    group.querySelector(".sw")!.append(start, add);
    bar.append(group);
    stage.insertAdjacentHTML("afterbegin", '<div class="empty">Родословных пока нет — начните новую или загрузите файл .ged</div>');
    return;
  }

  // столбец родов слева от карты, панели «Вид» и «Легенда» — справа поверх панели человека
  const rail = new ClanRail({
    pick: (id) => {
      if (id === currentClan) return;
      if (upload.reviewing) {
        upload.cancel(false);
        cardDock.element.hidden = false;
      }
      nav.forget(); // сменил род сам — дорога назад по связке больше не нужна
      void loadClan(id);
    },
    add: () => upload.choose(),
    create: () => newClan.open(),
    share: (id, name) => void shareBox.open(id, name),
  });
  // три дока одного устройства: шапка с названием, сворачивание в полоску, у двух — растяжка за край
  const redrawMap = () => window.dispatchEvent(new Event("resize"));
  // список родословных по умолчанию свёрнут в полоску: карте нужнее место, а род меняют нечасто
  const clansDock = new Dock({ key: "clans", title: "Родословные", icon: "tree", side: "left", width: 216, open: false,
    resize: { min: 170, max: 460 }, changed: redrawMap });
  clansDock.body.append(rail.element);
  stage.append(clansDock.element);
  const shareBox = new ShareBox(stage);
  const canvas = new TreeCanvas(stage);
  // колонка карты: лента «глазами зрителя» лежит над картой, между панелями, а не поверх них
  const mapCol = document.createElement("div");
  mapCol.className = "mapCol";
  canvas.viewport.replaceWith(mapCol);
  mapCol.append(ribbon, canvas.viewport);
  let tree: ClanTree | null = null;
  let currentClan = clans[0]!.id;
  const clanName = (id: number) => clans.find((c) => c.id === id)?.name ?? "";
  const fullName = (p: TreePerson) => [p.given, p.surname].filter(Boolean).join(" ") || "без имени";
  const brief = (p: TreePerson): LinkPerson => ({
    id: p.id, clan_id: currentClan, clan_name: clanName(currentClan), name: fullName(p),
    born: p.birth?.year ?? null, died: p.death?.year ?? null, dates_closed: p.dates_closed,
  });

  // связки: сноска на карте и строка в панели ведут в другой род, лента над картой — обратно
  const nav = new LinkNav(stage, {
    goTo: async (clanId, personId) => {
      showClan(clanId);
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
    if (!trees.has(clanId)) trees.set(clanId, getJson<ClanTree>(`/api/clans/${clanId}/tree${eyes()}`));
    return trees.get(clanId)!;
  };
  const review = new LinkReview(stage, {
    tree: treeOf,
    show: async (clanId, personId) => {
      if (clanId !== currentClan) {
        showClan(clanId);
        await loadClan(clanId);
      }
      arrive(personId);
    },
    style: () => canvas.state.style,
    portraits: () => canvas.portraits,
    opened: () => {
      cardDock.element.hidden = true;
    },
    closed: () => {
      cardDock.element.hidden = false;
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
  queueGroup.innerHTML = '<div class="sw"></div>';
  queueGroup.title = "Пары с одинаковым именем и годом рождения в других родах";
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

  // что рисует карта сверх родства: из дерева рода, а демо-набор разработчика (?demo=marks) — поверх
  const dataOf = (loaded: ClanTree) =>
    mergeData(treeData(loaded), { marks: demoMarks(loaded), tags: demoTags(loaded), heirs: demoHeirs(loaded) });

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
  const viewMode: ViewMode = "view"; // панель «Вид» нарисована всегда, открыт ли её док — дело дока
  const viewPanel = new ViewPanel(stage, {
    style: (style) => {
      document.body.dataset.style = style;
      canvas.update({ style });
      review.refresh();
      drawViewPanel();
      drawLegend();
    },
    theme: (theme) => {
      document.body.dataset.theme = theme;
      canvas.render();
      drawViewPanel();
      drawLegend();
    },
    mainLine: (on) => {
      canvas.update({ mainLine: on });
      drawViewPanel();
      drawLegend();
    },
    rootAtBottom: (on) => {
      canvas.update({ rootAtBottom: on });
      drawViewPanel();
    },
    surnames: (mode) => {
      canvas.setSurnames(mode === "off" ? null : mode);
      drawViewPanel();
    },
    portraits: (on) => {
      canvas.showPortraits(on);
      review.refresh();
      if (tree && canvas.selected != null) void panel.show(tree, canvas.selected);
    },
    ruler: (on) => canvas.update({ ruler: on }),
    dates: (on) => {
      datesWanted = on;
      syncDates();
      drawViewPanel();
    },
    foldAll: () => {
      canvas.foldAll();
      drawLegend();
    },
    unfoldAll: () => {
      canvas.unfoldAll();
      drawLegend();
    },
    closed: () => viewDock.setOpen(false),
  });
  const legend = new LegendPanel(canvas.viewport, {
    filter: (tag) => {
      canvas.filterByTag(tag);
      drawLegend();
    },
  });
  const drawLegend = () => {
    const persons = [...canvas.mainPersons];
    const byId = new Map((tree?.persons ?? []).map((p) => [p.id, p]));
    const name = (id: number | undefined) => (id != null ? byId.get(id)?.given ?? "" : "");
    const n = persons.length;
    const word = n % 10 === 1 && n % 100 !== 11 ? "поколение"
      : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? "поколения" : "поколений";
    legend.show({
      tree,
      style: canvas.state.style,
      line: n > 1 ? `${n} ${word}: ${name(persons[persons.length - 1])} — ${name(persons[0])}` : "",
      facts: {
        heirs: canvas.heirs.size > 0,
        burnt: canvas.marks.burnt.size > 0,
        hidden: canvas.marks.hidden.size > 0,
        folded: canvas.folded.size > 0,
        links: canvas.links.size > 0,
        editing,
      },
      tags: canvas.tags,
      filter: canvas.filter,
    });
  };
  const drawViewPanel = () => {
    viewPanel.show(viewMode, {
      style: canvas.state.style,
      theme: (document.body.dataset.theme as "dark" | "light") ?? "dark",
      mainLine: canvas.state.mainLine,
      hasHeirs: canvas.heirs.size > 0,
      rootAtBottom: canvas.state.rootAtBottom,
      surnames: canvas.surnames ?? "off",
      portraits: canvas.portraits,
      ruler: canvas.state.ruler,
      dates: datesWanted,
      datesLocked: !datesAllowed(),
    });
  };
  // Даты на карточках. Общему зрителю они закрыты — у него флажок выключен и заблокирован;
  // родовому зрителю и редактору даты показаны, пока они сами их не уберут.
  let datesWanted = true;
  const datesAllowed = () => look === "edit" || look === "clan" ||
    (look === null && Boolean(me.access?.some((a) => a.clan_id === currentClan)));
  const syncDates = () => canvas.showDates(datesAllowed() && datesWanted);
  const viewDock = new Dock({ key: "view", title: "Вид", icon: "view", side: "right", width: 272, open: false, changed: redrawMap });
  viewDock.element.classList.add("viewDock");
  viewDock.body.append(viewPanel.element);
  stage.append(viewDock.element);

  const panel = new PersonPanel(stage, {
    select: focus,
    nudge: (id, direction) => {
      canvas.nudge(id, direction);
      if (tree) void panel.show(tree, id);
    },
    manualOffset: (id) => canvas.manual.get(id) ?? 0,
    portrait: (person) =>
      canvas.portraits && !person.is_branch_stub && !canvas.noPortrait.has(person.id)
        ? (canvas.photos.get(person.id) ?? silhouette(person)) : null,
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
    linkSee: (link, see) => void (async () => {
      const result = await send<unknown>("PUT", `/api/links/${link.link_id}/see`, { see });
      if (result.ok) await refreshLinks();
    })(),
    linkWith: (id) => {
      const person = tree?.persons.find((p) => p.id === id);
      if (person) manual.open(brief(person));
    },
    editing: () => editing,
    eyes: () => eyes(),
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
    openFamily: (familyId) => canvas.selectFamily(familyId),
    editFamily: (familyId) => {
      if (tree) void familyEditor.edit(tree, familyId);
    },
  });
  const cardDock = new Dock({ key: "card", title: "Карточка человека", icon: "person", side: "right", width: 262,
    resize: { min: 220, max: 520 }, changed: redrawMap });
  cardDock.element.classList.add("cardDock");
  cardDock.body.append(panel.element);
  stage.append(cardDock.element);
  // выбрали человека или союз, а карточка свёрнута — она раскрывается сама: иначе щелчок выглядит пустым
  canvas.onPick = () => cardDock.setOpen(true);
  // что сейчас в панели: союз или человек
  const showCurrent = () => {
    if (!tree) return panel.clear();
    if (canvas.selectedFamily != null) void panel.showFamily(tree, canvas.selectedFamily);
    else if (canvas.selected != null) void panel.show(tree, canvas.selected);
    else panel.clear();
  };
  canvas.onFamily = (familyId) => {
    if (tree) void panel.showFamily(tree, familyId);
  };

  // ── режим правки: форма В2 в панели, плюсы на карте, журнал с откатом ──
  let editing = false;
  const editor = new PersonEditor(panel.element, {
    saved: (change, focusId) => {
      journal.toast(change);
      void afterEdit(focusId);
    },
    closed: showCurrent,
    addBirthParents: (id, at) => {
      if (tree) menu.open(tree, "parent", id, at, true);
    },
  });
  const familyEditor = new FamilyEditor(panel.element, {
    saved: (change) => {
      journal.toast(change);
      void afterEdit(null);
    },
    closed: showCurrent,
    // ребёнок союза — через тот же список у плюса; у семьи без родителей — брат или сестра
    addChild: (familyId, at) => {
      const family = tree?.families.find((f) => f.id === familyId);
      if (!tree || !family) return;
      const parent = family.husband ?? family.wife;
      if (parent != null) menu.open(tree, "child", parent, at);
      else if (family.children[0] != null) menu.open(tree, "sibling", family.children[0], at);
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
      getJson<ClanTree>(`/api/clans/${currentClan}/tree${eyes()}`), nav.load(currentClan), getJson<ClanSummary[]>("/api/clans"),
    ]);
    tree = loaded;
    clans = summaries;
    showClan(currentClan);
    search.setTree(tree);
    canvas.links = links;
    // метки, состояния, линия и снимки тоже могли поменяться этой правкой
    const data = dataOf(tree);
    canvas.marks = data.marks;
    canvas.tags = data.tags;
    canvas.heirs = data.heirs;
    canvas.photos = data.photos;
    canvas.noPortrait = data.noPortrait;
    drawViewPanel(); // в панели «Вид» мог появиться переключатель главной ветви
    drawLegend();
    canvas.refreshTree(tree, focusId);
    if (focusId != null) canvas.centreOnPerson(focusId);
    stat.textContent = `${tree.persons.length} человек · ${tree.families.length} семей`;
    void journal.refresh();
    void countQueue();
  };
  const gate = new Gate(stage);
  // новый заход — редактор выходит сам: браузер мог вернуть его cookie, восстановив вкладки
  if (freshVisit) await send<Me>("POST", "/api/logout");
  let me: Me = await whoami();
  let syncEditRow = () => {}; // строка редактора собирается ниже, а режим переключается раньше
  // редактор — вошедший, а пока редакторы не заведены, правка открыта каждому
  const isEditor = () => Boolean(me.name) || !me.guarded;
  const modeSep = sep();
  // переключатель есть только у редактора: зрителю выбирать не из чего
  const modeSwitch = switcher<Look>("Чьими глазами смотреть на дерево",
    [["all", "Общий зритель"], ["clan", "Родовой зритель"], ["edit", "Правка"]], "clan", (mode) => void applyLook(mode));
  // у каждого взгляда своё дерево: оно перезагружается, а на карте появляется плашка и рамка
  const applyLook = async (next: Look | null) => {
    look = next;
    editing = next === "edit";
    const watching = next === "all" || next === "clan";
    journal.group.hidden = !editing;
    syncEditRow();
    canvas.setEditing(editing);
    menu.close();
    rail.setEditing(editing);
    canvas.viewport.classList.toggle("asViewer", watching);
    ribbon.hidden = !watching;
    trees.clear();
    await loadClan(currentClan);
    showCurrent();
  };
  // плашка над картой говорит, чей это вид и чего в нём нет
  const drawRibbon = () => {
    // настоящий гость по ссылке: говорим, чей он гость и до какого дня — ссылка не вечна
    if (look === null) {
      const mine = me.access?.find((a) => a.clan_id === currentClan);
      ribbon.hidden = !mine;
      if (mine) {
        ribbon.innerHTML = `<b>Вы гость рода «${escapeHtml(clanName(currentClan))}»</b>` +
          `<span>доступ по ссылке ${untilText(mine.until)}</span>`;
      }
      return;
    }
    if (look !== "all" && look !== "clan") return;
    const total = clans.find((c) => c.id === currentClan)?.persons ?? 0;
    const lost = Math.max(0, total - (tree?.persons.length ?? 0));
    const hidden = lost ? ` · скрыто людей: ${lost}` : "";
    ribbon.innerHTML = look === "all"
      ? `<b>Так дерево видит любой посетитель</b><span>только общий слой: без дат жизни и родовых заметок${hidden}</span>`
      : `<b>Так дерево видит гость по ссылке рода «${escapeHtml(clanName(currentClan))}»</b><span>общий слой и родовой${hidden}</span>`;
  };
  const setLook = (next: Look) => {
    modeSwitch.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.value === next)));
    return applyLook(next);
  };
  // панель показывает, свёрнута ли ветка, — перерисовать после щелчка по стопке на карте
  canvas.onFoldChange = showCurrent;
  canvas.onSelect = (id) => {
    if (upload.reviewing) return upload.highlight(id); // в разборе панель занята сводкой
    if (tree && id != null) void panel.show(tree, id);
    else panel.clear();
  };
  const search = new SearchBox(focus);

  let beforeReview = currentClan; // куда вернуться, если разбор отменён
  const loadClan = async (id: number) => {
    currentClan = id;
    nav.asViewer = viewerId();
    showClan(id);
    const [loaded, links] = await Promise.all([getJson<ClanTree>(`/api/clans/${id}/tree${eyes()}`), nav.load(id)]);
    tree = loaded;
    search.setTree(tree);
    const data = dataOf(tree);
    canvas.links = links;
    canvas.photos = data.photos;
    canvas.noPortrait = data.noPortrait;
    canvas.setTree(tree, data.marks, new Map(), data.tags, data.heirs);
    drawViewPanel(); // в панели «Вид» мог появиться переключатель главной ветви
    drawLegend();
    void journal.refresh();
    stat.textContent = `${tree.persons.length} человек · ${tree.families.length} семей`;
    drawRibbon();
    syncDates();
  };

  // новый род с нуля открывается сразу, как и загруженный файлом
  const newClan = new NewClan(stage, async (clan) => {
    trees.clear();
    clans = await getJson<ClanSummary[]>("/api/clans");
    await loadClan(clan.id);
    void countQueue();
  });
  const upload = new UploadFlow(stage, {
    created: async (clan) => {
      trees.clear();
      clans = await getJson<ClanSummary[]>("/api/clans");
      showClan(clan.id);
      await loadClan(clan.id);
      void countQueue();
    },
    review: (preview, marks) => {
      beforeReview = currentClan;
      cardDock.element.hidden = true;
      tree = preview.tree;
      search.setTree(preview.tree);
      canvas.setTree(preview.tree, NO_MARKS, marks);
      stat.textContent = "разбор файла · карта из нового файла";
      const first = marks.keys().next();
      if (!first.done) canvas.centreOnPerson(first.value); // сразу к первому изменению
    },
    finished: async (clanId, report) => {
      cardDock.element.hidden = false;
      const target = report ? clanId : beforeReview;
      clans = await getJson<ClanSummary[]>("/api/clans");
      showClan(target);
      await loadClan(target);
      if (report) {
        stat.textContent += ` · перезалито: добавлено ${report.added}, изменено ${report.changed}, удалено ${report.deleted}`;
      }
      trees.clear();
      void countQueue();
    },
    focus: (id) => canvas.centreOnPerson(id),
  });

  // род в шапке: название и счёт; сам список — в столбце слева
  const clanTitle = document.createElement("div");
  clanTitle.className = "clanTitle";
  const exportLink = document.createElement("a");
  exportLink.className = "topLink";
  exportLink.textContent = "Выгрузить .ged";
  exportLink.title = "Выгрузить этот род файлом GEDCOM";
  exportLink.setAttribute("download", "");
  const addLink = document.createElement("button");
  addLink.className = "topLink";
  addLink.textContent = "+ Загрузить .ged";
  addLink.addEventListener("click", () => upload.choose());
  const showClan = (id: number) => {
    const clan = clans.find((c) => c.id === id);
    rail.setClans(clans, id);
    const status = clan?.status ?? "plain";
    clanTitle.innerHTML = `<b role="heading" aria-level="1">${escapeHtml(clan?.name ?? "")}</b>` + (editing
      ? `<select class="statusPick" title="Титул рода">${Object.entries(STATUS_NAMES).map(([key, name]) =>
        `<option value="${key}"${key === status ? " selected" : ""}>${name}</option>`).join("")}</select>`
      : `<span class="clanStatus" title="${STATUS_NAMES[status] ?? ""}">${STATUS_NAMES[status] ?? ""}</span>`);
    clanTitle.querySelector("select")?.addEventListener("change", (e) => {
      void setClanStatus(id, (e.target as HTMLSelectElement).value);
    });
    exportLink.href = `/api/clans/${id}/export${eyes()}`; // «глазами зрителя» выгружается его слой
  };
  // титул рода пишется в заголовок файла и откатывается журналом
  const setClanStatus = async (id: number, status: string) => {
    const result = await send<ChangeInfo>("PUT", `/api/clans/${id}/status`, { status });
    if (!result.ok) return;
    journal.toast(result.data);
    clans = await getJson<ClanSummary[]>("/api/clans");
    showClan(id);
    void journal.refresh();
  };

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

  const stat = document.createElement("div");
  stat.className = "hint";

  showClan(currentClan);

  // шапка тремя строками: первая говорит, какое дерево открыто, две другие — что с ним делать.
  // Инструменты лежат на подложке потемнее, поэтому не читаются продолжением заголовка
  const access = document.createElement("button");
  access.className = "topLink";
  access.addEventListener("click", () => {
    if (me.name) void leave();
    else gate.open((who) => {
      me = who;
      showAccess();
      void setLook("clan"); // вошёл — сначала смотрит родовым зрителем
    });
  });
  const showAccess = () => {
    // зритель не знает про вход: кнопка появляется, только когда редакторы заведены
    access.hidden = !me.guarded && !me.name;
    access.textContent = me.name ? `Выйти · ${me.name}` : "Войти";
    access.title = me.name ? "Закончить работу редактором" : "Войти, чтобы править роды";
    // переключатель взглядов — только редактору
    modeSwitch.hidden = !isEditor();
    modeSep.hidden = !isEditor();
  };
  const leave = async () => {
    const result = await send<Me>("POST", "/api/logout");
    me = result.ok ? result.data : { name: null, guarded: true };
    showAccess();
    // вышел — взгляды редактора сбрасываются: дальше смотрит настоящий зритель
    await (isEditor() ? setLook("clan") : applyLook(null));
  };
  showAccess();

  // строка 1: имя рода слева, поиск ровно по центру, счёт и вход справа
  const titleRow = row(clanTitle, search.element, side("right", stat, sep(), access));
  titleRow.classList.add("top");
  // строка 2 — для всех; строка 3 — строка редактора, её видно только в правке.
  // «Выгрузить» и «Загрузить» стоят у самого правого края друг под другом, а группы слева от них
  // берут свою ширину: переключателя у незашедшего нет вовсе
  const viewRow = row(side("left", zoomRow, placeRow), side("right", modeSwitch, modeSep, exportLink));
  const editorMark = document.createElement("span");
  editorMark.className = "editorMark";
  editorMark.textContent = "редактор";
  const editRow = row(side("left", editorMark, queueGroup), side("right", journal.group, sep(), addLink));
  editRow.classList.add("editRow");
  const tools = document.createElement("div");
  tools.className = "tools";
  tools.append(viewRow, editRow);
  bar.append(titleRow, tools);
  syncEditRow = () => {
    editRow.hidden = !editing;
  };
  syncEditRow();

  // редактор начинает родовым зрителем; не редактор смотрит тем, что отдаст сервер
  await applyLook(isEditor() ? "clan" : null);
  void countQueue();
}

const root = document.getElementById("app");
if (root) {
  // витрина: сервера нет, ядро работает прямо в браузере. На настоящем сервере мост не нужен
  const witness = document.documentElement.dataset.mode === "browser";
  const ready = witness
    ? (async () => {
      const [{ startBridge, seedClans }, { splash }] = await Promise.all([
        import("./api/bridge"), import("./panel/firstrun"),
      ]);
      const screen = splash(root);
      await startBridge(screen.say);
      await seedClans(screen.say);
      screen.close();
    })()
    : Promise.resolve();
  ready
    .then(() => start(root))
    .catch((error: unknown) => {
      root.innerHTML = `<div class="empty">Не удалось загрузить роды: ${String(error)}</div>`;
    });
}
