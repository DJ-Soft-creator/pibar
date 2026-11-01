//! Git history for the file panel: commits of a repository or of one file, the files of a commit and the diff of a
//! file in a commit. Read only, locally or over SSH with the same commands (src/main/gitHistory.ts shows it).

use crate::config::HostCfg;
use crate::files::check_path_shape;
use crate::hostexec::{self, shell_path, sq};
use crate::i18n::tr;
use serde::Serialize;

const NOGIT: &str = "__PIBAR_NOGIT__";
const UNPUSHED: &str = "__PIBAR_UNPUSHED__";
const LOG: &str = "__PIBAR_LOG__";
/// Field and record separators in `git log --pretty` (cannot appear in subjects)
const FS: char = '\u{1f}';
const RS: char = '\u{1e}';
/// Largest diff handed to the UI
const MAX_DIFF: usize = 400_000;

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    pub hash: String,
    pub short: String,
    pub author: String,
    /// Seconds since the epoch
    pub time: i64,
    /// Branches and tags pointing here ("HEAD -> main, origin/main")
    pub refs: String,
    pub subject: String,
    /// Not pushed to the upstream branch yet
    pub unpushed: bool,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetail {
    pub message: String,
    /// Changed files: status letter (A, M, D, R…) and path relative to the repository root
    pub files: Vec<ChangedFile>,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct ChangedFile {
    pub status: String,
    pub path: String,
}

/// Commit ids only: hex, 4–40 characters (nothing else reaches the shell)
fn check_hash(hash: &str) -> Result<(), String> {
    if (4..=40).contains(&hash.len()) && hash.chars().all(|c| c.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(format!("invalid commit: {hash}"))
    }
}

fn not_a_repo() -> String {
    tr("Not in a Git repository", "Nicht in einem Git-Repository")
}

/// Output of the log script: unpushed hashes, then the log records
pub fn parse_log(out: &str) -> Result<Vec<Commit>, String> {
    if out.trim_start().starts_with(NOGIT) {
        return Err(not_a_repo());
    }
    let (head, log) = out.split_once(LOG).unwrap_or(("", out));
    let unpushed: Vec<&str> = head
        .split_once(UNPUSHED)
        .map(|(_, l)| l.lines().map(str::trim).filter(|l| !l.is_empty()).collect())
        .unwrap_or_default();
    Ok(log
        .split(RS)
        .filter_map(|rec| {
            let f: Vec<&str> = rec.trim_start_matches('\n').split(FS).collect();
            if f.len() < 6 || f[0].is_empty() {
                return None;
            }
            Some(Commit {
                hash: f[0].to_string(),
                short: f[1].to_string(),
                author: f[2].to_string(),
                time: f[3].parse().unwrap_or(0),
                refs: f[4].to_string(),
                subject: f[5].trim_end().to_string(),
                unpushed: unpushed.contains(&f[0]),
            })
        })
        .collect())
}

fn log_script(dir: &str, file: Option<&str>, limit: u32) -> String {
    let follow = match file {
        Some(f) => format!(" --follow -- {}", sq(f)),
        None => String::new(),
    };
    format!(
        "cd {} || exit 1; git rev-parse --is-inside-work-tree >/dev/null 2>&1 || {{ echo {NOGIT}; exit 0; }}; \
         echo {UNPUSHED}; git rev-list '@{{u}}..HEAD' 2>/dev/null | head -n 1000; echo {LOG}; \
         git log --no-color --max-count={} --pretty=format:'%H%x1f%h%x1f%an%x1f%at%x1f%D%x1f%s%x1e'{follow}",
        shell_path(dir),
        limit.clamp(1, 1000)
    )
}

/// Commits of the repository `dir` is in, newest first; with `file`: only commits of that file (following renames)
pub fn log(host: &HostCfg, dir: &str, file: Option<&str>, limit: u32) -> Result<Vec<Commit>, String> {
    check_path_shape(dir)?;
    parse_log(&hostexec::run_shell(host, &log_script(dir, file, limit), None)?)
}

/// Output of `git show --format=… --name-status`: message record, then "status<TAB>path[<TAB>new path]" lines
pub fn parse_detail(out: &str) -> CommitDetail {
    let (msg, rest) = out.split_once(RS).unwrap_or((out, ""));
    let files = rest
        .lines()
        .filter_map(|l| {
            let status = l.split('\t').next()?.trim();
            let path = l.rsplit('\t').next()?;
            (!status.is_empty() && !path.is_empty() && status != path)
                .then(|| ChangedFile { status: status.chars().take(1).collect(), path: path.to_string() })
        })
        .collect();
    CommitDetail { message: msg.trim().to_string(), files }
}

fn commit_script(dir: &str, hash: &str) -> String {
    format!(
        "cd {} || exit 1; git -c core.quotePath=false show --no-color --format='%B%x1e' --name-status {hash}",
        shell_path(dir)
    )
}

/// Message and changed files of a commit
pub fn commit(host: &HostCfg, dir: &str, hash: &str) -> Result<CommitDetail, String> {
    check_path_shape(dir)?;
    check_hash(hash)?;
    hostexec::run_shell(host, &commit_script(dir, hash), None).map(|out| parse_detail(&out))
}

fn diff_script(dir: &str, hash: &str, path: &str, top: bool) -> String {
    let spec = if top { sq(&format!(":(top){path}")) } else { sq(path) };
    format!("cd {} || exit 1; git show --no-color --format= {hash} -- {spec} | head -c {MAX_DIFF}", shell_path(dir))
}

/// Diff of one file in a commit. `top`: path relative to the repository root (from [`commit`]), otherwise relative
/// to `dir` (file history)
pub fn diff(host: &HostCfg, dir: &str, hash: &str, path: &str, top: bool) -> Result<String, String> {
    check_path_shape(dir)?;
    check_hash(hash)?;
    hostexec::run_shell(host, &diff_script(dir, hash, path, top), None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_log_with_unpushed_commits() {
        let out = format!(
            "{UNPUSHED}\naaa111\n{LOG}\naaa111{FS}aaa1{FS}Egon{FS}1730000000{FS}HEAD -> main{FS}Neue Funktion{RS}\nbbb222{FS}bbb2{FS}Egon{FS}1720000000{FS}{FS}Fix: Umlaute{RS}"
        );
        let log = parse_log(&out).unwrap();
        assert_eq!(log.len(), 2);
        assert_eq!((log[0].short.as_str(), log[0].unpushed, log[0].refs.as_str()), ("aaa1", true, "HEAD -> main"));
        assert_eq!((log[1].subject.as_str(), log[1].unpushed, log[1].time), ("Fix: Umlaute", false, 1720000000));
        assert!(parse_log(NOGIT).is_err());
    }

    #[test]
    fn parses_commit_detail() {
        let out = format!("Titel\n\nText\n{RS}\n\nM\tREADME.md\nA\tdocs/Über.md\nR100\talt.md\tneu.md\n");
        let d = parse_detail(&out);
        assert_eq!(d.message, "Titel\n\nText");
        let files: Vec<_> = d.files.iter().map(|f| (f.status.as_str(), f.path.as_str())).collect();
        assert_eq!(files, vec![("M", "README.md"), ("A", "docs/Über.md"), ("R", "neu.md")]);
    }

    #[test]
    fn only_hex_commit_ids() {
        assert!(check_hash("a1b2c3d").is_ok());
        assert!(check_hash("HEAD; rm -rf ~").is_err());
        assert!(check_hash("abc").is_err());
    }

    /// The scripts against a real repository (needs git, like CI)
    #[test]
    fn scripts_work_on_a_repository() {
        let dir = std::env::temp_dir().join(format!("pibar-gitlog-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("docs")).unwrap();
        let sh = |script: &str| {
            let out = std::process::Command::new("sh").arg("-c").arg(script).current_dir(&dir).output().unwrap();
            String::from_utf8_lossy(&out.stdout).to_string()
        };
        sh("git init -q -b main && git config user.email t@t && git config user.name Tester && \
            echo a > docs/Über.md && git add -A && git commit -qm erste && \
            echo b >> docs/Über.md && echo c > x.txt && git add -A && git commit -qm zweite");
        let root = dir.to_string_lossy().to_string();
        let docs = format!("{root}/docs");
        let log = parse_log(&sh(&log_script(&root, None, 50))).unwrap();
        assert_eq!(log.iter().map(|c| c.subject.as_str()).collect::<Vec<_>>(), vec!["zweite", "erste"]);
        let file_log = parse_log(&sh(&log_script(&docs, Some("Über.md"), 50))).unwrap();
        assert_eq!(file_log.len(), 2);
        let d = parse_detail(&sh(&commit_script(&docs, &log[0].hash)));
        let files: Vec<_> = d.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!((d.message.as_str(), files), ("zweite", vec!["docs/Über.md", "x.txt"]));
        assert!(sh(&diff_script(&docs, &log[0].hash, "docs/Über.md", true)).contains("+b"));
        assert!(sh(&diff_script(&docs, &log[0].hash, "Über.md", false)).contains("+b"));
        assert!(parse_log(&sh(&log_script("/", None, 5))).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
