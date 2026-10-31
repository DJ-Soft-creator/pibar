// Small popup menus: header dropdowns with a description per entry (chat view, answer style), the "+" menus in
// the file panel and the context menus of sessions and groups. One menu at a time; closes on click outside,
// Escape or after a choice.
import { h } from "../shared/dom";
import { icon } from "../shared/icons";

export interface MenuItem {
  label: string;
  /** Short, muted second line */
  desc?: string;
  /** Show a check mark (current choice of a dropdown) */
  selected?: boolean;
  /** Colour dot in front of the label (groups) */
  color?: string;
  onSelect: () => void;
}

/** Colour names for sessions and groups; CSS: --c-<name> in styles.css */
export const COLORS = ["red", "orange", "yellow", "green", "teal", "blue", "purple", "pink"] as const;

export type MenuEntry =
  | MenuItem
  | { heading: string }
  | { separator: true }
  /** Row of colour swatches; "" = no colour */
  | { colors: true; current: string; onPick: (color: string) => void; title: (color: string) => string };

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
  const items = [...open.el.querySelectorAll<HTMLButtonElement>(".menu-item")];
  const i = items.indexOf(document.activeElement as HTMLButtonElement);
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    const a = open.anchor;
    closeMenu();
    a.focus();
  } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const n = items.length;
    items[(i + (e.key === "ArrowDown" ? 1 : n - 1) + n) % n]?.focus();
  }
}

function entry(it: MenuEntry): HTMLElement {
  if ("heading" in it) return h("div", { class: "menu-head" }, it.heading);
  if ("separator" in it) return h("div", { class: "menu-sep" });
  if ("colors" in it)
    return h(
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
  return item(it);
}

function item(it: MenuItem): HTMLElement {
  return h(
    "button",
    {
      type: "button",
      role: "menuitem",
      class: `menu-item ${it.selected ? "sel" : ""}`,
      onclick: () => {
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
