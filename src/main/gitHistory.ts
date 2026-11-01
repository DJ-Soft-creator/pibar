// Git history (read only): commits of a repository (click on the Git line in the file tree) or of one file (right
// click on a file → History). Left the commits, right the changed files of a commit and the diff of a file.
// Data from the Rust core (src-tauri/src/gitlog.rs).
import { api, type GitCommit } from "../shared/api";
import { errMsg, h, openModal } from "../shared/dom";
import { baseName, relTime } from "../shared/format";
import { t } from "../shared/i18n";

/** Unified diff with coloured lines */
function diffView(text: string): HTMLElement {
  if (!text.trim()) return h("div", { class: "gh-empty" }, t("No changes in this file"));
  const lines = text.split("\n").filter((l, i, a) => i < a.length - 1 || l);
  return h(
    "pre",
    { class: "gh-diff" },
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
      return h("div", { class: `gh-line ${cls}` }, l || " ");
    }),
  );
}

function commitRow(c: GitCommit, onPick: (row: HTMLElement) => void): HTMLElement {
  const row: HTMLElement = h(
    "button",
    { type: "button", class: "gh-commit", title: `${c.hash}\n${c.author}`, onclick: () => onPick(row) },
    h(
      "div",
      { class: "gh-subject" },
      c.unpushed ? h("span", { class: "gh-unpushed", title: t("Not pushed yet") }, "↑") : null,
      c.subject,
    ),
    h(
      "div",
      { class: "gh-meta" },
      h("code", {}, c.short),
      ` · ${c.author} · ${relTime(new Date(c.time * 1000).toISOString())}`,
      c.refs ? h("span", { class: "gh-refs" }, c.refs.replace(/^HEAD -> /, "")) : null,
    ),
  );
  return row;
}

/**
 * The dialog. `file` set: history of that file (path relative to `dir`, the file's folder), a click on a commit
 * shows its diff of the file. Otherwise: commits of the repository `dir` is in, a click shows the changed files.
 */
async function historyDialog(hostId: string, dir: string, title: string, file?: string) {
  const list = h("div", { class: "gh-list" }, h("div", { class: "gh-empty" }, t("Loading …")));
  const detail = h("div", { class: "gh-detail" }, h("div", { class: "gh-empty" }, t("Choose a commit on the left.")));
  const close = openModal(title, h("div", { class: "git-history" }, list, detail), [
    h("button", { class: "ghost", onclick: () => close() }, t("Close")),
  ]);
  let commits: GitCommit[];
  try {
    commits = await api.gitLog(hostId, dir, file);
  } catch (e) {
    list.replaceChildren(h("div", { class: "gh-empty err" }, errMsg(e)));
    return;
  }
  if (!commits.length) {
    list.replaceChildren(h("div", { class: "gh-empty" }, t("No commits yet")));
    return;
  }
  const pick = async (c: GitCommit, row: HTMLElement) => {
    list.querySelectorAll(".gh-commit.active").forEach((r) => r.classList.remove("active"));
    row.classList.add("active");
    detail.replaceChildren(h("div", { class: "gh-empty" }, t("Loading …")));
    try {
      if (file) {
        const diff = await api.gitDiff(hostId, dir, c.hash, file, false);
        detail.replaceChildren(h("div", { class: "gh-head" }, c.subject), diffView(diff));
        return;
      }
      const d = await api.gitCommit(hostId, dir, c.hash);
      const diffBox = h("div", {}, h("div", { class: "gh-empty" }, t("Choose a file to see its changes.")));
      const files = h(
        "div",
        { class: "gh-files" },
        ...d.files.map((f) => {
          const b: HTMLElement = h(
            "button",
            {
              type: "button",
              class: "gh-file",
              title: f.path,
              onclick: async () => {
                files.querySelectorAll(".gh-file.active").forEach((x) => x.classList.remove("active"));
                b.classList.add("active");
                diffBox.replaceChildren(h("div", { class: "gh-empty" }, t("Loading …")));
                try {
                  diffBox.replaceChildren(diffView(await api.gitDiff(hostId, dir, c.hash, f.path, true)));
                } catch (e) {
                  diffBox.replaceChildren(h("div", { class: "gh-empty err" }, errMsg(e)));
                }
              },
            },
            h("span", { class: `gmark ${f.status === "D" ? "del" : f.status === "A" ? "new" : "mod"}` }, f.status),
            h("span", { class: "gh-file-name" }, baseName(f.path)),
            h("span", { class: "gh-file-dir" }, f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : ""),
          );
          return b;
        }),
      );
      detail.replaceChildren(h("pre", { class: "gh-message" }, d.message), files, diffBox);
      (files.querySelector(".gh-file") as HTMLElement | null)?.click();
    } catch (e) {
      detail.replaceChildren(h("div", { class: "gh-empty err" }, errMsg(e)));
    }
  };
  list.replaceChildren(...commits.map((c) => commitRow(c, (row) => void pick(c, row))));
  (list.querySelector(".gh-commit") as HTMLElement | null)?.click();
}

/** Commits of the repository a folder belongs to */
export function repoHistory(hostId: string, dir: string) {
  return historyDialog(hostId, dir, `${t("Git history")} · ${baseName(dir)}`);
}

/** Commits that changed one file (absolute path) */
export function fileHistory(hostId: string, path: string) {
  const i = path.lastIndexOf("/");
  return historyDialog(hostId, path.slice(0, i) || "/", `${t("History")} · ${baseName(path)}`, path.slice(i + 1));
}
