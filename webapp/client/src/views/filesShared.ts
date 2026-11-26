// Shared pieces of the files tab (views/files*.ts): the context the screens get from the tree, file kinds, the
// action sheet, the two delete confirmations (as src/main/deleteDialog.ts), download, and the diff renderers
// (unified Git diffs like src/main/gitHistory.ts, line diffs of two texts with src/shared/diff.ts).
import type { FolderListing } from "@shared/api";
import { diffLines, diffStats, hunks, type DiffLine } from "@shared/diff";
import { errMsg, h, openModal, toast } from "@shared/dom";
import { baseName } from "@shared/format";
import { t } from "@shared/i18n";
import { invoke } from "../bridge";
import { button } from "../ui";

/** A full-page screen above the tree (file, history, commit); `render` may run again (tab switch) */
export interface Screen {
  render(root: HTMLElement): void;
  /** Asked before the screen is left with the back button; false keeps it */
  canLeave?(): Promise<boolean>;
}

/** What the screens need from the tree */
export interface FilesCtx {
  hostId: string;
  hostName: string;
  /** The listing shown in the tree (root = resolved folder) */
  listing(): FolderListing | null;
  /** Folders a delete may happen in (the tree's root) */
  roots(): string[];
  /** Reload the tree and Git status */
  reload(): Promise<void>;
  push(screen: Screen): void;
  back(): void;
  /** Render the current screen again */
  refresh(): void;
}

export const isImage = (p: string) => /\.(png|jpe?g|gif|webp)$/i.test(p);
export const isMarkdown = (p: string) => /\.(md|markdown)$/i.test(p);
export const isHtml = (p: string) => /\.html?$/i.test(p);
export const isPdf = (p: string) => /\.pdf$/i.test(p);
/** Shown by the "Markdown, HTML and images only" filter (files.rs: DOCS_FILTER) */
export const isDoc = (p: string) => /\.(md|markdown|html?|png|jpe?g|gif|webp)$/i.test(p);

/** Folder part of a path ("" for a name without "/") */
export function dirName(p: string): string {
  const i = p.replace(/\/+$/, "").lastIndexOf("/");
  return i > 0 ? p.slice(0, i) : i === 0 ? "/" : "";
}

export function joinPath(dir: string, rel: string): string {
  return rel ? `${dir.replace(/\/+$/, "")}/${rel}` : dir;
}

/** URL of the server's streaming download route (routes/files.ts); `inline` opens PDFs and pictures in the browser */
export function downloadUrl(hostId: string, path: string, inline = false): string {
  const q = new URLSearchParams({ hostId, path });
  if (inline) q.set("inline", "1");
  return `/api/files/download?${q.toString()}`;
}

/** Save a file to the phone: the server checks it (download_file answers the route's URL), then the browser loads it */
export async function downloadFile(hostId: string, path: string) {
  try {
    const url = await invoke<string>("download_file", { hostId, path });
    const a = h("a", { href: url, download: baseName(path), hidden: true });
    document.body.append(a);
    a.click();
    a.remove();
  } catch (e) {
    toast(`${t("Download")}: ${errMsg(e)}`, "err");
  }
}

export interface SheetItem {
  label: string;
  /** Small text under the label */
  desc?: string;
  danger?: boolean;
  onSelect: () => void;
}

/** Bottom sheet with a list of actions (mobile stand-in for the desktop's context menus) */
export function actionSheet(title: string, items: SheetItem[]) {
  const close = openModal(
    title,
    h(
      "div",
      { class: "fx-sheet" },
      ...items.map((it) =>
        h(
          "button",
          {
            type: "button",
            class: `fx-sheet-item ${it.danger ? "danger" : ""}`,
            // close first, then act in the same tap (a file input must be opened inside the user's gesture)
            onclick: () => {
              close();
              it.onSelect();
            },
          },
          h("span", {}, it.label),
          it.desc ? h("small", {}, it.desc) : null,
        ),
      ),
    ),
    [button(t("Cancel"), () => close())],
  );
}

/** Ask twice, then run `ok`; the second dialog's checkbox enables the final button (src/main/deleteDialog.ts) */
export function deleteDialog(path: string, dir: boolean, ok: () => void) {
  const first = openModal(
    dir ? t("Delete folder?") : t("Delete file?"),
    h(
      "div",
      {},
      h("p", {}, dir ? t("The folder and everything in it will be deleted.") : t("The file will be deleted.")),
      h("p", {}, h("code", {}, path)),
      h("p", { class: "hint" }, t("This cannot be undone.")),
    ),
    [
      button(t("Cancel"), () => first()),
      button(
        t("Delete …"),
        () => {
          first();
          second();
        },
        "danger",
      ),
    ],
  );

  const second = () => {
    const check = h("input", { type: "checkbox" });
    const btn = button(
      t("Delete permanently"),
      () => {
        close();
        ok();
      },
      "danger-solid",
    );
    btn.disabled = true;
    check.addEventListener("change", () => (btn.disabled = !check.checked));
    const close = openModal(
      t("Really delete?"),
      h(
        "div",
        {},
        h("p", {}, h("code", {}, path)),
        h("label", { class: "check" }, check, t("I know this cannot be undone.")),
      ),
      [button(t("Cancel"), () => close()), btn],
    );
  };
}

/** Unified diff of `git show` with coloured lines */
export function unifiedDiff(text: string): HTMLElement {
  if (!text.trim()) return h("div", { class: "fx-empty" }, t("No changes in this file"));
  const lines = text.split("\n").filter((l, i, a) => i < a.length - 1 || l);
  return h(
    "pre",
    { class: "fx-diff" },
    ...lines.map((l) => {
      const cls = l.startsWith("@@")
        ? "hunk"
        : l.startsWith("+++") || l.startsWith("---") || l.startsWith("diff ") || l.startsWith("index ")
          ? "meta"
          : l.startsWith("+")
            ? "add"
            : l.startsWith("-")
              ? "del"
              : "";
      return h("div", { class: `fx-dl ${cls}` }, l || " ");
    }),
  );
}

/** Line diff of two texts (old → new) with +/− counts and folded unchanged parts */
export function lineDiff(oldText: string, newText: string, note = ""): HTMLElement {
  const diff = diffLines(oldText, newText);
  const { added, removed } = diffStats(diff);
  const bar = h(
    "div",
    { class: "fx-diff-bar" },
    h("span", { class: "fx-stat add" }, `+${added}`),
    h("span", { class: "fx-stat del" }, `−${removed}`),
    note ? h("span", { class: "muted small" }, note) : null,
  );
  if (!added && !removed) return h("div", {}, bar, h("div", { class: "fx-empty" }, t("No changes")));
  const row = (d: DiffLine) =>
    h(
      "div",
      { class: `fx-dl ${d.op === "+" ? "add" : d.op === "-" ? "del" : ""}` },
      `${d.op} ${d.text}` || " ",
    );
  return h(
    "div",
    {},
    bar,
    h(
      "pre",
      { class: "fx-diff" },
      ...hunks(diff).map((x) =>
        "op" in x ? row(x) : h("div", { class: "fx-dl gap" }, t("{n} unchanged lines", { n: String(x.skipped) })),
      ),
    ),
  );
}

/** Page head of a screen: back button, title (one line) and optional subtitle, actions on the right */
export function screenHead(ctx: FilesCtx, title: string, sub: string, actions: HTMLElement[] = []): HTMLElement {
  return h(
    "header",
    { class: "fx-head" },
    h("button", { type: "button", class: "icon-btn fx-back", title: t("Back"), "aria-label": t("Back"), onclick: () => ctx.back() }, "‹"),
    h("div", { class: "fx-head-title" }, h("div", { class: "fx-head-name" }, title), sub ? h("div", { class: "fx-head-sub" }, sub) : null),
    h("div", { class: "fx-head-acts" }, ...actions),
  );
}
