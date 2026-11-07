//! File states for "go back": before every own message PiBar records the working tree of the session folder as a
//! Git commit and keeps it below `refs/pibar/<session id>/<n>` (n = own messages before that turn). Only objects and
//! those refs are written – the index, the history and the branch of the user stay untouched.
//!
//! Going back to a message restores the files Pi changed since then to that state; everything else stays as it is.
//! Only repositories are covered (a folder without Git gets no states). The UI side is src/main/rewindFiles.ts.

use crate::bg::hash as path_hash;
use crate::config::HostCfg;
use crate::files::check_path_shape;
use crate::hostexec::{self, shell_path, sq};
use crate::i18n::tr;
use serde::Serialize;
use std::time::{SystemTime, UNIX_EPOCH};

const NOGIT: &str = "__PIBAR_NOGIT__";
const NONE: &str = "__PIBAR_NONE__";
/// Identity of the snapshot commits: never taken from the Git config of the user
const IDENT: &str =
    "GIT_AUTHOR_NAME=PiBar GIT_AUTHOR_EMAIL=pibar@localhost GIT_COMMITTER_NAME=PiBar GIT_COMMITTER_EMAIL=pibar@localhost";
/// Snapshots and backups older than this go away with the next one (seconds)
const KEEP: i64 = 14 * 24 * 3600;

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Taken {
    /// Root of the repository the session folder is in
    pub repo: String,
    pub commit: String,
    /// Entry id of the own message this state belongs to (the state after its answer)
    pub tag: String,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Change {
    /// Relative to the repository root
    pub path: String,
    /// "M" changed, "D" deleted (comes back), "A" created (goes away)
    pub status: String,
}

#[derive(Serialize, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    /// Repository root, null if the session folder is not in a Git repository
    pub repo: Option<String>,
    /// Recorded state of that point, null if there is none
    pub commit: Option<String>,
    /// Files that actually change
    pub changes: Vec<Change>,
    /// Paths Pi changed that lie outside the repository
    pub skipped: Vec<String>,
}

#[derive(Serialize, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Restored {
    /// State before restoring, for undo; "" when undoing itself
    pub backup: String,
    pub restored: Vec<String>,
    pub deleted: Vec<String>,
    pub failed: Vec<String>,
}

/// Session ids and message entry ids end up in a ref name: only what a ref may contain
fn check_ref_part(id: &str) -> Result<(), String> {
    let ok = (4..=64).contains(&id.len())
        && !id.starts_with('-')
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if ok {
        Ok(())
    } else {
        Err(tr(format!("Not an id: {id}"), format!("Keine Kennung: {id}")))
    }
}

/// Commit ids only: hex, 4–40 characters (nothing else reaches the shell)
fn check_commit(commit: &str) -> Result<(), String> {
    let ok = (4..=40).contains(&commit.len()) && commit.chars().all(|c| c.is_ascii_hexdigit());
    if ok {
        Ok(())
    } else {
        Err(tr(format!("Not a commit: {commit}"), format!("Kein Commit: {commit}")))
    }
}

/// Refs to look for: the state belongs to the own message `tag` and may live under any session of the family (a Pi
/// fork keeps the history and therefore the same states), so all of them are tried in the order given
fn refs_for(session_ids: &[String], tag: &str) -> Result<Vec<String>, String> {
    if session_ids.is_empty() {
        return Err(tr("No session for this point", "Keine Session zu diesem Stand"));
    }
    check_ref_part(tag)?;
    Ok(session_ids.iter().map(|id| format!("refs/pibar/{id}/{tag}")).collect())
}

fn probe_script(dir: &str) -> String {
    format!(
        "cd {} || exit 1; cwd=$(pwd -P) || exit 1; \
         root=$(git rev-parse --show-toplevel 2>/dev/null) || {{ printf '{NOGIT}\\n'; exit 0; }}; \
         printf '%s\\t%s\\t%s\\n' \"$root\" \"$cwd\" \"$HOME\"",
        shell_path(dir)
    )
}

/// Answer of [`probe_script`] (root, resolved working folder, home: tab separated) → where the folder sits in a
/// repository; None if it is not inside one
pub fn parse_probe(out: &str, dir: &str) -> Option<Layout> {
    let line = out.lines().next().unwrap_or_default().trim();
    if line.is_empty() || line.starts_with(NOGIT) {
        return None;
    }
    let fields: Vec<&str> = line.split('\t').collect();
    let (Some(root), Some(cwd), Some(home)) = (fields.first(), fields.get(1), fields.get(2)) else {
        return None;
    };
    if !root.starts_with('/') || !cwd.starts_with('/') {
        return None;
    }
    let cwd_rel = cwd.strip_prefix(root).unwrap_or("").trim_start_matches('/');
    // the root as the caller wrote it: the same place, possibly through a symlink ("/tmp" on macOS)
    let given = absolute(dir, home.trim()).trim_end_matches('/').to_string();
    let alias = match (cwd_rel.is_empty(), given.strip_suffix(&format!("/{cwd_rel}"))) {
        (true, _) => given,
        (false, Some(alias)) => alias.to_string(),
        (false, None) => given,
    };
    Some(Layout { root: root.to_string(), alias, home: home.trim().to_string(), cwd: cwd.to_string() })
}

/// Where the working folder sits in a repository; None if it is not inside a Git repository
fn probe(host: &HostCfg, dir: &str) -> Result<Option<Layout>, String> {
    let out = hostexec::run_shell(host, &probe_script(dir), None)?;
    Ok(parse_probe(&out, dir))
}

/// Expand `~` and keep absolute paths; relative paths are left for the caller
fn absolute(path: &str, home: &str) -> String {
    if path == "~" {
        home.to_string()
    } else if let Some(rest) = path.strip_prefix("~/") {
        format!("{home}/{rest}")
    } else {
        path.to_string()
    }
}

/// Where the session folder sits in a repository: root and home folder of the host, the root as the caller wrote it
/// (a path through a symlink such as "/tmp" on macOS) and the working folder resolved
pub struct Layout {
    pub root: String,
    /// The same root as the session folder was named (may differ through symlinks), never with a trailing "/"
    pub alias: String,
    pub home: String,
    pub cwd: String,
}

impl Layout {
    /// Path as Pi reported it (absolute, `~/…` or relative to the working folder) → relative to the repository root;
    /// None if it lies outside the repository or in its `.git`
    pub fn repo_path(&self, path: &str) -> Option<String> {
        let p = path.trim();
        if p.is_empty() || p.chars().any(char::is_control) {
            return None;
        }
        let cwd = absolute(&self.cwd, &self.home);
        let cwd = cwd.trim_end_matches('/');
        let full =
            if p.starts_with('/') || p.starts_with('~') { absolute(p, &self.home) } else { format!("{cwd}/{p}") };
        let rest = [self.root.as_str(), self.alias.as_str()]
            .iter()
            .find_map(|base| full.strip_prefix(base).filter(|rest| rest.is_empty() || rest.starts_with('/')))?;
        let mut parts: Vec<&str> = Vec::new();
        for seg in rest.split('/') {
            match seg {
                "" | "." => continue,
                ".." => return None,
                s => parts.push(s),
            }
        }
        if parts.is_empty() || parts[0] == ".git" {
            return None;
        }
        Some(parts.join("/"))
    }
}

/// Index file of the snapshots: a copy kept by PiBar, so the index of the user is never touched (and unchanged files
/// are only looked at, not hashed again)
fn index_file(root: &str) -> String {
    format!("\"$HOME\"/.pibar/snap-index/{}", path_hash(root))
}

fn prune_snippet() -> String {
    format!(
        "now=$(date +%s); git for-each-ref --format='%(refname) %(committerdate:unix)' refs/pibar \
         | while read -r r t; do [ -n \"$t\" ] && [ $((now - t)) -gt {KEEP} ] && git update-ref -d \"$r\"; done"
    )
}

fn take_script(root: &str, index: &str, refname: &str) -> String {
    format!(
        "cd {} || exit 1; mkdir -p \"$(dirname {index})\"; \
         tree=$( ( export GIT_INDEX_FILE={index}; git add -A >/dev/null 2>&1 || exit 1; git write-tree ) ) || exit 1; \
         commit=$( {IDENT} git commit-tree \"$tree\" -m 'PiBar: files before a message' ) || exit 1; \
         git update-ref {refname} \"$commit\" || exit 1; printf '%s\\n' \"$commit\"; \
         {{ {prune}; }} >/dev/null 2>&1 || true",
        shell_path(root),
        index = index,
        refname = sq(refname),
        prune = prune_snippet()
    )
}

/// Record the current files of the session folder as the state after the answer to the own message `tag` (called
/// before the next message is sent). Ok(None) if the folder is not in a Git repository.
pub fn take(host: &HostCfg, dir: &str, session_id: &str, tag: &str) -> Result<Option<Taken>, String> {
    check_path_shape(dir)?;
    check_ref_part(session_id)?;
    let Some(layout) = probe(host, dir)? else { return Ok(None) };
    let refname = refs_for(&[session_id.to_string()], tag)?.remove(0);
    let out = hostexec::run_shell(host, &take_script(&layout.root, &index_file(&layout.root), &refname), None)?;
    let commit = out.trim().to_string();
    check_commit(&commit)?;
    Ok(Some(Taken { repo: layout.root, commit, tag: tag.to_string() }))
}

fn preview_script(root: &str, refs: &[String], rels: &[String]) -> String {
    let refs: Vec<String> = refs.iter().map(|r| sq(r)).collect();
    let rels: Vec<String> = rels.iter().map(|r| sq(r)).collect();
    format!(
        "cd {} || exit 1; commit=; for ref in {}; do commit=$(git rev-parse -q --verify \"$ref\" 2>/dev/null) && break; done; \
         [ -n \"$commit\" ] || {{ printf '{NONE}\\n'; exit 0; }}; printf 'COMMIT\\t%s\\n' \"$commit\"; \
         for rel in {}; do [ -n \"$rel\" ] || continue; \
           if git cat-file -e \"$commit:$rel\" 2>/dev/null; then \
             if [ ! -e \"$rel\" ] && [ ! -L \"$rel\" ]; then printf 'D\\t%s\\n' \"$rel\"; \
             elif git diff --quiet \"$commit\" -- \"$rel\" 2>/dev/null; then printf '=\\t%s\\n' \"$rel\"; \
             else printf 'M\\t%s\\n' \"$rel\"; fi; \
           elif [ -e \"$rel\" ] || [ -L \"$rel\" ]; then printf 'A\\t%s\\n' \"$rel\"; \
           else printf -- '-\\t%s\\n' \"$rel\"; fi; \
         done",
        shell_path(root),
        refs.join(" "),
        rels.join(" ")
    )
}

/// Output of [`preview_script`]: the state, then one line per path that actually changes
pub fn parse_preview(out: &str) -> (Option<String>, Vec<Change>) {
    let mut commit = None;
    let mut changes = Vec::new();
    for line in out.lines() {
        let Some((kind, path)) = line.split_once('\t') else { continue };
        match kind {
            "COMMIT" => commit = Some(path.trim().to_string()),
            "M" | "A" | "D" => changes.push(Change { path: path.to_string(), status: kind.to_string() }),
            _ => {}
        }
    }
    (commit, changes)
}

fn repo_paths(paths: &[String], layout: &Layout) -> (Vec<String>, Vec<String>) {
    let mut rels = Vec::new();
    let mut skipped = Vec::new();
    for path in paths {
        match layout.repo_path(path) {
            Some(rel) if !rels.contains(&rel) => rels.push(rel),
            _ => skipped.push(path.clone()),
        }
    }
    (rels, skipped)
}

/// Which of the given files (paths as Pi reported them) differ from the recorded state of that point
pub fn preview(
    host: &HostCfg,
    dir: &str,
    session_ids: &[String],
    tag: &str,
    paths: &[String],
) -> Result<Preview, String> {
    check_path_shape(dir)?;
    let Some(layout) = probe(host, dir)? else { return Ok(Preview::default()) };
    let (rels, skipped) = repo_paths(paths, &layout);
    let refs = refs_for(session_ids, tag)?;
    let out = hostexec::run_shell(host, &preview_script(&layout.root, &refs, &rels), None)?;
    let (commit, changes) = parse_preview(&out);
    Ok(Preview { repo: Some(layout.root), commit, changes, skipped })
}

fn restore_loop(rels: &[String]) -> String {
    let rels: Vec<String> = rels.iter().map(|r| sq(r)).collect();
    format!(
        "for rel in {}; do [ -n \"$rel\" ] || continue; \
         if git cat-file -e \"$commit:$rel\" 2>/dev/null; then \
           if git restore --source=\"$commit\" --worktree -- \"$rel\" 2>/dev/null \
              || {{ mkdir -p \"$(dirname \"$rel\")\"; git cat-file -p \"$commit:$rel\" > \"$rel\"; }}; then \
             printf 'R\\t%s\\n' \"$rel\"; else printf '!\\t%s\\n' \"$rel\"; fi; \
         elif rm -f -- \"$rel\" 2>/dev/null; then printf 'X\\t%s\\n' \"$rel\"; \
         else printf '!\\t%s\\n' \"$rel\"; fi; done",
        rels.join(" ")
    )
}

/// Output of the restore scripts: the state that was restored, the backup, then one line per path
pub fn parse_restore(out: &str) -> Option<Restored> {
    if out.lines().any(|l| l.trim() == NONE) {
        return None;
    }
    let mut result = Restored::default();
    for line in out.lines() {
        let Some((kind, path)) = line.split_once('\t') else { continue };
        match kind {
            "BACKUP" => result.backup = path.trim().to_string(),
            "R" => result.restored.push(path.to_string()),
            "X" => result.deleted.push(path.to_string()),
            "!" => result.failed.push(path.to_string()),
            _ => {}
        }
    }
    Some(result)
}

fn restore_script(root: &str, index: &str, undo_ref: &str, refs: &[String], rels: &[String]) -> String {
    let refs: Vec<String> = refs.iter().map(|r| sq(r)).collect();
    format!(
        "cd {} || exit 1; commit=; for ref in {}; do commit=$(git rev-parse -q --verify \"$ref\" 2>/dev/null) && break; done; \
         [ -n \"$commit\" ] || {{ printf '{NONE}\\n'; exit 0; }}; printf 'COMMIT\\t%s\\n' \"$commit\"; \
         mkdir -p \"$(dirname {index})\"; \
         tree=$( ( export GIT_INDEX_FILE={index}; git add -A >/dev/null 2>&1 || exit 1; git write-tree ) ) || exit 1; \
         backup=$( {IDENT} git commit-tree \"$tree\" -m 'PiBar: files before going back' ) || exit 1; \
         git update-ref {undo_ref} \"$backup\" || exit 1; printf 'BACKUP\\t%s\\n' \"$backup\"; {}",
        shell_path(root),
        refs.join(" "),
        restore_loop(rels),
        index = index,
        undo_ref = sq(undo_ref)
    )
}

/// Put the given files (paths as Pi reported them) back to the recorded state of that point. Everything else stays;
/// the state before restoring is recorded as well, so the UI can offer an undo.
/// Ok(None) if there is no recorded state for that point.
pub fn restore(
    host: &HostCfg,
    dir: &str,
    session_ids: &[String],
    tag: &str,
    paths: &[String],
) -> Result<Option<Restored>, String> {
    check_path_shape(dir)?;
    let Some(layout) = probe(host, dir)? else { return Ok(None) };
    let (rels, _) = repo_paths(paths, &layout);
    if rels.is_empty() {
        return Ok(Some(Restored::default()));
    }
    let refs = refs_for(session_ids, tag)?;
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let first = session_ids.first().cloned().unwrap_or_default();
    let undo_ref = format!("refs/pibar/undo/{first}-{stamp}");
    let script = restore_script(&layout.root, &index_file(&layout.root), &undo_ref, &refs, &rels);
    let out = hostexec::run_shell(host, &script, None)?;
    Ok(parse_restore(&out))
}

/// Undo a restore: put the same files back to the state recorded right before it (its `backup`)
pub fn restore_commit(host: &HostCfg, dir: &str, commit: &str, paths: &[String]) -> Result<Restored, String> {
    check_path_shape(dir)?;
    check_commit(commit)?;
    let Some(layout) = probe(host, dir)? else { return Ok(Restored::default()) };
    let (rels, _) = repo_paths(paths, &layout);
    if rels.is_empty() {
        return Ok(Restored::default());
    }
    let script = format!(
        "cd {} || exit 1; commit={}; printf 'COMMIT\\t%s\\n' \"$commit\"; {}",
        shell_path(&layout.root),
        sq(commit),
        restore_loop(&rels)
    );
    let out = hostexec::run_shell(host, &script, None)?;
    Ok(parse_restore(&out).unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_ref_safe() {
        assert!(check_ref_part("01a1b374-5abf-7693-9c4b-6182ed71d9e5").is_ok());
        assert!(check_ref_part("abc_1").is_ok());
        assert!(check_ref_part("").is_err());
        assert!(check_ref_part("-rf").is_err());
        assert!(check_ref_part("a/b").is_err());
        assert!(check_ref_part("a b").is_err());
        assert!(check_ref_part("a; rm -rf ~").is_err());
    }

    #[test]
    fn only_hex_commits() {
        assert!(check_commit("a1b2c3d").is_ok());
        assert!(check_commit("HEAD~1").is_err());
        assert!(check_commit("abc; ls").is_err());
    }

    fn layout(root: &str, cwd: &str, alias: &str) -> Layout {
        Layout { root: root.into(), alias: alias.into(), home: "/home/me".into(), cwd: cwd.into() }
    }

    #[test]
    fn maps_paths_into_the_repository() {
        let in_sub = layout("/work/app", "/work/app/packages/ui", "/work/app");
        assert_eq!(in_sub.repo_path("src/x.ts").as_deref(), Some("packages/ui/src/x.ts"));
        assert_eq!(in_sub.repo_path("./src/x.ts").as_deref(), Some("packages/ui/src/x.ts"));
        assert_eq!(in_sub.repo_path("/work/app/README.md").as_deref(), Some("README.md"));
        assert_eq!(in_sub.repo_path("~/notes/a.md"), None);
        assert_eq!(in_sub.repo_path("/etc/passwd"), None);
        assert_eq!(in_sub.repo_path("../../../etc/passwd"), None);
        assert_eq!(in_sub.repo_path("/work/app/.git/config"), None);
        assert_eq!(in_sub.repo_path("  "), None);
        // a folder just next to the repository is not inside it
        assert_eq!(in_sub.repo_path("/work/application/x.ts"), None);
        // the same folder written through a symlink ("/tmp" on macOS) still belongs to the repository
        let linked = layout("/private/tmp/app", "/private/tmp/app/packages/ui", "/tmp/app");
        assert_eq!(linked.repo_path("/tmp/app/packages/ui/src/x.ts").as_deref(), Some("packages/ui/src/x.ts"));
        assert_eq!(linked.repo_path("/tmp/app/README.md").as_deref(), Some("README.md"));
    }

    #[test]
    fn reads_the_probe_answer() {
        let out = "/private/tmp/app\t/private/tmp/app/packages/ui\t/home/me\n";
        let l = parse_probe(out, "/tmp/app/packages/ui").unwrap();
        assert_eq!(
            (l.root.as_str(), l.alias.as_str(), l.cwd.as_str()),
            ("/private/tmp/app", "/tmp/app", "/private/tmp/app/packages/ui")
        );
        let plain = parse_probe("/work/app\t/work/app\t/home/me\n", "~/app").unwrap();
        assert_eq!((plain.root.as_str(), plain.alias.as_str()), ("/work/app", "/home/me/app"));
        assert!(parse_probe(&format!("{NOGIT}\n"), "/work/x").is_none());
        assert!(parse_probe("", "/work/x").is_none());
        assert!(parse_probe("kein pfad\n", "/work/x").is_none());
    }

    #[test]
    fn reads_the_preview_output() {
        let out = "COMMIT\tabc123\nM\tsrc/a.ts\n=\tsrc/b.ts\nD\tsrc/c.ts\nA\tsrc/d.ts\n-\tsrc/e.ts\n";
        let (commit, changes) = parse_preview(out);
        assert_eq!(commit.as_deref(), Some("abc123"));
        let list: Vec<_> = changes.iter().map(|c| (c.status.as_str(), c.path.as_str())).collect();
        assert_eq!(list, vec![("M", "src/a.ts"), ("D", "src/c.ts"), ("A", "src/d.ts")]);
        assert_eq!(parse_preview(NONE).0, None);
    }

    #[test]
    fn reads_the_restore_output() {
        let out = "COMMIT\tabc123\nBACKUP\tdef456\nR\ta.ts\nX\tb.ts\n!\tc.ts\n";
        let r = parse_restore(out).unwrap();
        assert_eq!(r.backup, "def456");
        assert_eq!(r.restored, vec!["a.ts"]);
        assert_eq!(r.deleted, vec!["b.ts"]);
        assert_eq!(r.failed, vec!["c.ts"]);
        assert!(parse_restore(NONE).is_none());
    }

    /// The scripts against a real repository (needs git, like CI)
    #[test]
    fn records_and_restores_files() {
        let dir = std::env::temp_dir().join(format!("pibar-snap-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("src")).unwrap();
        let root = dir.to_string_lossy().to_string();
        let index = format!("{root}/.snap-index");
        let sh = |script: &str| {
            let out = std::process::Command::new("sh").arg("-c").arg(script).env("HOME", &root).output().unwrap();
            (String::from_utf8_lossy(&out.stdout).to_string(), out.status.success())
        };
        sh(&format!(
            "cd {root} && git init -q -b main && git config user.email t@t && git config user.name T && \
             echo one > src/a.ts && git add -A && git commit -qm start"
        ));
        // state after message 1: a.ts committed, b.ts untracked
        sh(&format!("cd {root} && echo two > src/b.ts"));
        let ref1 = "refs/pibar/sess-1/1";
        let (out, ok) = sh(&take_script(&root, &sq(&index), ref1));
        assert!(ok, "{out}");
        assert!(check_commit(out.trim()).is_ok());

        // what Pi does afterwards: a.ts changes, b.ts disappears, c.ts appears
        sh(&format!("cd {root} && echo changed > src/a.ts && rm src/b.ts && echo new > src/c.ts"));
        let rels = vec!["src/a.ts".to_string(), "src/b.ts".to_string(), "src/c.ts".to_string()];
        let (out, ok) = sh(&preview_script(&root, &[ref1.to_string()], &rels));
        assert!(ok, "{out}");
        let (commit, changes) = parse_preview(&out);
        assert_eq!(commit, Some(out.lines().next().unwrap().trim_start_matches("COMMIT\t").to_string()));
        let list: Vec<_> = changes.iter().map(|c| (c.status.as_str(), c.path.as_str())).collect();
        assert_eq!(list, vec![("M", "src/a.ts"), ("D", "src/b.ts"), ("A", "src/c.ts")]);

        let undo_ref = "refs/pibar/undo/sess-1-1";
        let (out, ok) = sh(&restore_script(&root, &sq(&index), undo_ref, &[ref1.to_string()], &rels));
        assert!(ok, "{out}");
        let r = parse_restore(&out).unwrap();
        assert_eq!((r.restored.len(), r.deleted.len(), r.failed.len()), (2, 1, 0));
        assert!(check_commit(&r.backup).is_ok());
        let read = |f: &str| std::fs::read_to_string(dir.join(f)).ok();
        assert_eq!(read("src/a.ts").as_deref(), Some("one\n"));
        assert_eq!(read("src/b.ts").as_deref(), Some("two\n"));
        assert_eq!(read("src/c.ts"), None);

        // undo: the same files back to the state right before restoring
        let paths: Vec<String> =
            vec![format!("{root}/src/a.ts"), format!("{root}/src/b.ts"), format!("{root}/src/c.ts")];
        let inside = layout(&root, &root, &root);
        let backup_paths: Vec<String> = paths.iter().map(|p| inside.repo_path(p).unwrap()).collect();
        let script = format!("cd {root} || exit 1; commit={}; {}", sq(&r.backup), restore_loop(&backup_paths));
        let (out, ok) = sh(&script);
        assert!(ok, "{out}");
        assert_eq!(read("src/a.ts").as_deref(), Some("changed\n"));
        assert_eq!(read("src/b.ts"), None);
        assert_eq!(read("src/c.ts").as_deref(), Some("new\n"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
