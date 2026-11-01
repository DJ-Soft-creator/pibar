// Right column: folders of the active session as a tree of Markdown files, and the editor.
import { folderField } from "./folderPicker";
import { addContextPath, PATH_DRAG } from "./composerTools";
import { api, FolderListing, GitInfo } from "../shared/api";
import { $, h, errMsg, openModal, renderMarkdown, toast } from "../shared/dom";
import { baseName } from "../shared/format";
import { t } from "../shared/i18n";
import { buildTree, countFiles, TreeDir } from "../shared/tree";
import { diffLines, diffStats, hunks, type DiffLine } from "../shared/diff";
import { allChanges, gitInline, gitLine, gitMark, gitStatusFor } from "../shared/git";
import { openMenu } from "./menu";
import type { SessionTab } from "./sessionTab";
import { saveConfig, state } from "./state";

const elFileTree = $("file-tree");
const elEditor = $("editor");
const elEdText = $("ed-text") as HTMLTextAreaElement;
const elEdRender = $("ed-render");
const elEdDiff = $("ed-diff-view");
const elEdSave = $("ed-save") as HTMLButtonElement;

type EditorMode = "edit" | "preview" | "diff";
/** Base of the diff view: Git HEAD or the file as saved */
type DiffBase = "head" | "saved";

/** File open in the editor */
const editor = {
  hostId: "",
  path: "",
  original: "",
  mode: "edit" as EditorMode,
  diffBase: "head" as DiffBase,
  /** Content in Git HEAD of the open file; undefined = not loaded yet */
  head: undefined as { inGit: boolean; text: string | null } | undefined,
};

/** Working folder plus folders added by hand to a session */
function sessionFolders(tab: SessionTab): string[] {
  return [tab.cwd, ...(state.config.sessionFolders[tab.key] ?? [])];
}

/** Open/closed folders in the tree: key "<root>|<relative path>" ("" = the session folder itself) */
const openDirs = new Set<string>();
const closedRoots = new Set<string>();

const ICON_DIR =
  '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M1.75 4.25a1 1 0 0 1 1-1h3.4l1.5 1.5h5.6a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H2.75a1 1 0 0 1-1-1z"/></svg>';
const ICON_IMAGE =
  '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="2" y="2.5" width="12" height="11" rx="1.5"/><circle cx="6" cy="6.5" r="1.3"/><path d="M2.5 12l3.5-3.5 2.5 2.5 2-2 3 3"/></svg>';
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

/** Pi changed this file in the session (edit/write); Pi's paths may be relative to the working folder or "~/…" */
function edited(tab: SessionTab, full: string): boolean {
  if (!tab.touched.size) return false;
  const work = last?.listings[0]?.root ?? "";
  for (const p of tab.touched) {
    if (p === full) return true;
    if (p.startsWith("~/") && full.endsWith(p.slice(1))) return true;
    if (!p.startsWith("/") && work && full === `${work}/${p.replace(/^\.\//, "")}`) return true;
  }
  return false;
}

/** Tree rows can be dragged into the input (context of the next message) */
function pathDrag(kind: "folder" | "file", path: string) {
  return {
    draggable: "true",
    ondragstart: (e: DragEvent) => {
      if (!e.dataTransfer) return;
      e.dataTransfer.setData(PATH_DRAG, JSON.stringify({ kind, path }));
      e.dataTransfer.setData("text/plain", path);
      e.dataTransfer.effectAllowed = "copy";
    },
  };
}

/** Right click on a folder: into the context, or create something in it */
function folderMenu(e: MouseEvent, tab: SessionTab, path: string) {
  e.preventDefault();
  const anchor = e.currentTarget as HTMLElement;
  openMenu(
    anchor,
    [
      { label: t("Add to context"), onSelect: () => addContextPath("folder", path) },
      { label: t("New file or folder"), onSelect: () => createMenu(anchor, tab, path) },
    ],
    "left",
    { x: e.clientX, y: e.clientY },
  );
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
            ...pathDrag("folder", full),
            oncontextmenu: (e: MouseEvent) => folderMenu(e, tab, full),
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
          ...pathDrag("file", full),
          oncontextmenu: (e: MouseEvent) => {
            e.preventDefault();
            openMenu(
              e.currentTarget as HTMLElement,
              [
                { label: t("Open"), onSelect: () => openFile(tab.hostId, full) },
                { label: t("Add to context"), onSelect: () => addContextPath("file", full) },
                ...(isImage(full)
                  ? []
                  : [{ label: t("Show changes (diff)"), onSelect: () => openFile(tab.hostId, full, "diff") }]),
              ],
              "left",
              { x: e.clientX, y: e.clientY },
            );
          },
        },
        icon(/\.(png|jpe?g|gif|webp)$/i.test(f.name) ? ICON_IMAGE : ICON_FILE),
        h("span", { class: "tname" }, f.name),
        edited(tab, full) ? h("span", { class: "tedited", title: t("Changed by Pi in this session") }, "✎") : null,
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
            ...pathDrag("folder", root),
            oncontextmenu: (e: MouseEvent) => folderMenu(e, tab, root),
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
          h("button", { class: "icon-btn", title: t("Reload"), onclick: () => reloadFiles() }, "↻"),
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
              : [
                  h(
                    "div",
                    { class: "hint-line" },
                    state.config.ui.filesDocsOnly ? t("No Markdown or HTML files") : t("No files"),
                  ),
                ];
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
    listings = await api.listFiles(
      tab.hostId,
      sessionFolders(tab),
      !!state.config.ui.showGit,
      !!state.config.ui.filesDocsOnly,
    );
  } catch (e) {
    elFileTree.replaceChildren(h("p", { class: "pad host-err" }, errMsg(e)));
    return;
  }
  if (tab !== state.active) return; // another session was selected meanwhile
  loadedAt = Date.now();
  last = { tab, listings };
  renderTree();
}

/** Time of the last load, so a refresh on window focus does not run again and again */
let loadedAt = 0;

/**
 * Reload tree and Git status, and the open file if it has no unsaved changes (Pi may have changed it).
 * Button in the panel header, ⌘⇧R, after each run of the active session and when the window gets the focus again.
 */
export async function reloadFiles() {
  loadedAt = Date.now();
  await renderFiles();
  const path = editor.path;
  if (!path || !isEditorOpen() || elEdText.value !== editor.original) return;
  if (isImage(path)) return void openImage(editor.hostId, path);
  try {
    const text = await api.readFile(editor.hostId, path);
    if (editor.path !== path || elEdText.value !== editor.original || text === editor.original) return;
    editor.original = text;
    editor.head = undefined; // Git HEAD may have moved too (commit)
    elEdText.value = text;
    elEdSave.disabled = true;
    setMode(editor.mode);
  } catch {
    /* file gone or unreadable: the tree shows the current state */
  }
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
      h(
        "div",
        { class: "row" },
        h("label", {}, t("Folder on the host")),
        folderField(input, () => tab.hostId),
      ),
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
    if (!/\.[a-z0-9]+$/i.test(name)) name += ".md"; // own extension stays, none → Markdown
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

const isImage = (path: string) => /\.(png|jpe?g|gif|webp)$/i.test(path);

/** Images are only shown: no edit, preview or diff */
function setImageMode(on: boolean) {
  elEditor.classList.toggle("image", on);
  for (const m of ["edit", "preview", "diff"] as const) ($(`ed-${m}`) as HTMLButtonElement).hidden = on;
  elEdSave.hidden = on;
}

async function openImage(hostId: string, path: string) {
  try {
    const img = await api.readImage(hostId, path);
    Object.assign(editor, { hostId, path, original: "", head: undefined });
    elEdText.value = "";
    $("editor-name").textContent = baseName(path);
    $("editor-name").title = path;
    showEditor(true);
    setImageMode(true);
    elEdText.hidden = true;
    elEdDiff.hidden = true;
    elEdRender.hidden = false;
    elEdRender.classList.remove("md", "html");
    const el = h("img", { class: "file-image", src: `data:${img.mimeType};base64,${img.data}`, alt: baseName(path) });
    elEdRender.replaceChildren(h("div", { class: "image-view" }, el));
    elFileTree
      .querySelectorAll<HTMLElement>(".file")
      .forEach((b) => b.classList.toggle("active", b.dataset.path === path));
  } catch (e) {
    toast(`${t("Read file")}: ${errMsg(e)}`, "err");
  }
}

async function openFile(hostId: string, path: string, mode?: EditorMode) {
  if (editor.path !== path && !confirmDiscard()) return;
  if (isImage(path)) return openImage(hostId, path);
  setImageMode(false);
  try {
    const text = await api.readFile(hostId, path);
    Object.assign(editor, { hostId, path, original: text, head: undefined });
    elEdText.value = text;
    $("editor-name").textContent = baseName(path);
    $("editor-name").title = path;
    elEdSave.disabled = true;
    showEditor(true);
    // HTML opens rendered; Markdown in the last used mode (but not in the diff)
    setMode(mode ?? (isHtml(path) ? "preview" : editor.mode === "diff" ? "edit" : editor.mode));
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

const isHtml = (path: string) => /\.html?$/i.test(path);
const isMarkdown = (path: string) => /\.(md|markdown)$/i.test(path);

/**
 * HTML preview in a sandboxed frame: no scripts, forms or popups, no access to PiBar. It keeps the page's
 * Content Security Policy, so styles in the file and embedded (data:) images show, files from the web do not.
 */
function renderHtml(target: HTMLElement, html: string) {
  const frame = document.createElement("iframe");
  frame.className = "html-frame";
  frame.setAttribute("sandbox", "");
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.title = t("HTML preview");
  frame.srcdoc = html;
  target.replaceChildren(frame);
}

function setMode(mode: EditorMode) {
  editor.mode = mode;
  for (const m of ["edit", "preview", "diff"] as const) $(`ed-${m}`).classList.toggle("active", m === mode);
  elEdText.hidden = mode !== "edit";
  elEdRender.hidden = mode !== "preview";
  elEdDiff.hidden = mode !== "diff";
  const html = isHtml(editor.path);
  // other text files (code, JSON, …): edit and diff, no preview
  const plain = !html && !isMarkdown(editor.path);
  ($("ed-preview") as HTMLButtonElement).hidden = plain;
  if (plain && mode === "preview") return setMode("edit");
  elEdRender.classList.toggle("md", !html);
  elEdRender.classList.toggle("html", html);
  if (mode === "preview") {
    if (html) renderHtml(elEdRender, elEdText.value);
    else renderMarkdown(elEdRender, elEdText.value);
  }
  if (mode === "diff") void renderDiff();
}

/** Diff of the editor text (incl. unsaved changes) against Git HEAD or the saved file */
async function renderDiff() {
  const path = editor.path;
  if (editor.head === undefined) {
    elEdDiff.replaceChildren(h("div", { class: "diff-empty" }, t("Loading …")));
    try {
      editor.head = await api.readFileHead(editor.hostId, path);
    } catch {
      editor.head = { inGit: false, text: null };
    }
    if (editor.path !== path || editor.mode !== "diff") return;
  }
  const head = editor.head;
  const base: DiffBase = head.inGit ? editor.diffBase : "saved";
  const oldText = base === "head" ? (head.text ?? "") : editor.original;
  const diff = diffLines(oldText, elEdText.value);
  const { added, removed } = diffStats(diff);

  const sel = h(
    "select",
    { class: "diff-base", title: t("Compare with") },
    h("option", { value: "head", selected: base === "head", disabled: !head.inGit }, t("Git (last commit)")),
    h("option", { value: "saved", selected: base === "saved" }, t("Saved file")),
  ) as HTMLSelectElement;
  sel.addEventListener("change", () => {
    editor.diffBase = sel.value as DiffBase;
    void renderDiff();
  });
  const note =
    base === "head" && head.text === null
      ? t("New file, not in Git yet")
      : !head.inGit
        ? t("Not in a Git repository")
        : "";
  const bar = h(
    "div",
    { class: "diff-bar" },
    sel,
    h("span", { class: "diff-stat add" }, `+${added}`),
    h("span", { class: "diff-stat del" }, `−${removed}`),
    note ? h("span", { class: "diff-note" }, note) : null,
  );
  if (!added && !removed) {
    elEdDiff.replaceChildren(bar, h("div", { class: "diff-empty" }, t("No changes")));
    return;
  }
  const row = (d: DiffLine) =>
    h(
      "div",
      { class: `dl ${d.op === "+" ? "add" : d.op === "-" ? "del" : ""}` },
      h("span", { class: "dn" }, d.a ? String(d.a) : ""),
      h("span", { class: "dn" }, d.b ? String(d.b) : ""),
      h("span", { class: "dop" }, d.op),
      h("span", { class: "dt" }, d.text),
    );
  const body = h(
    "div",
    { class: "diff-body" },
    ...hunks(diff).map((x) =>
      "op" in x ? row(x) : h("div", { class: "dl gap" }, t("{n} unchanged lines", { n: String(x.skipped) })),
    ),
  );
  elEdDiff.replaceChildren(bar, body);
}

export async function saveEditor() {
  if (!editor.path || elEdText.value === editor.original) return;
  const content = elEdText.value;
  elEdSave.disabled = true;
  try {
    await api.writeFile(editor.hostId, editor.path, content);
    editor.original = content;
    if (editor.mode === "diff") void renderDiff();
    toast(t("Saved: {file}", { file: baseName(editor.path) }));
  } catch (e) {
    elEdSave.disabled = false;
    toast(`${t("Saving failed")}: ${errMsg(e)}`, "err");
  }
}

export function wireFiles() {
  $("btn-add-folder").addEventListener("click", (e) => headMenu(e.currentTarget as HTMLElement));
  $("btn-reload-files").addEventListener("click", () => reloadFiles());
  const filter = $("btn-files-filter");
  filter.classList.toggle("on", !!state.config.ui.filesDocsOnly);
  filter.addEventListener("click", () => {
    state.config.ui.filesDocsOnly = !state.config.ui.filesDocsOnly;
    filter.classList.toggle("on", state.config.ui.filesDocsOnly);
    saveConfig();
    void renderFiles();
  });
  // back in PiBar after working elsewhere (editor, terminal, git): show the current state
  window.addEventListener("focus", () => {
    if (state.active && Date.now() - loadedAt > 5000) void reloadFiles();
  });
  $("ed-edit").addEventListener("click", () => setMode("edit"));
  $("ed-preview").addEventListener("click", () => setMode("preview"));
  $("ed-diff").addEventListener("click", () => setMode("diff"));
  $("ed-close").addEventListener("click", closeEditor);
  elEdSave.addEventListener("click", saveEditor);
  elEdText.addEventListener("input", () => (elEdSave.disabled = elEdText.value === editor.original));
}
