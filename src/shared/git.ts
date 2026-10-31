// Git status in the file tree (optional, Settings → General): a quiet line under a session folder that is a
// repository, branch and ↑/↓ next to repository folders inside the tree, and a letter per changed file.
// Data comes from files.rs (git status --porcelain), one GitInfo per repository.
import type { GitInfo } from "./api";
import { h } from "./dom";
import { icon } from "./icons";
import { t } from "./i18n";

type Change = GitInfo["changes"][number];

/** All changes of all repositories of a listing */
export function allChanges(repos: GitInfo[]): Change[] {
  return repos.flatMap((r) => r.changes);
}

/** Porcelain code of a path; for folders ("dir/") the first change inside it */
export function gitStatusFor(changes: Change[], path: string): string {
  for (const c of changes) {
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

function syncParts(git: GitInfo): HTMLElement[] {
  const out: HTMLElement[] = [];
  if (git.ahead)
    out.push(h("span", { class: "gsync up", title: t("{n} commits not pushed", { n: git.ahead }) }, `↑${git.ahead}`));
  if (git.behind)
    out.push(h("span", { class: "gsync down", title: t("{n} commits to pull", { n: git.behind }) }, `↓${git.behind}`));
  return out;
}

function tip(git: GitInfo): string {
  const n = git.changes.length;
  return [
    git.upstream ? `${git.branch} → ${git.upstream}` : `${git.branch} (${t("local only")})`,
    n ? t("{n} changes", { n }) : t("clean"),
    git.upstream ? t("As of the last fetch") : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Compact "⎇ main ↑2" for a repository folder row in the tree */
export function gitInline(git: GitInfo): HTMLElement {
  return h(
    "span",
    { class: `ginline ${git.changes.length ? "dirty" : ""}`, title: tip(git) },
    icon("branch", 11, "gicon"),
    h("span", { class: "gbranch" }, git.branch),
    ...syncParts(git),
  );
}

/** "main · ↑2 ↓1 · 3 changes" under the folder name */
export function gitLine(git: GitInfo): HTMLElement {
  const n = git.changes.length;
  const parts: (HTMLElement | string)[] = [
    icon("branch", 12, "gicon"),
    h("span", { class: "gbranch" }, git.branch),
    ...syncParts(git),
  ];
  if (!git.upstream) parts.push(h("span", { class: "gmuted", title: t("No upstream branch") }, t("local only")));
  parts.push(h("span", { class: "gmuted" }, n ? t("{n} changes", { n }) : t("clean")));
  return h("div", { class: "git-line", title: tip(git) }, ...parts);
}
