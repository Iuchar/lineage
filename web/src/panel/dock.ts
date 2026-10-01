// Док — общая рамка боковых панелей: шапка с названием, сворачивание в полоску с вертикальной надписью,
// растяжка за край. Что лежит внутри, доку всё равно: родословные, карточка человека, вид.
// Открыт ли док и какой он ширины, помнит браузер.

import { icon, type IconName } from "./icons";

export interface DockOptions {
  key: string; // под этим именем состояние лежит в браузере
  title: string;
  icon: IconName;
  side: "left" | "right";
  width: number; // исходная ширина
  open?: boolean; // исходно открыт
  resize?: { min: number; max: number }; // без этого док не тянется
  changed?: () => void; // ширина или состояние сменились — карте пора пересчитаться
}

interface Saved {
  open?: boolean;
  width?: number;
}

export class Dock {
  readonly element: HTMLElement;
  readonly body: HTMLElement;
  private open: boolean;
  private width: number;

  constructor(private readonly options: DockOptions) {
    const saved = this.read();
    this.open = saved.open ?? options.open ?? true;
    this.width = this.clamp(saved.width ?? options.width);

    this.element = document.createElement("div");
    this.element.className = `dock ${options.side}`;
    this.element.dataset.dock = options.key;
    const fold = options.side === "left" ? "left" : "right";
    this.element.innerHTML =
      `<button type="button" class="dockStrip" title="Показать: ${options.title}">` +
      `<span class="dockBtn">${icon(options.icon)}</span><em>${options.title}</em></button>` +
      `<div class="dockHead"><b role="heading" aria-level="2">${options.title}</b>` +
      `<button type="button" class="dockBtn" data-dock-fold title="Свернуть" aria-label="Свернуть: ${options.title}">${icon(fold)}</button></div>` +
      '<div class="dockBody"></div>' +
      (options.resize ? '<span class="dockGrip" title="Потяните, чтобы изменить ширину"></span>' : "");
    this.body = this.element.querySelector<HTMLElement>(".dockBody")!;
    this.element.querySelector(".dockStrip")!.addEventListener("click", () => this.setOpen(true));
    this.element.querySelector("[data-dock-fold]")!.addEventListener("click", () => this.setOpen(false));
    if (options.resize) this.bindGrip(this.element.querySelector<HTMLElement>(".dockGrip")!);
    this.apply();
  }

  get isOpen(): boolean {
    return this.open;
  }

  setOpen(open: boolean): void {
    if (this.open === open) return;
    this.open = open;
    this.save();
    this.apply();
    this.options.changed?.();
  }

  private clamp(width: number): number {
    const limits = this.options.resize;
    return limits ? Math.min(Math.max(Math.round(width), limits.min), limits.max) : width;
  }

  private apply(): void {
    this.element.classList.toggle("mini", !this.open);
    this.element.style.width = this.open ? `${this.width}px` : "";
    this.element.querySelector(".dockStrip")!.setAttribute("aria-expanded", String(this.open));
  }

  private bindGrip(grip: HTMLElement): void {
    let from: { x: number; width: number } | null = null;
    grip.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      from = { x: e.clientX, width: this.width };
      grip.setPointerCapture(e.pointerId);
      this.element.classList.add("resizing");
    });
    grip.addEventListener("pointermove", (e) => {
      if (!from) return;
      const delta = e.clientX - from.x;
      // левая панель растёт вправо, правая — влево
      this.width = this.clamp(from.width + (this.options.side === "left" ? delta : -delta));
      this.element.style.width = `${this.width}px`;
      this.options.changed?.();
    });
    const end = () => {
      if (!from) return;
      from = null;
      this.element.classList.remove("resizing");
      this.save();
    };
    grip.addEventListener("pointerup", end);
    grip.addEventListener("pointercancel", end);
    // двойной щелчок возвращает исходную ширину
    grip.addEventListener("dblclick", () => {
      this.width = this.clamp(this.options.width);
      this.save();
      this.apply();
      this.options.changed?.();
    });
  }

  private read(): Saved {
    try {
      const raw = localStorage.getItem(`rodoslovnye.dock.${this.options.key}`);
      return raw ? (JSON.parse(raw) as Saved) : {};
    } catch {
      return {}; // без хранилища док откроется как задумано по умолчанию
    }
  }

  private save(): void {
    try {
      localStorage.setItem(`rodoslovnye.dock.${this.options.key}`, JSON.stringify({ open: this.open, width: this.width }));
    } catch {
      // не запомнилось — в следующий раз встанет исходная ширина
    }
  }
}
