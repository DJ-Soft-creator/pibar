// Small popup menus: header dropdowns with a description per entry (chat view, answer style), the "+" menus in
// the file panel and the context menus of sessions and groups. One menu at a time; closes on click outside,
// Escape or after a choice.
import { h } from "../shared/dom";
import { openConfigExchangeMenu } from "./configExchangeMenu";
import { icon } from "../shared/icons";
import { COLORS } from "../shared/sessionColors";

export interface MenuItem {
  label: string;
  /** Short, muted second line */
  desc?: string;
  /** Show a check mark (current choice of a dropdown) */
  selected?: boolean;
  /** Shown but not clickable (e.g. a mode whose extension is missing) */
  disabled?: boolean;
  /** Colour dot in front of the label (groups) */
  color?: string;
  /** Destructive action (shown in red) */
  danger?: boolean;
  onSelect: () => void;
}

export type MenuEntry =
  | MenuItem
  | { heading: string }
  | { separator: true }
  /** Row of colour swatches; "" = no colour; `legend`: own descriptions under the swatches (session colours) */
  | {
      colors: true;
      current: string;
      onPick: (color: string) => void;
      title: (color: string) => string;
      legend?: { color: string; label: string }[];
    }
  /** Slider row (temperature): label and explanation follow the drag, `onChange` commits the value */
  | {
      slider: true;
      min: number;
      max: number;
      step: number;
      value: number;
      /** Accessible name of the slider */
      label: string;
      /** Ends of the scale, shown under the track (low, high) */
      ends: [string, string];
      format: (v: number) => string;
      hint: (v: number) => string;
      /** While dragging (debounced by the caller); the menu stays open */
      onInput?: (v: number) => void;
      /** On release or keyboard change */
      onChange: (v: number) => void;
    };

let open: { el: HTMLElement; anchor: HTMLElement } | null = null;

export function closeMenu() {
  if (!open) return;
  open.anchor.classList.remove("menu-open");
  open.el.remove();
  open = null;
  document.removeEventListener("pointerdown", onOutside, true);
  document.removeEventListener("keydown", onKey, true);
}

function onOutside(e: PointerEvent) {
  if (!open) return;
  const t = e.target as Node;
  if (!open.el.contains(t) && !open.anchor.contains(t)) closeMenu();
}

function onKey(e: KeyboardEvent) {
  if (!open) return;
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    const a = open.anchor;
    closeMenu();
    a.focus();
    return;
  }
  // a slider (or other input) in the menu keeps its own arrow keys
  const active = document.activeElement;
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return;
  const items = [...open.el.querySelectorAll<HTMLButtonElement>(".menu-item")];
  const i = items.indexOf(active as HTMLButtonElement);
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const n = items.length;
    items[(i + (e.key === "ArrowDown" ? 1 : n - 1) + n) % n]?.focus();
  }
}

function entry(it: MenuEntry): HTMLElement {
  if ("heading" in it) return h("div", { class: "menu-head" }, it.heading);
  if ("separator" in it) return h("div", { class: "menu-sep" });
  if ("slider" in it) return slider(it);
  if ("colors" in it) {
    const row = h(
      "div",
      { class: "menu-colors" },
      ...["", ...COLORS].map((c) =>
        h("button", {
          type: "button",
          class: `swatch ${c ? `c-${c}` : "none"} ${c === it.current ? "sel" : ""}`,
          title: it.title(c),
          "aria-label": it.title(c),
          onclick: () => {
            closeMenu();
            it.onPick(c);
          },
        }),
      ),
    );
    if (!it.legend?.length) return row;
    return h(
      "div",
      {},
      row,
      h(
        "div",
        { class: "menu-color-legend" },
        ...it.legend.map((x) =>
          h("div", { class: `legend-row c-${x.color}` }, h("span", { class: "cdot" }), h("span", {}, x.label)),
        ),
      ),
    );
  }
  return item(it);
}

/** Slider row: value and explanation follow the drag; the menu stays open until a choice or a click outside */
function slider(it: Extract<MenuEntry, { slider: true }>): HTMLElement {
  const val = h("span", { class: "menu-slider-val" }, it.format(it.value));
  const hint = h("span", { class: "menu-slider-hint" }, it.hint(it.value));
  const input = h("input", {
    type: "range",
    min: it.min,
    max: it.max,
    step: it.step,
    value: it.value,
    "aria-label": it.label,
  }) as HTMLInputElement;
  const show = (v: number) => {
    val.textContent = it.format(v);
    hint.textContent = it.hint(v);
  };
  input.addEventListener("input", () => {
    const v = Number(input.value);
    show(v);
    it.onInput?.(v);
  });
  input.addEventListener("change", () => it.onChange(Number(input.value)));
  return h(
    "div",
    { class: "menu-slider" },
    h("div", { class: "menu-slider-top" }, val),
    input,
    h("div", { class: "menu-slider-ends" }, h("span", {}, it.ends[0]), h("span", {}, it.ends[1])),
    hint,
  );
}

function item(it: MenuItem): HTMLElement {
  return h(
    "button",
    {
      type: "button",
      role: "menuitem",
      class: `menu-item ${it.selected ? "sel" : ""} ${it.danger ? "danger" : ""}`,
      disabled: it.disabled,
      onclick: () => {
        if (it.disabled) return;
        closeMenu();
        it.onSelect();
      },
    },
    h("span", { class: "mi-check" }, it.selected ? icon("check", 13) : ""),
    h(
      "span",
      { class: "mi-text" },
      h("span", { class: "mi-label" }, it.color ? h("span", { class: `cdot c-${it.color}` }) : null, it.label),
      it.desc ? h("span", { class: "mi-desc" }, it.desc) : null,
    ),
  );
}

/** Open a menu below `anchor` (toggles when it is already open there); `at` = mouse position (context menu) */
export function openMenu(
  anchor: HTMLElement,
  items: MenuEntry[],
  align: "left" | "right" = "left",
  at?: { x: number; y: number },
) {
  if (open?.anchor === anchor && !at) return closeMenu();
  closeMenu();
  const el = h("div", { class: "menu", role: "menu" }, ...items.map(entry));
  document.body.append(el);
  // fixed position below the anchor (or at the mouse), kept inside the window
  const r = at ? new DOMRect(at.x, at.y, 0, 0) : anchor.getBoundingClientRect();
  const w = el.offsetWidth;
  const left = align === "right" ? r.right - w : r.left;
  el.style.left = `${Math.max(8, Math.min(left, window.innerWidth - w - 8))}px`;
  const below = r.bottom + 4;
  el.style.top =
    below + el.offsetHeight > window.innerHeight - 8 ? `${Math.max(8, r.top - el.offsetHeight - 4)}px` : `${below}px`;
  anchor.classList.add("menu-open");
  open = { el, anchor };
  document.addEventListener("pointerdown", onOutside, true);
  document.addEventListener("keydown", onKey, true);
  (el.querySelector<HTMLButtonElement>(".menu-item.sel") ?? el.querySelector<HTMLButtonElement>(".menu-item"))?.focus();
}
