// Git status in the file tree (optional, Settings → General): one quiet line per folder with branch and
// unpushed/unpulled commits, and a letter per changed file. Data comes from files.rs (git status --porcelain).
import type { GitInfo } from "./api";
import { h } from "./dom";
import { icon } from "./icons";
import { t } from "./i18n";

/** Porcelain code of a path; for folders ("dir/") the first change inside it */
export function gitStatusFor(git: GitInfo, path: string): string {
  for (const c of git.changes) {
    if (c.path === path) return c.code;
    if (path.endsWith("/") && c.path.startsWith(path)) return c.code;
    if (c.path.endsWith("/") && path.startsWith(c.path)) return c.code; // file inside an untracked folder
  }
  return "";
}

/** Short letter and kind for a porcelain code */
export function gitLetter(code: string): { letter: string; kind: string; title: string } | null {
  if (!code) return null;
  if (code === "??") return { letter: "U", kind: "new", title: t("Untracked") };
  const c = code.trim()[0] ?? "";
  switch (c) {
    case "M":
      return { letter: "M", kind: "mod", title: t("Modified") };
    case "A":
      return { letter: "A", kind: "new", title: t("Added") };
    case "R":
      return { letter: "R", kind: "mod", title: t("Renamed") };
    case "D":
      return { letter: "D", kind: "del", title: t("Deleted") };
    case "U":
      return { letter: "!", kind: "del", title: t("Conflict") };
    default:
      return { letter: c, kind: "mod", title: code };
  }
}

export function gitMark(code: string): HTMLElement | null {
  const g = gitLetter(code);
  return g ? h("span", { class: `gmark ${g.kind}`, title: g.title }, g.letter) : null;
}

/** "main · ↑2 ↓1 · 3 changes" under the folder name */
export function gitLine(git: GitInfo): HTMLElement {
  const n = git.changes.length;
  const parts: (HTMLElement | string)[] = [icon("branch", 12, "gicon"), h("span", { class: "gbranch" }, git.branch)];
  if (git.ahead)
    parts.push(h("span", { class: "gsync up", title: t("{n} commits not pushed", { n: git.ahead }) }, `↑${git.ahead}`));
  if (git.behind)
    parts.push(
      h("span", { class: "gsync down", title: t("{n} commits to pull", { n: git.behind }) }, `↓${git.behind}`),
    );
  if (!git.upstream) parts.push(h("span", { class: "gmuted", title: t("No upstream branch") }, t("local only")));
  parts.push(h("span", { class: "gmuted" }, n ? t("{n} changes", { n }) : t("clean")));
  return h(
    "div",
    {
      class: "git-line",
      title: git.upstream ? `${git.branch} → ${git.upstream}\n${t("As of the last fetch")}` : git.branch,
    },
    ...parts,
  );
}
