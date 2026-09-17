// Выпадающий список в цветах стиля вместо системного: у системного подсветка браузера и чужой шрифт.
// Стрелки двигают выбор, Enter подтверждает, Escape и щелчок мимо закрывают.

import { escapeHtml } from "../format";

export interface PickOption {
  value: string;
  label: string;
}

export class Picker {
  readonly element: HTMLElement;
  private readonly button: HTMLButtonElement;
  private readonly menu: HTMLElement;
  private active = 0;
  private outside = (e: PointerEvent) => {
    if (!this.element.contains(e.target as Node)) this.close();
  };

  constructor(
    private readonly options: PickOption[],
    public value: string,
    private readonly onChange: (value: string) => void = () => {},
  ) {
    this.element = document.createElement("div");
    this.element.className = "pick";
    this.button = document.createElement("button");
    this.button.type = "button";
    this.button.className = "field pickBtn";
    this.button.setAttribute("aria-haspopup", "listbox");
    this.menu = document.createElement("div");
    this.menu.className = "menu";
    this.menu.setAttribute("role", "listbox");
    this.menu.hidden = true;
    this.element.append(this.button, this.menu);

    this.button.addEventListener("click", () => (this.menu.hidden ? this.open() : this.close()));
    this.button.addEventListener("keydown", (e) => this.onKey(e));
    this.menu.addEventListener("pointerdown", (e) => {
      const item = (e.target as HTMLElement).closest<HTMLElement>("[data-value]");
      if (!item) return;
      e.preventDefault();
      this.choose(item.dataset.value!);
    });
    this.menu.addEventListener("pointermove", (e) => {
      const item = (e.target as HTMLElement).closest<HTMLElement>("[data-index]");
      if (item && Number(item.dataset.index) !== this.active) {
        this.active = Number(item.dataset.index);
        this.draw();
      }
    });
    this.draw();
  }

  set disabled(value: boolean) {
    this.button.disabled = value;
    if (value) this.close();
  }

  private draw(): void {
    const current = this.options.find((o) => o.value === this.value);
    this.button.innerHTML =
      `<span>${escapeHtml(current?.label ?? "")}</span>` +
      '<svg width="10" height="6" viewBox="0 0 10 6" aria-hidden="true"><path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>';
    this.menu.innerHTML = this.options
      .map(
        (o, i) =>
          `<div class="opt${i === this.active ? " on" : ""}${o.value === this.value ? " cur" : ""}" role="option" ` +
          `aria-selected="${o.value === this.value}" data-index="${i}" data-value="${escapeHtml(o.value)}">${escapeHtml(o.label)}</div>`,
      )
      .join("");
  }

  private open(): void {
    this.active = Math.max(0, this.options.findIndex((o) => o.value === this.value));
    this.menu.hidden = false;
    this.element.classList.add("open");
    this.draw();
    document.addEventListener("pointerdown", this.outside);
  }

  private close(): void {
    this.menu.hidden = true;
    this.element.classList.remove("open");
    document.removeEventListener("pointerdown", this.outside);
  }

  private choose(value: string): void {
    this.close();
    this.button.focus();
    if (value === this.value) return;
    this.value = value;
    this.draw();
    this.onChange(value);
  }

  private onKey(e: KeyboardEvent): void {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (this.menu.hidden) return this.open();
      this.active = (this.active + (e.key === "ArrowDown" ? 1 : -1) + this.options.length) % this.options.length;
      this.draw();
    } else if (e.key === "Enter" && !this.menu.hidden) {
      e.preventDefault();
      this.choose(this.options[this.active]!.value);
    } else if (e.key === "Escape" && !this.menu.hidden) {
      e.preventDefault();
      e.stopPropagation();
      this.close();
    }
  }
}
