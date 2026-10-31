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
    /// Files relative to root
    pub files: Vec<String>,
    pub error: Option<String>,
}

pub fn list(host: &HostCfg, folders: &[String]) -> Vec<FolderListing> {
    folders
        .iter()
        .map(|folder| {
            let script = format!(
                "cd {} && pwd && find . -maxdepth 5 \\( -name node_modules -o -name .git -o -name target \\) -prune -o -type f \\( -name '*.md' -o -name '*.markdown' \\) -print | sed 's|^\\./||' | sort | head -n 1000",
                shell_path(folder)
            );
            match hostexec::run_shell(host, &script, None) {
                Ok(out) => {
                    let mut lines = out.lines();
                    let root = lines.next().unwrap_or_default().trim().to_string();
                    let files = lines.map(|l| l.to_string()).filter(|l| !l.is_empty()).collect();
                    FolderListing { folder: folder.clone(), root, files, error: None }
                }
                Err(e) => FolderListing { folder: folder.clone(), root: String::new(), files: vec![], error: Some(e) },
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
