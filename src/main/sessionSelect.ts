// Session list: select several sessions (⌘-click, ⇧-click) and drag & drop them onto groups or the drop zones
// (pin, no group, new group). The bar at the bottom of the left column offers actions for the selection.
import { $, h } from "../shared/dom";
import { icon } from "../shared/icons";
import { t } from "../shared/i18n";
import {
  closeSessionsDialog,
  colorMenu,
  deleteSessionsDialog,
  groupPickerMenu,
  metaOf,
  newGroupDialog,
  setMetaMany,
} from "./sessionGroups";
import { renderHosts } from "./sessions";
import { state } from "./state";

const MIME = "application/x-pibar-sessions";

/** Selected sessions, key "<hostId>|<sessionPath>" */
export const selection = new Set<string>();
/** Last plain or ⌘-clicked session, start of a ⇧-click range */
let anchor: string | null = null;
/** Saved sessions in the order they are shown (filled while rendering) */
let order: string[] = [];
/** Keys being dragged right now */
let dragging: string[] = [];

export function resetOrder() {
  order = [];
}

export function noteVisible(key: string) {
  order.push(key);
}

export function clearSelection() {
  if (!selection.size) return;
  selection.clear();
  renderHosts();
}

/** Click with ⌘/Ctrl or ⇧ changes the selection; returns true if the click was handled that way */
export function selectClick(e: MouseEvent, key: string): boolean {
  if (e.metaKey || e.ctrlKey) {
    if (selection.has(key)) selection.delete(key);
    else selection.add(key);
    anchor = key;
    renderHosts();
    return true;
  }
  if (e.shiftKey) {
    const from = order.indexOf(anchor ?? "");
    const to = order.indexOf(key);
    if (from < 0 || to < 0) {
      selection.add(key);
    } else {
      for (let i = Math.min(from, to); i <= Math.max(from, to); i++) selection.add(order[i]);
    }
    renderHosts();
    return true;
  }
  anchor = key;
  if (selection.size) clearSelection();
  return false;
}

// ---------- Drag & drop ----------

/** Start dragging a row: the whole selection if the row is part of it */
export function dragStart(e: DragEvent, key: string) {
  dragging = selection.has(key) ? [...selection] : [key];
  e.dataTransfer?.setData(MIME, JSON.stringify(dragging));
  e.dataTransfer?.setData("text/plain", t("{n} sessions", { n: dragging.length }));
  if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
  if (dragging.length > 1 && e.dataTransfer) {
    const ghost = h("div", { class: "drag-ghost" }, t("{n} sessions", { n: dragging.length }));
    document.body.append(ghost);
    e.dataTransfer.setDragImage(ghost, 12, 12);
    setTimeout(() => ghost.remove(), 0);
  }
  // show the drop zones after the drag has started (changing the DOM inside dragstart can cancel it)
  setTimeout(() => {
    document.body.classList.add("dragging-sess");
    $("sess-drop").hidden = false;
  }, 0);
}

function dragEnd() {
  dragging = [];
  document.body.classList.remove("dragging-sess");
  $("sess-drop").hidden = true;
  document.querySelectorAll(".drop-over").forEach((x) => x.classList.remove("drop-over"));
}

/** Make an element accept dragged sessions */
export function dropTarget(el: HTMLElement, onDrop: (keys: string[]) => void) {
  const accepts = (e: DragEvent) => !!e.dataTransfer?.types.includes(MIME);
  el.addEventListener("dragover", (e) => {
    if (!accepts(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    el.classList.add("drop-over");
  });
  el.addEventListener("dragleave", (e) => {
    if (!el.contains(e.relatedTarget as Node)) el.classList.remove("drop-over");
  });
  el.addEventListener("drop", (e) => {
    if (!accepts(e)) return;
    e.preventDefault();
    e.stopPropagation();
    let keys = dragging;
    try {
      keys = JSON.parse(e.dataTransfer!.getData(MIME));
    } catch {
      /* use the remembered keys */
    }
    dragEnd();
    if (keys.length) onDrop(keys);
  });
}

// ---------- Selection bar ----------

/** Bar at the bottom of the left column while sessions are selected */
export function renderSelectionBar() {
  const bar = $("sel-bar");
  // drop keys that are no longer shown (session deleted or host removed)
  for (const k of [...selection]) if (!order.includes(k)) selection.delete(k);
  bar.hidden = !selection.size;
  if (!selection.size) return bar.replaceChildren();
  const keys = [...selection];
  const allPinned = keys.every((k) => metaOf(k).pinned);
  const open = keys.map((k) => state.tabs.get(k)).filter((x) => x?.alive);
  const btn = (label: string, fn: (e: MouseEvent) => void) =>
    h("button", { class: "ghost small", type: "button", onclick: fn }, label);
  bar.replaceChildren(
    h(
      "div",
      { class: "sel-top" },
      h("span", { class: "sel-count" }, t("{n} selected", { n: keys.length })),
      h("span", { class: "sel-hint" }, t("drag onto a group")),
      h(
        "button",
        { class: "icon-btn", title: t("Clear selection (Esc)"), onclick: () => clearSelection() },
        icon("close", 13),
      ),
    ),
    h(
      "div",
      { class: "sel-acts" },
      btn(t("Group …"), (e) => groupPickerMenu(e.currentTarget as HTMLElement, keys)),
      btn(t("Colour …"), (e) => colorMenu(e.currentTarget as HTMLElement, keys)),
      btn(allPinned ? t("Unpin") : t("Pin to top"), () => setMetaMany(keys, { pinned: !allPinned })),
      open.length ? btn(t("Close"), () => closeSessionsDialog(keys)) : null,
      h(
        "button",
        { class: "ghost small danger-text", type: "button", onclick: () => deleteSessionsDialog(keys) },
        t("Delete …"),
      ),
    ),
  );
}

export function wireSessionSelect() {
  const zones = $("sess-drop");
  dropTarget(zones.querySelector<HTMLElement>('[data-drop="pin"]')!, (keys) => setMetaMany(keys, { pinned: true }));
  dropTarget(zones.querySelector<HTMLElement>('[data-drop="ungroup"]')!, (keys) =>
    setMetaMany(keys, { group: "", pinned: false }),
  );
  dropTarget(zones.querySelector<HTMLElement>('[data-drop="new"]')!, (keys) =>
    newGroupDialog((g) => setMetaMany(keys, { group: g.id, pinned: false })),
  );
  document.addEventListener("dragend", dragEnd);
  document.addEventListener("keydown", (e) => {
    const busy = !!document.querySelector(".modal-backdrop, .menu");
    if (e.key === "Escape" && selection.size && !busy) clearSelection();
    // ⌫ / Delete: delete the selection (or the focused session row) – not while typing somewhere
    if ((e.key === "Backspace" || e.key === "Delete") && !busy) {
      const el = document.activeElement as HTMLElement | null;
      const typing = !!el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable);
      const focused = el?.dataset?.key;
      const keys = typing ? [] : selection.size ? [...selection] : focused ? [focused] : [];
      if (keys.length) {
        e.preventDefault();
        deleteSessionsDialog(keys);
      }
    }
  });
}
