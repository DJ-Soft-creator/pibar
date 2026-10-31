// Right column: folders of the active session as a tree of Markdown files, and the editor.
import { api, FolderListing, GitInfo } from "../shared/api";
import { $, h, errMsg, openModal, renderMarkdown, toast } from "../shared/dom";
import { baseName } from "../shared/format";
import { t } from "../shared/i18n";
import { buildTree, countFiles, TreeDir } from "../shared/tree";
import { allChanges, gitInline, gitLine, gitMark, gitStatusFor } from "../shared/git";
import { openMenu } from "./menu";
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

/** Open/closed folders in the tree: key "<root>|<relative path>" ("" = the session folder itself) */
const openDirs = new Set<string>();
const closedRoots = new Set<string>();

const ICON_DIR =
  '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M1.75 4.25a1 1 0 0 1 1-1h3.4l1.5 1.5h5.6a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H2.75a1 1 0 0 1-1-1z"/></svg>';
const ICON_FILE =
  '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M4 1.75h5l3 3v9.5H4z"/><path d="M9 1.75v3h3M6 8.5h4M6 11h4"/></svg>';

function icon(svg: string): HTMLElement {
  const el = h("span", { class: "ti" });
  el.innerHTML = svg;
  return el;
}

function chev(open: boolean): HTMLElement {
  return h("span", { class: `tchev ${open ? "open" : ""}` }, "›");
}

/** Rows of a folder's content, indented by depth */
/** Git repositories of the folder being rendered and all their changes (empty = off or none) */
let repos: GitInfo[] = [];
let changes: ReturnType<typeof allChanges> = [];

/** Repository folder: branch and ↑/↓; other folders with changes: a dot */
function dirGit(path: string): HTMLElement[] {
  const repo = repos.find((r) => r.dir === path);
  if (repo) return [gitInline(repo)];
  return gitStatusFor(changes, `${path}/`) ? [h("span", { class: "gdot", title: t("Contains changes") })] : [];
}

function treeRows(tab: SessionTab, root: string, dir: TreeDir, depth: number): HTMLElement[] {
  const rows: HTMLElement[] = [];
  const pad = `padding-left:${8 + depth * 14}px`;
  for (const d of dir.dirs) {
    const key = `${root}|${d.path}`;
    const open = openDirs.has(key);
    const n = countFiles(d);
    const full = `${root}/${d.path}`;
    rows.push(
      h(
        "div",
        { class: "tline" },
        h(
          "button",
          {
            class: "trow tdir",
            style: pad,
            title: full,
            onclick: () => {
              if (open) openDirs.delete(key);
              else openDirs.add(key);
              renderTree();
            },
          },
          chev(open),
          icon(ICON_DIR),
          h("span", { class: "tname" }, d.name),
          ...dirGit(d.path),
          n ? h("span", { class: "tcount" }, String(n)) : null,
        ),
        h(
          "span",
          { class: "folder-acts" },
          h(
            "button",
            {
              class: "icon-btn",
              title: t("New file or folder"),
              onclick: (e: MouseEvent) => createMenu(e.currentTarget as HTMLElement, tab, full),
            },
            "＋",
          ),
        ),
      ),
    );
    if (open) rows.push(...treeRows(tab, root, d, depth + 1));
  }
  for (const f of dir.files) {
    const full = `${root}/${f.path}`;
    rows.push(
      h(
        "button",
        {
          class: `trow file ${editor.path === full ? "active" : ""}`,
          style: `padding-left:${8 + depth * 14 + 16}px`,
          title: full,
          "data-path": full,
          onclick: () => openFile(tab.hostId, full),
        },
        icon(ICON_FILE),
        h("span", { class: "tname" }, f.name),
        changes.length ? gitMark(gitStatusFor(changes, f.path)) : null,
      ),
    );
  }
  return rows;
}

/** Last listings, so opening/closing folders does not reload from the host */
let last: { tab: SessionTab; listings: FolderListing[] } | null = null;

function renderTree() {
  if (!last || last.tab !== state.active) return;
  const { tab, listings } = last;
  const extra = state.config.sessionFolders[tab.key] ?? [];
  elFileTree.replaceChildren(
    ...listings.map((l, i) => {
      const root = l.root || l.folder;
      const open = !closedRoots.has(root);
      const removable = i > 0;
      const head = h(
        "div",
        { class: "folder-head" },
        h(
          "button",
          {
            class: "trow troot",
            title: root,
            onclick: () => {
              if (open) closedRoots.add(root);
              else closedRoots.delete(root);
              renderTree();
            },
          },
          chev(open),
          icon(ICON_DIR),
          h("span", { class: "tname" }, baseName(root)),
          i === 0 ? h("span", { class: "tbadge" }, t("working folder")) : null,
        ),
        h(
          "span",
          { class: "folder-acts" },
          l.missing || l.error
            ? null
            : h(
                "button",
                {
                  class: "icon-btn",
                  title: t("New file or folder"),
                  onclick: (e: MouseEvent) => createMenu(e.currentTarget as HTMLElement, tab, l.root),
                },
                "＋",
              ),
          h("button", { class: "icon-btn", title: t("Reload"), onclick: () => renderFiles() }, "↻"),
          removable
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
      );
      repos = l.git ?? [];
      changes = allChanges(repos);
      let body: (HTMLElement | null)[] = [];
      if (open) {
        if (l.missing)
          body = [
            h(
              "div",
              { class: "folder-missing" },
              h("div", {}, t("This folder does not exist on {host}.", { host: hostName(tab.hostId) })),
              h("code", {}, l.folder),
              h(
                "div",
                { class: "fm-acts" },
                h("button", { class: "ghost small", onclick: () => createFolder(tab, l.folder) }, t("Create folder")),
                removable
                  ? h(
                      "button",
                      { class: "ghost small", onclick: () => removeFolder(tab, extra[i - 1]) },
                      t("Remove from session"),
                    )
                  : null,
              ),
            ),
          ];
        else if (l.error) body = [h("div", { class: "host-err" }, l.error)];
        else {
          const tree = buildTree(l.files);
          body =
            tree.dirs.length || tree.files.length
              ? treeRows(tab, l.root, tree, 1)
              : [h("div", { class: "hint-line" }, t("No .md files"))];
        }
      }
      const own = repos.find((r) => r.dir === "");
      return h("div", { class: `folder ${l.missing ? "missing" : ""}` }, head, own ? gitLine(own) : null, ...body);
    }),
  );
}

function hostName(hostId: string): string {
  return state.config.hosts.find((x) => x.id === hostId)?.name ?? hostId;
}

async function createFolder(tab: SessionTab, folder: string) {
  try {
    await api.createDir(tab.hostId, folder);
    await renderFiles();
  } catch (e) {
    toast(`${t("Create folder")}: ${errMsg(e)}`, "err");
  }
}

export async function renderFiles() {
  const tab = state.active;
  if (!tab) {
    last = null;
    elFileTree.replaceChildren(h("p", { class: "muted pad" }, t("No session open.")));
    return;
  }
  if (last?.tab !== tab) elFileTree.replaceChildren(h("p", { class: "muted pad" }, t("Loading files …")));
  let listings: FolderListing[];
  try {
    listings = await api.listFiles(tab.hostId, sessionFolders(tab), !!state.config.ui.showGit);
  } catch (e) {
    elFileTree.replaceChildren(h("p", { class: "pad host-err" }, errMsg(e)));
    return;
  }
  if (tab !== state.active) return; // another session was selected meanwhile
  last = { tab, listings };
  renderTree();
}

// ---------- Create menus ----------

/** "+" in a folder row: new Markdown file or new folder inside `base` (absolute path) */
function createMenu(anchor: HTMLElement, tab: SessionTab, base: string) {
  const where = t("in {folder}", { folder: baseName(base) });
  openMenu(
    anchor,
    [
      { label: t("New Markdown file"), desc: where, onSelect: () => newFileDialog(tab, base) },
      { label: t("New folder"), desc: where, onSelect: () => newFolderDialog(tab, base) },
    ],
    "right",
  );
}

/** "+" in the panel head: file or folder in the working folder, or add another folder to the session */
function headMenu(anchor: HTMLElement) {
  const tab = state.active;
  if (!tab) return;
  const work = (last?.tab === tab && last.listings[0]?.root) || tab.cwd;
  const where = t("in {folder}", { folder: baseName(work) });
  openMenu(
    anchor,
    [
      { label: t("New Markdown file"), desc: where, onSelect: () => newFileDialog(tab, work) },
      { label: t("New folder"), desc: where, onSelect: () => newFolderDialog(tab, work) },
      {
        label: t("Add folder to session"),
        desc: t("Show another folder of the host here"),
        onSelect: addFolderDialog,
      },
    ],
    "right",
  );
}

/** Open the tree down to `full` (a file or folder just created) */
function reveal(full: string, isDir: boolean) {
  for (const l of last?.listings ?? []) {
    if (!l.root || !full.startsWith(`${l.root}/`)) continue;
    closedRoots.delete(l.root);
    const parts = full.slice(l.root.length + 1).split("/");
    const upto = isDir ? parts.length : parts.length - 1;
    for (let i = 1; i <= upto; i++) openDirs.add(`${l.root}|${parts.slice(0, i).join("/")}`);
  }
}

function newFolderDialog(tab: SessionTab, base: string) {
  const input = h("input", { type: "text", placeholder: t("new-folder") }) as HTMLInputElement;
  const create = async () => {
    const name = input.value.trim().replace(/^\/+|\/+$/g, "");
    if (!name) return;
    const path = `${base}/${name}`;
    try {
      await api.createDir(tab.hostId, path);
      close();
      reveal(path, true);
      await renderFiles();
    } catch (e) {
      toast(`${t("Create folder")}: ${errMsg(e)}`, "err");
    }
  };
  input.addEventListener("keydown", (e) => e.key === "Enter" && create());
  const close = openModal(
    t("New folder"),
    h("div", {}, h("div", { class: "row" }, h("label", {}, t("Name")), input), h("p", { class: "hint" }, base)),
    [
      h("button", { class: "ghost", onclick: () => close() }, t("Cancel")),
      h("button", { class: "primary", onclick: create }, t("Create")),
    ],
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
      reveal(path, false);
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
    showEditor(true);
    setPreview(editor.preview);
    elFileTree
      .querySelectorAll<HTMLElement>(".file")
      .forEach((b) => b.classList.toggle("active", b.dataset.path === path));
  } catch (e) {
    toast(`${t("Read file")}: ${errMsg(e)}`, "err");
  }
}

// ---------- Editor ----------

/** Editor below the tree, with the draggable divider in between */
function showEditor(on: boolean) {
  elEditor.hidden = !on;
  $("rs-files").hidden = !on;
  elEditor.parentElement?.classList.toggle("has-editor", on);
}

export function isEditorOpen(): boolean {
  return !elEditor.hidden;
}

function confirmDiscard(): boolean {
  if (elEditor.hidden || elEdText.value === editor.original) return true;
  return window.confirm(t("Discard unsaved changes?"));
}

export function closeEditor() {
  if (!confirmDiscard()) return;
  showEditor(false);
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
  $("btn-add-folder").addEventListener("click", (e) => headMenu(e.currentTarget as HTMLElement));
  $("ed-edit").addEventListener("click", () => setPreview(false));
  $("ed-preview").addEventListener("click", () => setPreview(true));
  $("ed-close").addEventListener("click", closeEditor);
  elEdSave.addEventListener("click", saveEditor);
  elEdText.addEventListener("input", () => (elEdSave.disabled = elEdText.value === editor.original));
}
