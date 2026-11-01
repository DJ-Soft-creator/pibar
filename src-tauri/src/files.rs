//! List, read and write Markdown files in a session's folders, optionally with the Git status.
//! Locally and over SSH with the same shell commands.

use crate::config::HostCfg;
use crate::hostexec::{self, shell_path, sq};
use serde::Serialize;

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FolderListing {
    /// Folder as given (e.g. "~/notes")
    pub folder: String,
    /// Resolved absolute path
    pub root: String,
    /// Markdown files relative to root; folders end with "/"
    pub files: Vec<String>,
    /// The folder does not exist on the host
    pub missing: bool,
    pub error: Option<String>,
    /// Git status when asked for: the repository containing the folder and repositories in subfolders
    pub git: Vec<GitInfo>,
}

/// Branch, sync state with the upstream and changed files (from `git status --porcelain --branch`).
/// Ahead/behind refer to the last fetch; PiBar does not fetch itself.
#[derive(Serialize, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitInfo {
    /// Repository folder relative to the listed folder; "" = the listed folder itself (or a parent of it)
    pub dir: String,
    pub branch: String,
    pub upstream: Option<String>,
    /// Commits not pushed yet
    pub ahead: u32,
    /// Commits on the upstream not pulled yet
    pub behind: u32,
    pub changes: Vec<GitChange>,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct GitChange {
    /// Relative to the listed folder; folders end with "/"
    pub path: String,
    /// Two-letter porcelain code, e.g. " M", "A ", "??"
    pub code: String,
}

/// First output line when the folder does not exist
const MISSING: &str = "__PIBAR_MISSING__";

/// Lists the current folder: its absolute path, then Markdown files, then folders (with a trailing "/", so empty
/// folders show in the tree too). Build output, dependencies and hidden folders are skipped.
const LIST: &str = r#"pwd
find . -maxdepth 5 \( -name node_modules -o -name .git -o -name target \) -prune -o -type f \( -name '*.md' -o -name '*.markdown' \) -print | sed 's|^\./||' | sort | head -n 1000
find . -mindepth 1 -maxdepth 4 \( -name node_modules -o -name target -o -name '.*' \) -prune -o -type d -print | sed 's|^\./||; s|$|/|' | sort | head -n 500"#;

/// Marks the start of the Git part of the output
const GIT_MARK: &str = "__PIBAR_GIT__";

/// Appended when the Git status is wanted. One block per repository: marker, folder (relative, "" = listed folder),
/// prefix of the listed folder inside that repository, then `git status`. First the repository the folder is in,
/// then repositories in subfolders (up to 30, depth 5).
const GIT: &str = r#"
if p=$(git rev-parse --show-prefix 2>/dev/null); then
  echo __PIBAR_GIT__; echo ""; echo "$p"
  git status --porcelain=v1 --branch --untracked-files=all 2>/dev/null | head -n 2000
fi
find . -mindepth 2 -maxdepth 5 \( -name node_modules -o -name target \) -prune -o -name .git -prune -print 2>/dev/null | head -n 30 | while IFS= read -r g; do
  d=$(dirname "$g"); d=${d#./}
  echo __PIBAR_GIT__; echo "$d"; echo ""
  git -C "$d" status --porcelain=v1 --branch --untracked-files=all 2>/dev/null | head -n 500
done"#;

/// "## main...origin/main [ahead 2, behind 1]" → branch, upstream, ahead, behind
pub fn parse_branch(line: &str) -> (String, Option<String>, u32, u32) {
    let rest = line.trim_start_matches("## ").trim();
    let (names, counts) = match rest.find(" [") {
        Some(i) => (&rest[..i], rest[i + 2..].trim_end_matches(']')),
        None => (rest, ""),
    };
    let names = names.trim_start_matches("No commits yet on ");
    let (branch, upstream) = match names.split_once("...") {
        Some((b, u)) => (b.to_string(), Some(u.to_string())),
        None => (names.to_string(), None),
    };
    let mut ahead = 0;
    let mut behind = 0;
    for part in counts.split(',') {
        let part = part.trim();
        if let Some(n) = part.strip_prefix("ahead ") {
            ahead = n.parse().unwrap_or(0);
        } else if let Some(n) = part.strip_prefix("behind ") {
            behind = n.parse().unwrap_or(0);
        }
    }
    (branch, upstream, ahead, behind)
}

/// One Git block: folder line, prefix line, branch line, then "XY path" lines (paths relative to the repository
/// root). Paths in the result are relative to the listed folder.
pub fn parse_git(lines: &[&str]) -> Option<GitInfo> {
    let dir = lines.first()?.trim();
    let prefix = lines.get(1)?.trim();
    let mut info = GitInfo { dir: dir.to_string(), ..Default::default() };
    for line in &lines[2..] {
        if line.starts_with("## ") {
            (info.branch, info.upstream, info.ahead, info.behind) = parse_branch(line);
        } else if line.len() > 3 {
            let code = line[..2].to_string();
            let mut path = &line[3..];
            // renames: "R  old -> new"
            if let Some((_, new)) = path.split_once(" -> ") {
                path = new;
            }
            let path = path.trim_matches('"');
            if let Some(rel) = path.strip_prefix(prefix) {
                let path = if dir.is_empty() { rel.to_string() } else { format!("{dir}/{rel}") };
                info.changes.push(GitChange { path, code });
            }
        }
    }
    Some(info)
}

/// Turn the output of the list script into a listing
fn parse_listing(folder: &str, out: &str) -> FolderListing {
    let all: Vec<&str> = out.lines().collect();
    let mut blocks = all.split(|l| *l == GIT_MARK);
    let main = blocks.next().unwrap_or_default();
    let git: Vec<GitInfo> = blocks.filter_map(parse_git).collect();
    let first = main.first().map(|s| s.trim().to_string()).unwrap_or_default();
    if first == MISSING {
        return FolderListing {
            folder: folder.into(),
            root: String::new(),
            files: vec![],
            missing: true,
            error: None,
            git: vec![],
        };
    }
    let files = main.iter().skip(1).map(|l| l.to_string()).filter(|l| !l.is_empty()).collect();
    FolderListing { folder: folder.into(), root: first, files, missing: false, error: None, git }
}

pub fn list(host: &HostCfg, folders: &[String], with_git: bool) -> Vec<FolderListing> {
    let git = if with_git { GIT } else { "" };
    folders
        .iter()
        .map(|folder| {
            let script =
                format!("if ! cd {} 2>/dev/null; then echo {MISSING}; exit 0; fi; {LIST}{git}", shell_path(folder));
            match hostexec::run_shell(host, &script, None) {
                Ok(out) => parse_listing(folder, &out),
                Err(e) => FolderListing {
                    folder: folder.clone(),
                    root: String::new(),
                    files: vec![],
                    missing: false,
                    error: Some(e),
                    git: vec![],
                },
            }
        })
        .collect()
}

pub fn read(host: &HostCfg, path: &str) -> Result<String, String> {
    hostexec::run_shell(host, &format!("cat {}", sq(path)), None)
}

/// Version of a file in Git (HEAD), for the diff view
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HeadVersion {
    /// The file lies in a Git repository
    pub in_git: bool,
    /// Content in HEAD; None if the file is new (not yet committed)
    pub text: Option<String>,
}

const HEAD_MARK: &str = "__PIBAR_HEAD__";
const NOGIT_MARK: &str = "__PIBAR_NOGIT__";
const NEW_MARK: &str = "__PIBAR_NEW__";

/// First line: marker; with HEAD_MARK the rest is the file content in HEAD
pub fn parse_head(out: &str) -> HeadVersion {
    let (first, rest) = out.split_once('\n').unwrap_or((out, ""));
    match first.trim() {
        HEAD_MARK => HeadVersion { in_git: true, text: Some(rest.to_string()) },
        NEW_MARK => HeadVersion { in_git: true, text: None },
        _ => HeadVersion { in_git: false, text: None },
    }
}

pub fn read_head(host: &HostCfg, path: &str) -> Result<HeadVersion, String> {
    let (dir, name) = path.rsplit_once('/').unwrap_or((".", path));
    let dir = if dir.is_empty() { "/" } else { dir };
    let script = format!(
        "cd {} 2>/dev/null && git rev-parse --is-inside-work-tree >/dev/null 2>&1 || {{ echo {NOGIT_MARK}; exit 0; }}; \
         if git cat-file -e HEAD:./{n} 2>/dev/null; then echo {HEAD_MARK}; git show HEAD:./{n}; else echo {NEW_MARK}; fi",
        shell_path(dir),
        n = sq(name)
    );
    hostexec::run_shell(host, &script, None).map(|out| parse_head(&out))
}

pub fn write(host: &HostCfg, path: &str, content: &str) -> Result<(), String> {
    let p = sq(path);
    // write to a temp file, then rename: no half-written files on failure
    let script = format!("cat > {p}.pibar-tmp && mv {p}.pibar-tmp {p}");
    hostexec::run_shell(host, &script, Some(content.as_bytes())).map(|_| ())
}

pub fn create(host: &HostCfg, path: &str) -> Result<(), String> {
    let p = sq(path);
    let script = format!("mkdir -p \"$(dirname {p})\" && [ ! -e {p} ] && : > {p}");
    hostexec::run_shell(host, &script, None).map(|_| ())
}

/// Subfolders of a folder on the host, for the folder picker
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DirListing {
    /// Resolved absolute path
    pub path: String,
    /// Home folder of the host (to show and store paths as "~/…")
    pub home: String,
    /// Names of the subfolders, sorted
    pub dirs: Vec<String>,
}

/// Output: absolute path, home folder, then one subfolder name per line
pub fn parse_dirs(out: &str) -> Option<DirListing> {
    let mut lines = out.lines();
    let path = lines.next()?.trim().to_string();
    let home = lines.next()?.trim().to_string();
    let mut dirs: Vec<String> = lines.map(str::to_string).filter(|l| !l.is_empty()).collect();
    dirs.sort_by_key(|d| d.to_lowercase());
    Some(DirListing { path, home, dirs })
}

pub fn list_dirs(host: &HostCfg, folder: &str, hidden: bool) -> Result<DirListing, String> {
    let filter = if hidden { "" } else { "! -name '.*'" };
    let script = format!(
        "cd {} && pwd && echo \"$HOME\" && find . -mindepth 1 -maxdepth 1 -type d {filter} 2>/dev/null | sed 's|^\\./||' | head -n 2000",
        shell_path(folder)
    );
    let out = hostexec::run_shell(host, &script, None)?;
    parse_dirs(&out).ok_or_else(|| "empty answer".into())
}

/// Create a folder (with parents), e.g. a session folder that does not exist yet
pub fn create_dir(host: &HostCfg, path: &str) -> Result<(), String> {
    hostexec::run_shell(host, &format!("mkdir -p {}", shell_path(path)), None).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_listing() {
        let l = parse_listing("~/notes", "/home/u/notes\na.md\nsub/b.md\nempty/\nsub/\n");
        assert_eq!(l.root, "/home/u/notes");
        assert_eq!(l.files, vec!["a.md", "sub/b.md", "empty/", "sub/"]);
        assert!(!l.missing);
    }

    #[test]
    fn parses_git_status() {
        let out = "/repo/docs\na.md\n__PIBAR_GIT__\n\ndocs/\n## main...origin/main [ahead 2, behind 1]\n M docs/a.md\n?? docs/new/\n M src/x.rs\nR  docs/old.md -> docs/b.md\n";
        let l = parse_listing("~/repo/docs", out);
        assert_eq!(l.files, vec!["a.md"]);
        let g = &l.git[0];
        assert_eq!(g.dir, "");
        assert_eq!((g.branch.as_str(), g.upstream.as_deref(), g.ahead, g.behind), ("main", Some("origin/main"), 2, 1));
        let paths: Vec<_> = g.changes.iter().map(|c| (c.code.as_str(), c.path.as_str())).collect();
        assert_eq!(paths, vec![(" M", "a.md"), ("??", "new/"), ("R ", "b.md")]);
    }

    #[test]
    fn parses_branch_lines() {
        assert_eq!(parse_branch("## main"), ("main".into(), None, 0, 0));
        assert_eq!(parse_branch("## No commits yet on main"), ("main".into(), None, 0, 0));
        assert_eq!(parse_branch("## dev...origin/dev [behind 3]"), ("dev".into(), Some("origin/dev".into()), 0, 3));
    }

    #[test]
    fn no_git_part_means_none() {
        assert!(parse_listing("~/x", "/x\na.md\n").git.is_empty());
    }

    #[test]
    fn finds_repositories_in_subfolders() {
        let out = "/home/u\nnotes/a.md\n__PIBAR_GIT__\nprojects/app\n\n## dev...origin/dev [ahead 1]\n M README.md\n__PIBAR_GIT__\nnotes\n\n## main\n";
        let l = parse_listing("~", out);
        assert_eq!(l.files, vec!["notes/a.md"]);
        assert_eq!(l.git.len(), 2);
        assert_eq!((l.git[0].dir.as_str(), l.git[0].ahead), ("projects/app", 1));
        assert_eq!(l.git[0].changes[0].path, "projects/app/README.md");
        assert_eq!(l.git[1].branch, "main");
    }

    #[test]
    fn parses_head_version() {
        let v = parse_head("__PIBAR_HEAD__\n# Title\n\ntext\n");
        assert_eq!(v, HeadVersion { in_git: true, text: Some("# Title\n\ntext\n".into()) });
        assert_eq!(parse_head("__PIBAR_NEW__\n"), HeadVersion { in_git: true, text: None });
        assert_eq!(parse_head("__PIBAR_NOGIT__\n"), HeadVersion { in_git: false, text: None });
    }

    #[test]
    fn parses_dir_listing() {
        let d = parse_dirs("/home/u/proj\n/home/u\nsrc\nDocs\nassets\n").unwrap();
        assert_eq!(d.path, "/home/u/proj");
        assert_eq!(d.home, "/home/u");
        assert_eq!(d.dirs, vec!["assets", "Docs", "src"]);
        assert!(parse_dirs("").is_none());
    }

    #[test]
    fn detects_missing_folder() {
        let l = parse_listing("~/gone", "__PIBAR_MISSING__\n");
        assert!(l.missing);
        assert!(l.files.is_empty());
        assert_eq!(l.root, "");
    }
}
