// Right column: folders of the active session, Markdown file list and editor.
import { api, FolderListing } from "../shared/api";
import { $, h, errMsg, openModal, renderMarkdown, toast } from "../shared/dom";
import { baseName } from "../shared/format";
import { t } from "../shared/i18n";
import type { SessionTab } from "./sessionTab";
import { saveConfig, state } from "./state";

const elFileTree = $("file-tree");
const elEditor = $("editor");
const elEdText = $("ed-text") as HTMLTextAreaElement;
const elEdRender = $("ed-render");
const elEdSave = $("ed-save") as HTMLButtonElement;

/** File open in the editor */
const editor = { hostId: "", path: "", original: "", preview: false };

/** Working folder plus folders added by hand to a session */
function sessionFolders(tab: SessionTab): string[] {
  return [tab.cwd, ...(state.config.sessionFolders[tab.key] ?? [])];
}

export async function renderFiles() {
  const tab = state.active;
  if (!tab) {
    elFileTree.replaceChildren(h("p", { class: "muted pad" }, t("No session open.")));
    return;
  }
  elFileTree.replaceChildren(h("p", { class: "muted pad" }, t("Loading files …")));
  let listings: FolderListing[];
  try {
    listings = await api.listFiles(tab.hostId, sessionFolders(tab));
  } catch (e) {
    elFileTree.replaceChildren(h("p", { class: "pad host-err" }, errMsg(e)));
    return;
  }
  if (tab !== state.active) return; // another session was selected meanwhile
  const extra = state.config.sessionFolders[tab.key] ?? [];
  elFileTree.replaceChildren(
    ...listings.map((l, i) =>
      h(
        "div",
        { class: "folder" },
        h(
          "div",
          { class: "folder-head" },
          h(
            "span",
            { class: "fname", title: l.root || l.folder },
            i === 0 ? `${baseName(l.root || l.folder)} (${t("working folder")})` : baseName(l.root || l.folder),
          ),
          h(
            "button",
            { class: "icon-btn", title: t("New Markdown file"), onclick: () => newFileDialog(tab, l.root) },
            "＋",
          ),
          h("button", { class: "icon-btn", title: t("Reload"), onclick: () => renderFiles() }, "↻"),
          i > 0
            ? h(
                "button",
                {
                  class: "icon-btn",
                  title: t("Remove folder from session"),
                  onclick: () => removeFolder(tab, extra[i - 1]),
                },
                "×",
              )
            : null,
        ),
        h("div", { class: "folder-root" }, l.root || l.folder),
        l.error ? h("div", { class: "host-err" }, l.error) : null,
        !l.error && l.files.length === 0 ? h("div", { class: "hint-line" }, t("No .md files")) : null,
        ...l.files.map((f) => {
          const full = `${l.root}/${f}`;
          return h(
            "button",
            {
              class: `file ${editor.path === full ? "active" : ""}`,
              title: full,
              onclick: () => openFile(tab.hostId, full),
            },
            f,
          );
        }),
      ),
    ),
  );
}

// ---------- Folders ----------

function addFolderDialog() {
  const tab = state.active;
  if (!tab) return;
  const input = h("input", { type: "text", placeholder: t("~/notes") }) as HTMLInputElement;
  const add = () => {
    const v = input.value.trim();
    if (!v) return;
    const list = state.config.sessionFolders[tab.key] ?? [];
    if (!list.includes(v)) list.push(v);
    state.config.sessionFolders[tab.key] = list;
    saveConfig();
    close();
    renderFiles();
  };
  input.addEventListener("keydown", (e) => e.key === "Enter" && add());
  const close = openModal(
    t("Add folder to session"),
    h(
      "div",
      {},
      h("div", { class: "row" }, h("label", {}, t("Folder on the host")), input),
      h("p", { class: "hint" }, t("Its Markdown files appear on the right and can be edited.")),
    ),
    [
      h("button", { class: "ghost", onclick: () => close() }, t("Cancel")),
      h("button", { class: "primary", onclick: add }, t("Add")),
    ],
  );
}

function removeFolder(tab: SessionTab, folder: string) {
  state.config.sessionFolders[tab.key] = (state.config.sessionFolders[tab.key] ?? []).filter((f) => f !== folder);
  saveConfig();
  renderFiles();
}

// ---------- Files ----------

function newFileDialog(tab: SessionTab, root: string) {
  const input = h("input", { type: "text", placeholder: t("note.md") }) as HTMLInputElement;
  const create = async () => {
    let name = input.value.trim();
    if (!name) return;
    if (!/\.(md|markdown)$/i.test(name)) name += ".md";
    const path = `${root}/${name}`;
    try {
      await api.createFile(tab.hostId, path);
      close();
      await renderFiles();
      openFile(tab.hostId, path);
    } catch (e) {
      toast(`${t("Could not create file (does it exist already?)")}: ${errMsg(e)}`, "err");
    }
  };
  input.addEventListener("keydown", (e) => e.key === "Enter" && create());
  const close = openModal(
    t("New Markdown file"),
    h("div", {}, h("div", { class: "row" }, h("label", {}, t("Name")), input), h("p", { class: "hint" }, root)),
    [
      h("button", { class: "ghost", onclick: () => close() }, t("Cancel")),
      h("button", { class: "primary", onclick: create }, t("Create")),
    ],
  );
}

async function openFile(hostId: string, path: string) {
  if (!confirmDiscard()) return;
  try {
    const text = await api.readFile(hostId, path);
    Object.assign(editor, { hostId, path, original: text });
    elEdText.value = text;
    $("editor-name").textContent = baseName(path);
    $("editor-name").title = path;
    elEdSave.disabled = true;
    elEditor.hidden = false;
    setPreview(editor.preview);
    elFileTree
      .querySelectorAll(".file")
      .forEach((b) => b.classList.toggle("active", (b as HTMLElement).title === path));
  } catch (e) {
    toast(`${t("Read file")}: ${errMsg(e)}`, "err");
  }
}

// ---------- Editor ----------

export function isEditorOpen(): boolean {
  return !elEditor.hidden;
}

function confirmDiscard(): boolean {
  if (elEditor.hidden || elEdText.value === editor.original) return true;
  return window.confirm(t("Discard unsaved changes?"));
}

export function closeEditor() {
  if (!confirmDiscard()) return;
  elEditor.hidden = true;
  editor.path = "";
  elFileTree.querySelectorAll(".file.active").forEach((b) => b.classList.remove("active"));
}

function setPreview(on: boolean) {
  editor.preview = on;
  $("ed-edit").classList.toggle("active", !on);
  $("ed-preview").classList.toggle("active", on);
  elEdText.hidden = on;
  elEdRender.hidden = !on;
  if (on) renderMarkdown(elEdRender, elEdText.value);
}

export async function saveEditor() {
  if (!editor.path || elEdText.value === editor.original) return;
  const content = elEdText.value;
  elEdSave.disabled = true;
  try {
    await api.writeFile(editor.hostId, editor.path, content);
    editor.original = content;
    toast(t("Saved: {file}", { file: baseName(editor.path) }));
  } catch (e) {
    elEdSave.disabled = false;
    toast(`${t("Saving failed")}: ${errMsg(e)}`, "err");
  }
}

export function wireFiles() {
  $("btn-add-folder").addEventListener("click", addFolderDialog);
  $("ed-edit").addEventListener("click", () => setPreview(false));
  $("ed-preview").addEventListener("click", () => setPreview(true));
  $("ed-close").addEventListener("click", closeEditor);
  elEdSave.addEventListener("click", saveEditor);
  elEdText.addEventListener("input", () => (elEdSave.disabled = elEdText.value === editor.original));
}
