// Tool dock at the input: a quiet "+" that fades in more buttons (attach files, screenshot, skills, tools) while the
// mouse is near; attachments as chips above the input (also by drag & drop or paste); the Pi tools of a session.
import { api } from "../shared/api";
import { baseName } from "../shared/format";
import { $, h, errMsg, openModal, toast } from "../shared/dom";
import { icon } from "../shared/icons";
import { t } from "../shared/i18n";
import { renderToolbar } from "./chatView";
import { setMeta } from "./sessionGroups";
import { state } from "./state";

/** A file waiting to be sent with the next message */
export interface Attachment {
  name: string;
  /** folder / fileref: only the path goes into the message (context) */
  kind: "image" | "text" | "folder" | "fileref";
  /** path on the host (folder, fileref) */
  path?: string;
  mimeType: string;
  /** base64 for images */
  data?: string;
  /** content of text files */
  text?: string;
}

const MAX_TEXT = 200_000;
const MAX_IMAGE = 10_000_000;
/** Distance in pixels at which the dock opens */
const NEAR = 70;
/** Reach of the dock upwards (towards the chat) */
const NEAR_UP = 16;
/** Pi's built-in tools (default: read, bash, edit, write) */
export const PI_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

let attachments: Attachment[] = [];

export function hasAttachments(): boolean {
  return attachments.length > 0;
}

/** Take the attachments for sending (clears the list) */
export function takeAttachments(): Attachment[] {
  const list = attachments;
  attachments = [];
  renderChips();
  return list;
}

// ---------- Reading files ----------

function toBase64(buf: ArrayBuffer): string {
  let s = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Text if the first bytes contain no NUL and it decodes as UTF-8 */
function asText(buf: ArrayBuffer): string | null {
  const head = new Uint8Array(buf.slice(0, 4096));
  if (head.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return null;
  }
}

export async function addFiles(files: FileList | File[]) {
  for (const f of Array.from(files)) {
    try {
      const buf = await f.arrayBuffer();
      if (f.type.startsWith("image/")) {
        if (f.size > MAX_IMAGE) throw new Error(t("Image too large (max. 10 MB)"));
        attachments.push({ name: f.name || "image.png", kind: "image", mimeType: f.type, data: toBase64(buf) });
      } else {
        if (f.size > MAX_TEXT) throw new Error(t("File too large (max. 200 KB for text)"));
        const text = asText(buf);
        if (text === null) throw new Error(t("Only text files and images can be attached"));
        attachments.push({ name: f.name, kind: "text", mimeType: f.type || "text/plain", text });
      }
    } catch (e) {
      toast(`${f.name}: ${errMsg(e)}`, "err");
    }
  }
  renderChips();
}

/** Drag type for folders and files dragged from the tree */
export const PATH_DRAG = "application/x-pibar-path";

/** Put a folder or file of the tree into the context of the next message */
export function addContextPath(kind: "folder" | "file", path: string) {
  if (attachments.some((a) => a.path === path)) return;
  attachments.push({ name: baseName(path), kind: kind === "folder" ? "folder" : "fileref", mimeType: "", path });
  renderChips();
  ($("input") as HTMLTextAreaElement).focus();
}

// ---------- Chips ----------

function renderChips() {
  const row = $("attach-row");
  row.hidden = !attachments.length;
  row.replaceChildren(
    ...attachments.map((a, i) =>
      h(
        "span",
        { class: `chip ${a.path ? "chip-ctx" : ""}`, title: a.path ?? a.name },
        a.kind === "image"
          ? h("img", { class: "chip-thumb", src: `data:${a.mimeType};base64,${a.data}`, alt: "" })
          : icon(a.kind === "folder" ? "folder" : a.kind === "fileref" ? "file" : "copy", 12, "chip-icon"),
        h("span", { class: "chip-name" }, a.name),
        h(
          "button",
          {
            type: "button",
            class: "chip-x",
            title: t("Remove"),
            onclick: () => {
              attachments.splice(i, 1);
              renderChips();
            },
          },
          icon("close", 11),
        ),
      ),
    ),
  );
  $("btn-dock").classList.toggle("has", attachments.length > 0);
  renderToolbar(); // the send button depends on attachments
}

// ---------- Tools of a session ----------

function toolsDialog() {
  const tab = state.active;
  if (!tab) return;
  const custom = h("input", { type: "radio", name: "toolmode", checked: tab.toolset !== null }) as HTMLInputElement;
  const def = h("input", { type: "radio", name: "toolmode", checked: tab.toolset === null }) as HTMLInputElement;
  const current = new Set(tab.toolset ?? ["read", "bash", "edit", "write"]);
  const boxes = PI_TOOLS.map((name) => {
    const c = h("input", { type: "checkbox", checked: current.has(name), style: "width:auto" }) as HTMLInputElement;
    c.addEventListener("change", () => (custom.checked = true));
    return { name, c };
  });
  const apply = async () => {
    const next = def.checked ? null : boxes.filter((b) => b.c.checked).map((b) => b.name);
    close();
    if (JSON.stringify(next) === JSON.stringify(tab.toolset)) return;
    if (tab.streaming) return toast(t("Pi is still working – stop it first or wait."), "err");
    tab.toolset = next;
    if (tab.sessionPath) setMeta(`${tab.hostId}|${tab.sessionPath}`, { tools: next ?? undefined });
    try {
      await tab.restart(); // Pi gets its tools at start; the session and its history stay
      toast(
        next === null
          ? t("Pi restarted with its default tools")
          : t("Pi restarted with tools: {list}", { list: next.join(", ") || t("none") }),
      );
    } catch (e) {
      toast(errMsg(e), "err");
    }
    renderToolbar();
  };
  const close = openModal(
    t("Tools of this session"),
    h(
      "div",
      {},
      h("label", { class: "check" }, def, ` ${t("Pi's default (read, bash, edit, write)")}`),
      h("label", { class: "check" }, custom, ` ${t("Own selection")}`),
      h("div", { class: "tool-grid" }, ...boxes.map((b) => h("label", { class: "check" }, b.c, ` ${b.name}`))),
      h("p", { class: "hint" }, t("Pi restarts in this session to apply it; the history stays.")),
    ),
    [
      h("button", { class: "ghost", onclick: () => close() }, t("Cancel")),
      h("button", { class: "primary", onclick: apply }, t("Apply")),
    ],
  );
}

/** Dock state for the active session (tools button, custom tools mark) */
export function renderDock() {
  const tab = state.active;
  const ready = !!tab?.alive;
  ($("btn-tools") as HTMLButtonElement).disabled = !ready;
  $("btn-tools").classList.toggle("set", !!tab && tab.toolset !== null);
  ($("btn-attach") as HTMLButtonElement).disabled = !ready;
  ($("btn-shot") as HTMLButtonElement).disabled = !ready;
}

// ---------- Wiring ----------

export function wireComposerTools(input: HTMLTextAreaElement) {
  const dock = $("dock");
  const fileInput = $("file-input") as HTMLInputElement;

  // fade in while the mouse is near the dock (or its buttons), fade out when it leaves
  let raf = 0;
  document.addEventListener("mousemove", (e) => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const r = dock.getBoundingClientRect();
      const p = $("dock-pop").getBoundingClientRect();
      // only a little reach upwards: the chat above (e.g. "read aloud" under the last answer) stays clickable
      const near = (b: DOMRect, up: number) =>
        e.clientX > b.left - NEAR &&
        e.clientX < b.right + NEAR &&
        e.clientY > b.top - up &&
        e.clientY < b.bottom + NEAR;
      dock.classList.toggle("near", near(r, NEAR_UP) || (dock.classList.contains("near") && near(p, NEAR_UP)));
    });
  });
  $("btn-dock").addEventListener("click", () => dock.classList.toggle("open"));
  dock.addEventListener("focusin", () => dock.classList.add("open"));
  dock.addEventListener("focusout", (e) => !dock.contains(e.relatedTarget as Node) && dock.classList.remove("open"));

  $("btn-attach").addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    if (fileInput.files?.length) addFiles(fileInput.files);
    fileInput.value = "";
    input.focus();
  });
  $("btn-shot").addEventListener("click", async () => {
    try {
      const c = await api.captureScreen("region");
      if (c) {
        attachments.push({ name: "screenshot.png", kind: "image", mimeType: c.mimeType, data: c.data });
        renderChips();
      }
    } catch (e) {
      toast(`${t("Screenshot")}: ${errMsg(e)}`, "err");
    }
    input.focus();
  });
  $("btn-tools").addEventListener("click", toolsDialog);

  // drag & drop files onto the input area, paste images
  const composer = $("composer");
  composer.addEventListener("dragover", (e) => {
    const types = e.dataTransfer?.types ?? [];
    if (!types.includes("Files") && !types.includes(PATH_DRAG)) return;
    e.preventDefault();
    composer.classList.add("drop-files");
  });
  composer.addEventListener("dragleave", (e) => {
    if (!composer.contains(e.relatedTarget as Node)) composer.classList.remove("drop-files");
  });
  composer.addEventListener("drop", (e) => {
    const ref = e.dataTransfer?.getData(PATH_DRAG);
    if (ref) {
      e.preventDefault();
      composer.classList.remove("drop-files");
      const { kind, path } = JSON.parse(ref) as { kind: "folder" | "file"; path: string };
      if (state.active?.alive) addContextPath(kind, path);
      return;
    }
    if (!e.dataTransfer?.files.length) return;
    e.preventDefault();
    composer.classList.remove("drop-files");
    if (state.active?.alive) addFiles(e.dataTransfer.files);
  });
  input.addEventListener("paste", (e) => {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (!files.length) return;
    e.preventDefault();
    addFiles(files);
  });
}
