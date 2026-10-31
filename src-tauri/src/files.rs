//! List, read and write Markdown files in a session's folders.
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
}

/// First output line when the folder does not exist
const MISSING: &str = "__PIBAR_MISSING__";

/// Lists the current folder: its absolute path, then Markdown files, then folders (with a trailing "/", so empty
/// folders show in the tree too). Build output, dependencies and hidden folders are skipped.
const LIST: &str = r#"pwd
find . -maxdepth 5 \( -name node_modules -o -name .git -o -name target \) -prune -o -type f \( -name '*.md' -o -name '*.markdown' \) -print | sed 's|^\./||' | sort | head -n 1000
find . -mindepth 1 -maxdepth 4 \( -name node_modules -o -name target -o -name '.*' \) -prune -o -type d -print | sed 's|^\./||; s|$|/|' | sort | head -n 500"#;

/// Turn the output of the list script into a listing
fn parse_listing(folder: &str, out: &str) -> FolderListing {
    let mut lines = out.lines();
    let first = lines.next().unwrap_or_default().trim().to_string();
    if first == MISSING {
        return FolderListing { folder: folder.into(), root: String::new(), files: vec![], missing: true, error: None };
    }
    let files = lines.map(|l| l.to_string()).filter(|l| !l.is_empty()).collect();
    FolderListing { folder: folder.into(), root: first, files, missing: false, error: None }
}

pub fn list(host: &HostCfg, folders: &[String]) -> Vec<FolderListing> {
    folders
        .iter()
        .map(|folder| {
            let script = format!("if ! cd {} 2>/dev/null; then echo {MISSING}; exit 0; fi; {LIST}", shell_path(folder));
            match hostexec::run_shell(host, &script, None) {
                Ok(out) => parse_listing(folder, &out),
                Err(e) => FolderListing {
                    folder: folder.clone(),
                    root: String::new(),
                    files: vec![],
                    missing: false,
                    error: Some(e),
                },
            }
        })
        .collect()
}

pub fn read(host: &HostCfg, path: &str) -> Result<String, String> {
    hostexec::run_shell(host, &format!("cat {}", sq(path)), None)
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
    fn detects_missing_folder() {
        let l = parse_listing("~/gone", "__PIBAR_MISSING__\n");
        assert!(l.missing);
        assert!(l.files.is_empty());
        assert_eq!(l.root, "");
    }
}
