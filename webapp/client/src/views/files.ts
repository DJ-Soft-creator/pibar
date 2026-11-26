// Files tab (tasks G1–G6): the folder of the open chat session as a tree (or a folder picked with the host's folder
// browser when no chat is open; the last one is remembered in this browser). Folders render lazily (only open ones,
// deep folders load on opening), filter "Markdown, HTML and images only", marks for files Pi changed in the session
// and for the Git status. Screens above the tree: a file (filesView.ts), Git history and commit (filesGit.ts).
// Behaviour reference: src/main/files.ts.
import "./files.css";
import { api, type FolderListing, type GitInfo } from "@shared/api";
import { errMsg, h, toast } from "@shared/dom";
import { shortPath } from "@shared/format";
import { allChanges, gitInline, gitLine, gitMark, gitStatusFor } from "@shared/git";
import { t } from "@shared/i18n";
import { icon } from "@shared/icons";
import { buildTree, countFiles, type TreeDir } from "@shared/tree";
import { onSocketMessage } from "../socketBus";
import { currentRoute, state } from "../state";
import { button, empty, header } from "../ui";
import { newFileDialog, newFolderDialog, pickAndUpload, type UploadProgress } from "./filesActions";
import { commitDialogScreen, hasChanges, repoHistoryScreen } from "./filesGit";
import { folderPicker } from "./filesPicker";
import { actionSheet, deleteDialog, isDoc, joinPath, type FilesCtx, type Screen } from "./filesShared";
import { fileScreen } from "./filesView";

interface Target {
  hostId: string;
  folder: string;
}

const PICKED_KEY = "pibar.files.folder";
const DOCS_KEY = "pibar.files.docsOnly";
const GIT_KEY = "pibar.files.git";
/** The list script stops after this many files (files.rs: LIST, head -n 3000) */
const LIST_MAX = 3000;
/** Folders listed by the script reach this depth; deeper ones load when opened */
const DIR_DEPTH = 4;

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode: only for this visit */
  }
}

const S = {
  /** Folder chosen by hand; `forChat` = the chat that was open then (a different chat wins again) */
  picked: null as (Target & { forChat: string }) | null,
  picking: false,
  /** Target the state below belongs to ("hostId|folder") */
  key: "",
  listing: null as FolderListing | null,
  error: "",
  loading: false,
  loadedAt: 0,
  /** Open folders, relative to the root */
  open: new Set<string>(),
  /** Paths from folders loaded on opening (relative to the root) */
  extra: new Set<string>(),
  deepLoaded: new Set<string>(),
  deepLoading: new Set<string>(),
  /** Paths Pi changed in the open chat's session (as Pi named them) */
  touched: new Set<string>(),
  /** session_touches is answered by another area of the webapp; until then it is skipped */
  touchesMissing: false,
  stack: [] as Screen[],
  upload: null as UploadProgress | null,
  docsOnly: stored(DOCS_KEY) === "1",
  git: stored(GIT_KEY) !== "0",
};

let page: HTMLElement | null = null;
let pickerRender: ((root: HTMLElement) => void) | null = null;

function loadPicked() {
  if (S.picked) return;
  try {
    const raw = stored(PICKED_KEY);
    const p = raw ? (JSON.parse(raw) as Target) : null;
    if (p && typeof p.hostId === "string" && typeof p.folder === "string") S.picked = { ...p, forChat: "\0" };
  } catch {
    /* nothing remembered */
  }
}

const chatKey = () => (state.chat ? `${state.chat.hostId}|${state.chat.cwd}` : "");

/** The chat's folder, unless a folder was picked by hand while this chat was open; else the remembered folder */
function target(): Target | null {
  loadPicked();
  const chat = state.chat;
  const valid = (x: Target | null) => (x && state.hosts.some((h) => h.id === x.hostId) ? x : null);
  if (chat?.cwd && S.picked?.forChat !== chatKey()) return valid({ hostId: chat.hostId, folder: chat.cwd });
  return valid(S.picked);
}

function hostName(hostId: string): string {
  return state.hosts.find((x) => x.id === hostId)?.name ?? hostId;
}

function rerender() {
  if (page?.isConnected && currentRoute() === "files") renderFiles(page);
}

/** The context the screens work with */
function ctxFor(tg: Target): FilesCtx {
  return {
    hostId: tg.hostId,
    hostName: hostName(tg.hostId),
    listing: () => S.listing,
    roots: () => (S.listing?.root ? [S.listing.root] : []),
    reload: () => load(tg),
    push: (s) => {
      S.stack.push(s);
      rerender();
      page?.scrollTo(0, 0);
    },
    back: () => {
      const top = S.stack[S.stack.length - 1];
      void (top?.canLeave?.() ?? Promise.resolve(true)).then((ok) => {
        if (!ok) return;
        S.stack.pop();
        rerender();
      });
    },
    refresh: rerender,
  };
}

async function load(tg: Target) {
  const key = `${tg.hostId}|${tg.folder}`;
  S.loading = true;
  S.error = "";
  rerender();
  try {
    const [l] = await api.listFiles(tg.hostId, [tg.folder], S.git, S.docsOnly);
    if (S.key !== key) return;
    S.listing = l ?? null;
    S.extra.clear();
    S.deepLoaded.clear();
  } catch (e) {
    if (S.key !== key) return;
    S.error = errMsg(e);
  }
  S.loading = false;
  S.loadedAt = Date.now();
  void loadTouches(tg);
  rerender();
}

/** Files Pi changed in the open chat's session (task B4's session_touches; skipped while it is missing) */
async function loadTouches(tg: Target) {
  const chat = state.chat;
  if (S.touchesMissing || !chat?.path || chat.hostId !== tg.hostId) {
    S.touched.clear();
    return;
  }
  try {
    const touches = await api.sessionTouches(chat.hostId, chat.path);
    S.touched = new Set(touches.flatMap((x) => x.paths));
    rerender();
  } catch (e) {
    if (errMsg(e).includes("Unknown command")) S.touchesMissing = true;
  }
}

/** Load a deep folder's content when it is opened (the list script stops at depth 4 and 3000 files) */
async function loadDeep(tg: Target, rel: string) {
  if (!S.listing?.root || S.deepLoaded.has(rel) || S.deepLoading.has(rel)) return;
  S.deepLoading.add(rel);
  rerender();
  try {
    const [l] = await api.listFiles(tg.hostId, [joinPath(S.listing.root, rel)], false, S.docsOnly);
    for (const f of l?.files ?? []) S.extra.add(`${rel}/${f}`);
    S.deepLoaded.add(rel);
  } catch (e) {
    toast(errMsg(e), "err");
  }
  S.deepLoading.delete(rel);
  rerender();
}

function truncated(l: FolderListing): boolean {
  return l.files.filter((f) => !f.endsWith("/")).length >= LIST_MAX;
}

/** Pi changed this file in the session; Pi's paths may be relative to the working folder or "~/…" */
function edited(full: string): boolean {
  if (!S.touched.size) return false;
  const work = S.listing?.root ?? "";
  for (const p of S.touched) {
    if (p === full) return true;
    if (p.startsWith("~/") && full.endsWith(p.slice(1))) return true;
    if (!p.startsWith("/") && work && full === `${work}/${p.replace(/^\.\//, "")}`) return true;
  }
  return false;
}

/** Open the tree down to `full` (just created or uploaded) */
function reveal(full: string, isDir: boolean) {
  const root = S.listing?.root;
  if (!root || !full.startsWith(`${root}/`)) return;
  const parts = full.slice(root.length + 1).split("/");
  const upto = isDir ? parts.length : parts.length - 1;
  for (let i = 1; i <= upto; i++) S.open.add(parts.slice(0, i).join("/"));
}

/** After a delete: forget open folders below the path */
function forget(full: string) {
  const root = S.listing?.root ?? "";
  const rel = full.slice(root.length + 1).replace(/\/+$/, "");
  for (const k of [...S.open]) if (k === rel || k.startsWith(`${rel}/`)) S.open.delete(k);
}

// ------------------------------------------------------------------ tree

function folderActions(ctx: FilesCtx, tg: Target, full: string, isRoot: boolean) {
  const after = (p: string, dir: boolean) => {
    reveal(p, dir);
    void load(tg).then(() => {
      if (!dir) openFile(ctx, tg, p);
    });
  };
  actionSheet(isRoot ? shortPath(full) : full.slice(full.lastIndexOf("/") + 1), [
    { label: t("New file"), onSelect: () => newFileDialog(tg.hostId, full, (p) => after(p, false)) },
    { label: t("New folder"), onSelect: () => newFolderDialog(tg.hostId, full, (p) => after(p, true)) },
    { label: t("Upload files …"), onSelect: () => startUpload(tg, full) },
    { label: t("Git history"), onSelect: () => ctx.push(repoHistoryScreen(ctx, full)) },
    ...(isRoot
      ? []
      : [
          {
            label: t("Delete folder …"),
            danger: true,
            onSelect: () =>
              deleteDialog(full, true, () => {
                api
                  .deletePath(tg.hostId, full, ctx.roots())
                  .then(() => {
                    forget(full);
                    toast(t("Deleted: {name}", { name: full.slice(full.lastIndexOf("/") + 1) }));
                    void load(tg);
                  })
                  .catch((e: unknown) => toast(`${t("Delete")}: ${errMsg(e)}`, "err"));
              }),
          },
        ]),
  ]);
}

function startUpload(tg: Target, folder: string) {
  pickAndUpload(
    tg.hostId,
    folder,
    (p) => {
      S.upload = p;
      rerender();
    },
    (paths) => {
      for (const p of paths) reveal(p, false);
      // the docs filter would hide e.g. PDFs: switch it off so the uploads are visible (as on the desktop)
      if (S.docsOnly && paths.some((p) => !isDoc(p))) {
        S.docsOnly = false;
        store(DOCS_KEY, "0");
        toast(t("Showing all files so the uploads are visible"));
      }
      void load(tg);
    },
  );
}

function openFile(ctx: FilesCtx, tg: Target, full: string) {
  ctx.push(
    fileScreen(ctx, full, (p) => {
      forget(p);
      void load(tg);
    }),
  );
}

function treeRows(ctx: FilesCtx, tg: Target, dir: TreeDir, depth: number, git: { repos: GitInfo[]; changes: ReturnType<typeof allChanges> }): HTMLElement[] {
  const root = S.listing?.root ?? "";
  const rows: HTMLElement[] = [];
  const pad = (extra = 0) => `padding-left:${8 + depth * 16 + extra}px`;
  const deep = S.listing ? truncated(S.listing) : false;
  for (const d of dir.dirs) {
    const open = S.open.has(d.path);
    const full = joinPath(root, d.path);
    const n = countFiles(d);
    const repo = git.repos.find((r) => r.dir === d.path);
    const mark = repo
      ? gitInline(repo)
      : git.changes.length && gitStatusFor(git.changes, `${d.path}/`)
        ? h("span", { class: "gdot", title: t("Contains changes") })
        : null;
    rows.push(
      h(
        "div",
        { class: "fx-tline" },
        h(
          "button",
          {
            type: "button",
            class: "fx-row fx-dir",
            style: pad(),
            "aria-expanded": open ? "true" : "false",
            onclick: () => {
              if (open) S.open.delete(d.path);
              else {
                S.open.add(d.path);
                if (deep || d.path.split("/").length >= DIR_DEPTH) void loadDeep(tg, d.path);
              }
              rerender();
            },
          },
          h("span", { class: `fx-chev ${open ? "open" : ""}` }, "›"),
          icon("folder", 16, "fx-ic"),
          h("span", { class: "fx-name" }, d.name),
          mark,
          n ? h("span", { class: "fx-count" }, String(n)) : null,
        ),
        h(
          "button",
          { type: "button", class: "icon-btn fx-more", "aria-label": `${t("More")}: ${d.name}`, onclick: () => folderActions(ctx, tg, full, false) },
          "⋯",
        ),
      ),
    );
    if (open) {
      if (S.deepLoading.has(d.path)) rows.push(h("div", { class: "fx-hint-row", style: pad(24) }, t("Loading …")));
      rows.push(...treeRows(ctx, tg, d, depth + 1, git));
    }
  }
  for (const f of dir.files) {
    const full = joinPath(root, f.path);
    rows.push(
      h(
        "button",
        { type: "button", class: "fx-row fx-filerow", style: pad(20), onclick: () => openFile(ctx, tg, full) },
        icon("file", 16, "fx-ic"),
        h("span", { class: "fx-name" }, f.name),
        edited(full) ? h("span", { class: "fx-edited", title: t("Changed by Pi in this session") }, "✎") : null,
        git.changes.length ? gitMark(gitStatusFor(git.changes, f.path)) : null,
      ),
    );
  }
  return rows;
}

function treeBody(ctx: FilesCtx, tg: Target): (HTMLElement | null)[] {
  const l = S.listing;
  if (S.error) return [h("p", { class: "error banner" }, S.error)];
  if (!l) return [h("div", { class: "loading" }, t("Loading files …"))];
  if (l.error) return [h("p", { class: "error banner" }, l.error)];
  if (l.missing) {
    return [
      empty(
        t("This folder does not exist on {host}.", { host: ctx.hostName }),
        h("p", {}, h("code", {}, l.folder)),
        button(t("Create folder"), () => {
          api
            .createDir(tg.hostId, l.folder)
            .then(() => load(tg))
            .catch((e: unknown) => toast(`${t("Create folder")}: ${errMsg(e)}`, "err"));
        }),
      ),
    ];
  }
  const repos = l.git ?? [];
  const git = { repos, changes: allChanges(repos) };
  // folders loaded on opening repeat what the first listing already had
  const tree = buildTree([...new Set([...l.files, ...S.extra])]);
  const own = repos.find((r) => r.dir === "");
  const line = own ? gitLine(own) : null;
  if (line) {
    line.classList.add("fx-gitline");
    line.setAttribute("role", "button");
    line.tabIndex = 0;
    line.addEventListener("click", () => ctx.push(repoHistoryScreen(ctx, l.root)));
  }
  const commit = hasChanges(ctx) ? button(t("Commit …"), () => ctx.push(commitDialogScreen(ctx)), "fx-small") : null;
  const rows = tree.dirs.length || tree.files.length ? treeRows(ctx, tg, tree, 0, git) : [];
  return [
    line || commit ? h("div", { class: "fx-gitbar" }, line, commit) : null,
    truncated(l) ? h("p", { class: "hint" }, t("Large folder: only the first 3000 files are listed; folders load more when opened.")) : null,
    rows.length
      ? h("div", { class: "fx-tree" }, ...rows)
      : h("div", { class: "fx-empty" }, S.docsOnly ? t("No Markdown or HTML files") : t("No files")),
  ];
}

function renderTree(root: HTMLElement, tg: Target) {
  const ctx = ctxFor(tg);
  const l = S.listing;
  const base = l?.root || tg.folder;
  const filter = h(
    "button",
    {
      type: "button",
      class: `icon-btn fx-toggle ${S.docsOnly ? "on" : ""}`,
      title: t("Show only Markdown, HTML and images"),
      "aria-label": t("Show only Markdown, HTML and images"),
      "aria-pressed": S.docsOnly ? "true" : "false",
      onclick: () => {
        S.docsOnly = !S.docsOnly;
        store(DOCS_KEY, S.docsOnly ? "1" : "0");
        void load(tg);
      },
    },
    icon("filter", 20),
  );
  const reload = h(
    "button",
    { type: "button", class: `icon-btn ${S.loading ? "spin" : ""}`, title: t("Reload"), "aria-label": t("Reload"), onclick: () => void load(tg) },
    "↻",
  );
  const plus = h(
    "button",
    {
      type: "button",
      class: "icon-btn",
      title: t("New file or folder"),
      "aria-label": t("New file or folder"),
      disabled: !l || l.missing || !!l.error,
      onclick: () => folderActions(ctx, tg, base, true),
    },
    "+",
  );
  const more = h(
    "button",
    {
      type: "button",
      class: "icon-btn",
      title: t("More"),
      "aria-label": t("More"),
      onclick: () =>
        actionSheet(t("Files"), [
          { label: t("Choose folder"), desc: t("Show another folder of the host"), onSelect: () => startPicking() },
          { label: t("Git history"), onSelect: () => ctx.push(repoHistoryScreen(ctx, base)) },
          ...(hasChanges(ctx) ? [{ label: t("Commit …"), onSelect: () => ctx.push(commitDialogScreen(ctx)) }] : []),
          {
            label: S.git ? t("Hide Git status") : t("Show Git status"),
            onSelect: () => {
              S.git = !S.git;
              store(GIT_KEY, S.git ? "1" : "0");
              void load(tg);
            },
          },
        ]),
    },
    "⋯",
  );
  const fromChat = !!state.chat?.cwd && S.picked?.forChat !== chatKey();
  root.replaceChildren(
    header(t("Files"), [filter, reload, plus, more]),
    h(
      "button",
      { type: "button", class: "fx-folder", title: t("Choose folder"), onclick: () => startPicking() },
      icon("folder", 16, "fx-ic"),
      // LRM marks keep "~/" in front while the path is cut at its start (direction: rtl)
      h("span", { class: "fx-folder-path" }, `\u200e${shortPath(base)}\u200e`),
      h("span", { class: "fx-folder-host" }, `${ctx.hostName}${fromChat ? ` · ${t("Chat")}` : ""}`),
    ),
    ...[
      S.upload ? h("p", { class: "fx-progress" }, `${t("Uploading …")} ${S.upload.done}/${S.upload.total}`) : null,
      ...treeBody(ctx, tg),
    ].filter((x): x is HTMLElement => x !== null),
  );
}

function startPicking() {
  S.picking = true;
  pickerRender = null;
  rerender();
}

function renderPicker(root: HTMLElement, tg: Target | null) {
  if (!pickerRender) {
    const hostId = tg?.hostId ?? state.chat?.hostId ?? state.hosts[0]?.id ?? "";
    const host = state.hosts.find((x) => x.id === hostId);
    pickerRender = folderPicker({
      hostId,
      start: S.listing?.root || tg?.folder || host?.defaultDir || "~",
      onPick: (hostId, folder) => {
        S.picked = { hostId, folder, forChat: chatKey() };
        store(PICKED_KEY, JSON.stringify({ hostId, folder }));
        S.picking = false;
        pickerRender = null;
        rerender();
      },
      onCancel: tg
        ? () => {
            S.picking = false;
            pickerRender = null;
            rerender();
          }
        : undefined,
    });
  }
  pickerRender(root);
}

export function renderFiles(root: HTMLElement) {
  page = root;
  if (!state.hosts.length) {
    root.replaceChildren(header(t("Files")), empty(t("No host has been assigned to you yet. Ask the admin.")));
    return;
  }
  const tg = target();
  if (S.picking || !tg) {
    renderPicker(root, tg);
    return;
  }
  const key = `${tg.hostId}|${tg.folder}`;
  if (S.key !== key) {
    // another folder: start fresh (open folders and screens belong to the old one)
    S.key = key;
    S.listing = null;
    S.open.clear();
    S.extra.clear();
    S.stack = [];
    S.touched.clear();
    void load(tg);
  } else if (!S.loading && Date.now() - S.loadedAt > 5000 && !S.stack.length) {
    // back in the tab after a while: Pi may have changed files
    void load(tg);
  }
  const top = S.stack[S.stack.length - 1];
  if (top) top.render(root);
  else renderTree(root, tg);
}

// a finished Pi run on this host may have changed files: refresh the tree if it is on screen
onSocketMessage((m) => {
  if (m.type !== "activity" || m.streaming !== false) return;
  const tg = S.key ? target() : null;
  if (!tg || m.hostId !== tg.hostId || `${tg.hostId}|${tg.folder}` !== S.key) return;
  if (currentRoute() === "files" && !S.stack.length && !S.picking) void load(tg);
  else S.loadedAt = 0;
});
