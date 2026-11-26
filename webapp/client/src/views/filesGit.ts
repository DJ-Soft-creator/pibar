// Git in the files tab (tasks G5, G6): history of the folder's repository or of one file (git_log), a commit with its
// files and the diff of each (git_commit, git_diff; behaviour of src/main/gitHistory.ts), and committing selected
// changes with a message (git_create_commit, a webapp command). Changes are shown against Git HEAD with
// src/shared/diff.ts before committing.
import { api, type GitCommit, type GitInfo } from "@shared/api";
import { errMsg, h, toast } from "@shared/dom";
import { baseName, relTime, shortPath } from "@shared/format";
import { gitMark } from "@shared/git";
import { icon } from "@shared/icons";
import { t } from "@shared/i18n";
import { invoke } from "../bridge";
import { button } from "../ui";
import { dirName, joinPath, lineDiff, screenHead, unifiedDiff, type FilesCtx, type Screen } from "./filesShared";

/** A screen that loads once and renders from its state */
function loadingScreen<T>(
  load: () => Promise<T>,
  view: (root: HTMLElement, data: T, rerender: () => void) => void,
  head: () => HTMLElement,
): Screen {
  let data: T | undefined;
  let error = "";
  let rootEl: HTMLElement | null = null;
  const rerender = () => {
    if (rootEl?.isConnected) render(rootEl);
  };
  const render = (root: HTMLElement) => {
    rootEl = root;
    if (data !== undefined) return view(root, data, rerender);
    root.replaceChildren(
      h("div", { class: "fx-screen" }, head(), error ? h("p", { class: "error banner" }, error) : h("div", { class: "loading" }, t("Loading …"))),
    );
  };
  void load()
    .then((d) => (data = d))
    .catch((e: unknown) => (error = errMsg(e)))
    .finally(rerender);
  return { render };
}

function commitRow(c: GitCommit, onPick: () => void): HTMLElement {
  return h(
    "button",
    { type: "button", class: "fx-commit", onclick: onPick },
    h(
      "div",
      { class: "fx-commit-subject" },
      c.unpushed ? h("span", { class: "fx-unpushed", title: t("Not pushed yet") }, "↑ ") : null,
      c.subject,
    ),
    h(
      "div",
      { class: "fx-commit-meta" },
      h("code", {}, c.short),
      ` · ${c.author} · ${relTime(c.time * 1000)}`,
      c.refs ? h("span", { class: "fx-refs" }, c.refs.replace(/^HEAD -> /, "")) : null,
    ),
  );
}

/** Commits of the repository `dir` belongs to */
export function repoHistoryScreen(ctx: FilesCtx, dir: string): Screen {
  const head = () => screenHead(ctx, t("Git history"), shortPath(dir));
  return loadingScreen(
    () => api.gitLog(ctx.hostId, dir),
    (root, commits) => {
      root.replaceChildren(
        h(
          "div",
          { class: "fx-screen" },
          head(),
          commits.length
            ? h("div", { class: "fx-list" }, ...commits.map((c) => commitRow(c, () => ctx.push(commitScreen(ctx, dir, c)))))
            : h("div", { class: "fx-empty" }, t("No commits yet")),
        ),
      );
    },
    head,
  );
}

/** Commits that changed one file (absolute path); a commit shows the file's diff */
export function fileHistoryScreen(ctx: FilesCtx, path: string): Screen {
  const dir = dirName(path) || "/";
  const file = baseName(path);
  const head = () => screenHead(ctx, `${t("History")} · ${file}`, shortPath(dir));
  return loadingScreen(
    () => api.gitLog(ctx.hostId, dir, file),
    (root, commits) => {
      root.replaceChildren(
        h(
          "div",
          { class: "fx-screen" },
          head(),
          commits.length
            ? h(
                "div",
                { class: "fx-list" },
                ...commits.map((c) => commitRow(c, () => ctx.push(fileDiffScreen(ctx, dir, c, file)))),
              )
            : h("div", { class: "fx-empty" }, t("No commits yet")),
        ),
      );
    },
    head,
  );
}

/** The diff of one file in one commit (file history) */
function fileDiffScreen(ctx: FilesCtx, dir: string, c: GitCommit, file: string): Screen {
  const head = () => screenHead(ctx, c.subject, `${c.short} · ${file}`);
  return loadingScreen(
    () => api.gitDiff(ctx.hostId, dir, c.hash, file, false),
    (root, diff) => root.replaceChildren(h("div", { class: "fx-screen" }, head(), unifiedDiff(diff))),
    head,
  );
}

/** Message and changed files of a commit; tapping a file shows its diff below it */
function commitScreen(ctx: FilesCtx, dir: string, c: GitCommit): Screen {
  const open = new Map<string, HTMLElement>();
  const head = () => screenHead(ctx, c.subject, `${c.short} · ${c.author}`);
  return loadingScreen(
    () => api.gitCommit(ctx.hostId, dir, c.hash),
    (root, d) => {
      const files = d.files.map((f) => {
        const box = open.get(f.path) ?? h("div", { class: "fx-file-diff", hidden: true });
        open.set(f.path, box);
        const row = h(
          "button",
          {
            type: "button",
            class: "fx-change",
            "aria-expanded": box.hidden ? "false" : "true",
            onclick: () => {
              box.hidden = !box.hidden;
              row.setAttribute("aria-expanded", box.hidden ? "false" : "true");
              if (!box.hidden && !box.childElementCount) {
                box.replaceChildren(h("div", { class: "loading" }, t("Loading …")));
                api
                  .gitDiff(ctx.hostId, dir, c.hash, f.path, true)
                  .then((diff) => box.replaceChildren(unifiedDiff(diff)))
                  .catch((e: unknown) => box.replaceChildren(h("p", { class: "error" }, errMsg(e))));
              }
            },
          },
          h("span", { class: `gmark ${f.status === "D" ? "del" : f.status === "A" ? "new" : "mod"}` }, f.status),
          h("span", { class: "fx-change-name" }, baseName(f.path)),
          h("span", { class: "fx-change-dir" }, dirName(f.path)),
        );
        return h("div", {}, row, box);
      });
      root.replaceChildren(
        h(
          "div",
          { class: "fx-screen" },
          head(),
          h("pre", { class: "fx-message" }, d.message),
          h("div", { class: "fx-list" }, ...files),
        ),
      );
    },
    head,
  );
}

// ------------------------------------------------------------------ commit

/** A repository of the listing with its folder (absolute) and the changes relative to that folder */
interface Repo {
  info: GitInfo;
  /** Absolute folder the paths are relative to (the listing root, or the nested repository) */
  dir: string;
  changes: { path: string; code: string }[];
}

function reposOf(ctx: FilesCtx): Repo[] {
  const l = ctx.listing();
  if (!l?.git?.length) return [];
  return l.git
    .filter((g) => g.changes.length)
    .map((g) => {
      const prefix = g.dir ? `${g.dir}/` : "";
      return {
        info: g,
        dir: joinPath(l.root, g.dir),
        changes: g.changes.map((c) => ({ code: c.code, path: c.path.startsWith(prefix) ? c.path.slice(prefix.length) : c.path })),
      };
    });
}

/** Whether the tree's folder has anything to commit */
export function hasChanges(ctx: FilesCtx): boolean {
  return reposOf(ctx).length > 0;
}

/** Changed files of the folder's repositories with checkboxes, a diff per file, message and commit */
export function commitDialogScreen(ctx: FilesCtx): Screen {
  let repoIdx = 0;
  const selected = new Map<string, Set<string>>();
  const message = h("textarea", { class: "fx-commit-msg", rows: 3, placeholder: t("What changed? (commit message)") });
  const diffs = new Map<string, HTMLElement>();
  let busy = false;
  let rootEl: HTMLElement | null = null;

  const render = (root: HTMLElement) => {
    rootEl = root;
    const repos = reposOf(ctx);
    const head = screenHead(ctx, t("Commit"), ctx.listing() ? shortPath(ctx.listing()?.root ?? "") : "");
    if (!repos.length) {
      root.replaceChildren(h("div", { class: "fx-screen" }, head, h("div", { class: "fx-empty" }, t("No changes"))));
      return;
    }
    if (repoIdx >= repos.length) repoIdx = 0;
    const repo = repos[repoIdx] as Repo;
    let sel = selected.get(repo.dir);
    if (!sel) {
      sel = new Set(repo.changes.map((c) => c.path));
      selected.set(repo.dir, sel);
    }
    const chosen = sel;
    const commitBtn = button(t("Commit"), () => void commit(repo, [...chosen]), "primary block");
    const update = () => {
      commitBtn.disabled = busy || !chosen.size || !message.value.trim();
      commitBtn.textContent = chosen.size ? t("Commit {n} files", { n: chosen.size }) : t("Commit");
    };
    message.oninput = update;

    const picker =
      repos.length > 1
        ? h(
            "select",
            {
              class: "fx-repo-pick",
              "aria-label": t("Repository"),
              onchange: (e: Event) => {
                repoIdx = Number((e.target as HTMLSelectElement).value);
                if (rootEl) render(rootEl);
              },
            },
            ...repos.map((r, i) =>
              h("option", { value: String(i), selected: i === repoIdx }, `${r.info.dir || baseName(r.dir)} · ${r.info.branch}`),
            ),
          )
        : h("p", { class: "muted small fx-branch" }, icon("branch", 12, "gicon"), ` ${repo.info.branch}`);

    const rows = repo.changes.map((c) => {
      const box = h("input", { type: "checkbox", checked: chosen.has(c.path), "aria-label": c.path });
      box.addEventListener("change", () => {
        if (box.checked) chosen.add(c.path);
        else chosen.delete(c.path);
        update();
      });
      const diffBox = diffs.get(`${repo.dir}|${c.path}`) ?? h("div", { class: "fx-file-diff", hidden: true });
      diffs.set(`${repo.dir}|${c.path}`, diffBox);
      const name = h(
        "button",
        {
          type: "button",
          class: "fx-change-btn",
          onclick: () => {
            diffBox.hidden = !diffBox.hidden;
            if (!diffBox.hidden && !diffBox.childElementCount) void loadWorkDiff(ctx, joinPath(repo.dir, c.path), c.code, diffBox);
          },
        },
        gitMark(c.code),
        h("span", { class: "fx-change-name" }, baseName(c.path)),
        h("span", { class: "fx-change-dir" }, dirName(c.path)),
      );
      return h("div", {}, h("div", { class: "fx-change" }, h("label", { class: "fx-check" }, box), name), diffBox);
    });

    const all = button(
      chosen.size === repo.changes.length ? t("Select none") : t("Select all"),
      () => {
        if (chosen.size === repo.changes.length) chosen.clear();
        else repo.changes.forEach((c) => chosen.add(c.path));
        if (rootEl) render(rootEl);
      },
      "fx-small",
    );
    update();
    root.replaceChildren(
      h(
        "div",
        { class: "fx-screen" },
        head,
        picker,
        h("div", { class: "fx-row-between" }, h("span", { class: "muted small" }, t("{n} changes", { n: repo.changes.length })), all),
        h("div", { class: "fx-list" }, ...rows),
        h("label", { class: "field" }, h("span", { class: "field-label" }, t("Commit message")), message),
        commitBtn,
        h("p", { class: "hint" }, t("Commits on the host with its Git identity. Nothing is pushed.")),
      ),
    );
  };

  async function commit(repo: Repo, paths: string[]) {
    if (busy || !paths.length || !message.value.trim()) return;
    busy = true;
    if (rootEl) render(rootEl);
    try {
      const c = await invoke<{ hash: string; short: string }>("git_create_commit", {
        hostId: ctx.hostId,
        dir: repo.dir,
        paths,
        message: message.value,
      });
      toast(t("Committed: {hash}", { hash: c.short }));
      message.value = "";
      selected.clear();
      diffs.clear();
      await ctx.reload();
      ctx.back();
    } catch (e) {
      toast(`${t("Commit")}: ${errMsg(e)}`, "err");
    } finally {
      busy = false;
      if (rootEl?.isConnected) render(rootEl);
    }
  }

  return { render };
}

/** Diff of a changed file in the working folder against Git HEAD */
async function loadWorkDiff(ctx: FilesCtx, path: string, code: string, box: HTMLElement) {
  if (path.endsWith("/")) {
    box.replaceChildren(h("p", { class: "muted small" }, t("New folder, not in Git yet")));
    return;
  }
  box.replaceChildren(h("div", { class: "loading" }, t("Loading …")));
  try {
    const head = await api.readFileHead(ctx.hostId, path);
    const now = code.includes("D") ? "" : await api.readFile(ctx.hostId, path);
    box.replaceChildren(lineDiff(head.text ?? "", now, head.text === null ? t("New file, not in Git yet") : ""));
  } catch (e) {
    box.replaceChildren(h("p", { class: "error small" }, errMsg(e)));
  }
}
