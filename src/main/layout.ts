// Panel layout of the main window: show/hide the side panels, drag their width, the divider between file tree
// and editor, and floating panels when the window is narrow (e.g. half a screen).
import { $ } from "../shared/dom";
import { saveConfig, state } from "./state";

type Side = "left" | "right";

const app = $("app");
const DEFAULT_W: Record<Side, number> = { left: 260, right: 340 };
const MIN_W: Record<Side, number> = { left: 180, right: 240 };
/** The chat keeps at least this much room while dragging */
const MIN_CHAT = 360;
/** Below these window widths a panel floats over the chat instead of taking a column */
const NARROW: Record<Side, number> = { left: 820, right: 1120 };
/** Floating panels opened by hand (only in narrow windows) */
const overlay: Record<Side, boolean> = { left: false, right: false };

function isNarrow(side: Side): boolean {
  return window.innerWidth < NARROW[side];
}

function collapsed(side: Side): boolean {
  return side === "left" ? !!state.config.ui.leftCollapsed : !!state.config.ui.rightCollapsed;
}

function width(side: Side): number {
  const ui = state.config.ui;
  return (side === "left" ? ui.leftWidth : ui.rightWidth) || DEFAULT_W[side];
}

/** Apply widths, collapsed state and floating panels */
export function applyLayout() {
  for (const side of ["left", "right"] as const) {
    app.style.setProperty(`--${side}-size`, `${width(side)}px`);
    const narrow = isNarrow(side);
    if (!narrow) overlay[side] = false;
    const hidden = narrow ? !overlay[side] : collapsed(side);
    app.classList.toggle(`no-${side}`, hidden);
    app.classList.toggle(`ov-${side}`, narrow && overlay[side]);
    $(`tg-${side}`).classList.toggle("off", hidden);
  }
}

/** Panel button / ⌘B: in a wide window toggle the saved setting, in a narrow one the floating panel */
export function togglePanel(side: Side) {
  if (isNarrow(side)) {
    overlay[side] = !overlay[side];
    if (overlay[side]) overlay[side === "left" ? "right" : "left"] = false;
  } else {
    const ui = state.config.ui;
    if (side === "left") ui.leftCollapsed = !ui.leftCollapsed;
    else ui.rightCollapsed = !ui.rightCollapsed;
    saveConfig();
  }
  applyLayout();
}

function closeOverlays() {
  if (!overlay.left && !overlay.right) return;
  overlay.left = overlay.right = false;
  applyLayout();
}

/** Drag handle at the inner edge of a panel; double click restores the default width */
function wireResizer(side: Side, handle: HTMLElement) {
  let dragging = false;
  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    dragging = true;
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add("resizing");
  });
  handle.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const other: Side = side === "left" ? "right" : "left";
    const otherW = app.classList.contains(`no-${other}`) || isNarrow(other) ? 0 : width(other);
    const max = Math.max(MIN_W[side], window.innerWidth - otherW - MIN_CHAT);
    const raw = side === "left" ? e.clientX : window.innerWidth - e.clientX;
    const w = Math.round(Math.min(max, Math.max(MIN_W[side], raw)));
    if (side === "left") state.config.ui.leftWidth = w;
    else state.config.ui.rightWidth = w;
    app.style.setProperty(`--${side}-size`, `${w}px`);
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove("resizing");
    saveConfig();
  };
  handle.addEventListener("pointerup", end);
  handle.addEventListener("pointercancel", end);
  handle.addEventListener("dblclick", () => {
    if (side === "left") state.config.ui.leftWidth = null;
    else state.config.ui.rightWidth = null;
    applyLayout();
    saveConfig();
  });
}

const DEFAULT_SPLIT = 40;

/** Horizontal divider in the right panel between file tree and editor (height in percent of the panel) */
export function applySplit() {
  const pct = state.config.ui.filesSplit || DEFAULT_SPLIT;
  document.querySelector<HTMLElement>(".files")?.style.setProperty("--tree-h", `${pct}%`);
}

function wireSplit(handle: HTMLElement) {
  const pane = document.querySelector<HTMLElement>(".files")!;
  const tree = $("file-tree");
  let dragging = false;
  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    dragging = true;
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add("resizing-v");
  });
  handle.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const r = pane.getBoundingClientRect();
    const top = tree.getBoundingClientRect().top;
    const pct = ((e.clientY - top) / r.height) * 100;
    state.config.ui.filesSplit = Math.round(Math.min(80, Math.max(10, pct)) * 10) / 10;
    applySplit();
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove("resizing-v");
    saveConfig();
  };
  handle.addEventListener("pointerup", end);
  handle.addEventListener("pointercancel", end);
  handle.addEventListener("dblclick", () => {
    state.config.ui.filesSplit = null;
    applySplit();
    saveConfig();
  });
}

export function wireLayout() {
  wireResizer("left", $("rs-left"));
  wireResizer("right", $("rs-right"));
  wireSplit($("rs-files"));
  applySplit();
  $("tg-left").addEventListener("click", () => togglePanel("left"));
  $("tg-right").addEventListener("click", () => togglePanel("right"));
  // a click into the chat closes floating panels
  document.querySelector(".chat")?.addEventListener("pointerdown", closeOverlays);
  let raf = 0;
  window.addEventListener("resize", () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(applyLayout);
  });
  applyLayout();
}
