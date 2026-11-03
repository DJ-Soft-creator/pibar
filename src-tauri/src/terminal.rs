//! Interactive terminal in the main window: one shell per tab, running in a pty locally or over SSH.
//! Output goes to the UI as base64 "term-output" events (a terminal stream is bytes, not text), the UI sends keys
//! and the size back. See src/main/terminal.ts for the xterm.js side.

use crate::config::HostCfg;
use crate::disclaim;
use crate::hostexec::{self, shell_path};
use crate::i18n::tr;
use base64::Engine;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

/// Open terminals by id; the id is what the UI knows and uses for every call
#[derive(Default)]
pub struct TermManager {
    terms: Mutex<HashMap<u32, Term>>,
    next: AtomicU32,
}

struct Term {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

/// Expand what a UI may pass as working folder: empty and "~" mean the home folder
fn expand(cwd: &str, home: &str) -> String {
    let cwd = cwd.trim();
    if cwd.is_empty() || cwd == "~" {
        home.to_string()
    } else if let Some(rest) = cwd.strip_prefix("~/") {
        format!("{}/{}", home.trim_end_matches('/'), rest)
    } else {
        cwd.to_string()
    }
}

/// Program and arguments of the shell behind a terminal: the login shell locally, an SSH session with a tty remotely
fn shell_command(h: &HostCfg, cwd: &str) -> (String, Vec<String>) {
    if h.kind == "ssh" {
        let mut args = hostexec::ssh_args(h, true);
        // a login shell on the host, started in the session's folder
        args.push(format!("cd {} 2>/dev/null || cd \"$HOME\"; exec \"${{SHELL:-bash}}\" -l", shell_path(cwd)));
        return disclaim::wrap("ssh", args);
    }
    disclaim::wrap(&hostexec::login_shell(), vec!["-il".to_string()])
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize { rows: rows.max(1), cols: cols.max(1), pixel_width: 0, pixel_height: 0 }
}

impl TermManager {
    /// Start a shell in `cwd` on the host and return the id of the new terminal
    pub fn open(&self, app: &AppHandle, host: &HostCfg, cwd: &str, cols: u16, rows: u16) -> Result<u32, String> {
        let pair = native_pty_system().openpty(size(cols, rows)).map_err(|e| e.to_string())?;
        let (program, args) = shell_command(host, cwd);
        let mut cmd = CommandBuilder::new(&program);
        cmd.args(&args);
        cmd.env("TERM", "xterm-256color");
        if host.kind != "ssh" {
            let home = std::env::var("HOME").unwrap_or_default();
            let dir = expand(cwd, &home);
            if !dir.is_empty() {
                cmd.cwd(dir);
            }
            for (k, v) in hostexec::user_env() {
                cmd.env(k, v);
            }
        }
        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| tr(format!("Terminal could not start: {e}"), format!("Terminal konnte nicht starten: {e}")))?;
        // the slave must be gone, otherwise the reader never sees the end of the stream
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

        let id = self.next.fetch_add(1, Ordering::SeqCst) + 1;
        let app = app.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let data = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                        let _ = app.emit("term-output", serde_json::json!({ "id": id, "data": data }));
                    }
                }
            }
            let _ = app.emit("term-exit", serde_json::json!({ "id": id }));
        });

        self.terms.lock().map_err(|e| e.to_string())?.insert(id, Term { master: pair.master, writer, child });
        Ok(id)
    }

    /// Keys from the UI
    pub fn write(&self, id: u32, data: &str) -> Result<(), String> {
        let mut terms = self.terms.lock().map_err(|e| e.to_string())?;
        let term = terms.get_mut(&id).ok_or_else(|| tr("Terminal is gone", "Terminal ist weg"))?;
        term.writer.write_all(data.as_bytes()).and_then(|_| term.writer.flush()).map_err(|e| e.to_string())
    }

    pub fn resize(&self, id: u32, cols: u16, rows: u16) -> Result<(), String> {
        let terms = self.terms.lock().map_err(|e| e.to_string())?;
        let term = terms.get(&id).ok_or_else(|| tr("Terminal is gone", "Terminal ist weg"))?;
        term.master.resize(size(cols, rows)).map_err(|e| e.to_string())
    }

    pub fn close(&self, id: u32) {
        let term = self.terms.lock().ok().and_then(|mut t| t.remove(&id));
        if let Some(mut term) = term {
            let _ = term.child.kill();
        }
    }

    pub fn close_all(&self) {
        let ids: Vec<u32> = self.terms.lock().map(|t| t.keys().copied().collect()).unwrap_or_default();
        for id in ids {
            self.close(id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pty_runs_a_shell_command() {
        let pair = native_pty_system().openpty(size(80, 24)).expect("pty");
        let mut cmd = CommandBuilder::new("sh");
        cmd.args(["-c", "printf 'hello from the pty'"]);
        let _child = pair.slave.spawn_command(cmd).expect("spawn");
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().expect("reader");
        let mut out = Vec::new();
        reader.read_to_end(&mut out).expect("read");
        assert!(String::from_utf8_lossy(&out).contains("hello from the pty"));
    }

    #[test]
    fn expands_home() {
        assert_eq!(expand("", "/home/me"), "/home/me");
        assert_eq!(expand("~", "/home/me"), "/home/me");
        assert_eq!(expand("~/work/x", "/home/me/"), "/home/me/work/x");
        assert_eq!(expand("/srv/app", "/home/me"), "/srv/app");
    }
}
