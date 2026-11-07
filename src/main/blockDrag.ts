// Move whole blocks in the left column (a host or a project) by dragging its grip: the new position is saved in the
// config and stays after a restart. Session drags keep their own MIME type (src/main/sessionSelect.ts).
import { icon } from "../shared/icons";
import { t } from "../shared/i18n";

const MIME = "application/x-pibar-block";

type Kind = "host" | "project";

/** Block being dragged right now; same-window drags only, so no data round trip is needed on drop */
let dragging: { kind: Kind; id: string } | null = null;
let wired = false;

/** Remove the drag marks of all blocks */
function clear() {
  dragging = null;
  document.querySelectorAll(".block.dragging, .block.drop-before, .block.drop-after").forEach((el) => {
    el.classList.remove("dragging", "drop-before", "drop-after");
  });
}

function wire() {
  if (wired) return;
  wired = true;
  document.addEventListener("dragend", clear);
}

/** Grip in a block header: drag it to move the whole block before or after another one */
export function blockGrip(kind: Kind, id: string, label: string): HTMLElement {
  wire();
  const grip = icon("grip", 14, "grip");
  grip.setAttribute("draggable", "true");
  grip.setAttribute("role", "button");
  grip.setAttribute("aria-label", t("Drag to move"));
  grip.title = `${t("Drag to move")} · ${label}`;
  grip.addEventListener("dragstart", (e: DragEvent) => {
    dragging = { kind, id };
    e.dataTransfer?.setData(MIME, `${kind}:${id}`);
    e.dataTransfer?.setData("text/plain", label);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    const block = grip.closest<HTMLElement>(".block");
    // the whole card is dragged, not only the grip (the browser draws it as the drag image)
    if (block) {
      if (e.dataTransfer) e.dataTransfer.setDragImage(block, 16, 16);
      setTimeout(() => block.classList.add("dragging"), 0);
    }
  });
  return grip;
}

/**
 * Make a block a drop target: dropping a block of the same kind moves it before or after this one.
 * `onMove` receives the dragged block id and whether it belongs after this block.
 */
export function blockDrop(el: HTMLElement, kind: Kind, id: string, onMove: (fromId: string, after: boolean) => void) {
  wire();
  const accepts = (e: DragEvent) => !!dragging && dragging.kind === kind && !!e.dataTransfer;
  el.addEventListener("dragover", (e: DragEvent) => {
    if (!accepts(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    const r = el.getBoundingClientRect();
    const after = e.clientY > r.top + r.height / 2;
    el.classList.toggle("drop-after", after);
    el.classList.toggle("drop-before", !after);
  });
  el.addEventListener("dragleave", (e: DragEvent) => {
    if (!el.contains(e.relatedTarget as Node)) el.classList.remove("drop-before", "drop-after");
  });
  el.addEventListener("drop", (e: DragEvent) => {
    if (!accepts(e)) return;
    e.preventDefault();
    e.stopPropagation();
    const after = el.classList.contains("drop-after");
    const from = dragging?.id ?? "";
    clear();
    if (from && from !== id) onMove(from, after);
  });
}
