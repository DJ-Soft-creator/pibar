//! Manages the running Pi processes (one process per open session).
//! Speaks Pi's RPC protocol: JSON lines over stdin/stdout.

use crate::config::HostCfg;
use crate::hostexec;
use crate::i18n::tr;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;

type Pending = Arc<Mutex<HashMap<String, oneshot::Sender<Value>>>>;

/// How long a single RPC command may take until Pi answers (the answer to a prompt arrives as events, not here)
const RPC_TIMEOUT: Duration = Duration::from_secs(60);

/// Lock that survives a panic in another thread (a poisoned lock would otherwise take down every session)
fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Read Pi's stdout until it closes: answers go to the waiting call, everything else is an event for the UI.
/// When the stream ends, calls still waiting fail at once ("Pi process has ended") instead of after the timeout.
fn pump(reader: impl BufRead, pending: &Pending, mut emit: impl FnMut(Value)) {
    for line in reader.lines().map_while(Result::ok) {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            // ignore output of the login shell and the like
            continue;
        };
        if v.get("type").and_then(Value::as_str) == Some("response") {
            if let Some(id) = v.get("id").and_then(Value::as_str) {
                if let Some(tx) = lock(pending).remove(id) {
                    let _ = tx.send(v);
                    continue;
                }
            }
        }
        emit(v);
    }
    // dropping the senders wakes every waiting send() with an error
    lock(pending).clear();
}

/// Collect the exit status of a process that closed its output, so it does not linger as a zombie.
/// Gives up after a few seconds; close() then kills and reaps it.
fn reap_soon(child: &Mutex<Child>) {
    for _ in 0..50 {
        if !matches!(lock(child).try_wait(), Ok(None)) {
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

struct PiProc {
    stdin: Mutex<ChildStdin>,
    child: Arc<Mutex<Child>>,
    pending: Pending,
    /// Last ~4000 characters Pi wrote to stderr (warnings, network errors)
    stderr_tail: Arc<Mutex<String>>,
}

/// Pi's tool flags: None = Pi's default, empty = no tools, otherwise an allowlist ("read,bash,…")
pub fn tool_args(tools: Option<&[String]>) -> Vec<String> {
    match tools {
        None => vec![],
        Some([]) => vec!["--no-tools".into()],
        Some(list) => {
            let clean: Vec<&str> = list
                .iter()
                .map(|s| s.trim())
                .filter(|s| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-'))
                .collect();
            if clean.is_empty() {
                vec!["--no-tools".into()]
            } else {
                vec!["--tools".into(), clean.join(",")]
            }
        }
    }
}

#[derive(Default)]
pub struct PiManager {
    procs: Mutex<HashMap<u32, Arc<PiProc>>>,
    next_handle: AtomicU32,
    next_req: AtomicU64,
}

impl PiManager {
    pub fn open(
        &self,
        app: &AppHandle,
        host: &HostCfg,
        cwd: &str,
        session_path: Option<String>,
        tools: Option<Vec<String>>,
    ) -> Result<u32, String> {
        let mut args = Vec::new();
        if let Some(p) = session_path {
            args.push("--session".to_string());
            args.push(p);
        }
        args.extend(tool_args(tools.as_deref()));
        let mut child = hostexec::spawn_pi(host, cwd, &args)?;
        let stdin = child.stdin.take().ok_or("no stdin")?;
        let stdout = child.stdout.take().ok_or("no stdout")?;
        let stderr = child.stderr.take().ok_or("no stderr")?;

        let handle = self.next_handle.fetch_add(1, Ordering::SeqCst) + 1;
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let stderr_tail = Arc::new(Mutex::new(String::new()));

        // keep the tail of stderr (for the error message when Pi exits)
        {
            let tail = stderr_tail.clone();
            std::thread::spawn(move || {
                for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                    let mut t = lock(&tail);
                    t.push_str(&line);
                    t.push('\n');
                    if t.len() > 4000 {
                        let cut = t.len() - 4000;
                        let cut = (cut..t.len()).find(|i| t.is_char_boundary(*i)).unwrap_or(0);
                        t.drain(..cut);
                    }
                }
            });
        }

        let child = Arc::new(Mutex::new(child));
        {
            let pending = pending.clone();
            let app = app.clone();
            let tail = stderr_tail.clone();
            let child = child.clone();
            std::thread::spawn(move || {
                pump(BufReader::new(stdout), &pending, |v| {
                    let _ = app.emit("pi-event", json!({ "handle": handle, "event": v }));
                });
                reap_soon(&child);
                let stderr = lock(&tail).clone();
                let _ = app.emit("pi-exit", json!({ "handle": handle, "stderr": stderr }));
            });
        }

        let proc = Arc::new(PiProc { stdin: Mutex::new(stdin), child, pending, stderr_tail });
        lock(&self.procs).insert(handle, proc);
        Ok(handle)
    }

    pub async fn send(&self, handle: u32, mut cmd: Value) -> Result<Value, String> {
        let proc = lock(&self.procs)
            .get(&handle)
            .cloned()
            .ok_or_else(|| tr("Pi process not found", "Pi-Prozess nicht gefunden"))?;
        let id = format!("r{}", self.next_req.fetch_add(1, Ordering::SeqCst) + 1);
        cmd["id"] = Value::String(id.clone());
        let (tx, rx) = oneshot::channel();
        lock(&proc.pending).insert(id.clone(), tx);
        {
            let mut stdin = lock(&proc.stdin);
            let line = serde_json::to_string(&cmd).map_err(|e| e.to_string())?;
            stdin.write_all(line.as_bytes()).and_then(|_| stdin.write_all(b"\n")).and_then(|_| stdin.flush()).map_err(
                |e| {
                    lock(&proc.pending).remove(&id);
                    tr(format!("Pi not reachable: {e}"), format!("Pi nicht erreichbar: {e}"))
                },
            )?;
        }
        match tokio::time::timeout(RPC_TIMEOUT, rx).await {
            Ok(Ok(v)) => Ok(v),
            Ok(Err(_)) => Err(tr("Pi process has ended", "Pi-Prozess wurde beendet")),
            Err(_) => {
                lock(&proc.pending).remove(&id);
                Err(tr("Pi did not answer in time", "Zeitüberschreitung bei Pi"))
            }
        }
    }

    /// What the Pi process wrote to stderr so far (tail), for the error details in the chat
    pub fn stderr(&self, handle: u32) -> String {
        lock(&self.procs).get(&handle).map(|p| lock(&p.stderr_tail).clone()).unwrap_or_default()
    }

    /// Stop the process and collect its exit status (in the background, the caller does not wait)
    pub fn close(&self, handle: u32) {
        if let Some(p) = lock(&self.procs).remove(&handle) {
            std::thread::spawn(move || {
                let mut child = lock(&p.child);
                let _ = child.kill();
                let _ = child.wait();
            });
        }
    }

    pub fn close_all(&self) {
        let all: Vec<u32> = lock(&self.procs).keys().copied().collect();
        for h in all {
            self.close(h);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn routes_answers_and_events() {
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let (tx, mut rx) = oneshot::channel();
        lock(&pending).insert("r1".into(), tx);
        let out = "login banner\n{\"type\":\"agent_start\"}\n{\"type\":\"response\",\"id\":\"r1\",\"success\":true}\n";
        let mut events = vec![];
        pump(Cursor::new(out), &pending, |v| events.push(v));
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["type"], "agent_start");
        assert_eq!(rx.try_recv().unwrap()["id"], "r1");
    }

    #[test]
    fn waiting_calls_fail_when_pi_ends() {
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let (tx, mut rx) = oneshot::channel();
        lock(&pending).insert("r7".into(), tx);
        pump(Cursor::new(""), &pending, |_| {});
        assert!(lock(&pending).is_empty());
        assert!(matches!(rx.try_recv(), Err(oneshot::error::TryRecvError::Closed)));
    }

    #[test]
    fn builds_tool_flags() {
        assert!(tool_args(None).is_empty());
        assert_eq!(tool_args(Some(&[])), vec!["--no-tools"]);
        let l = vec!["read".to_string(), "grep".to_string(), "bad;rm".to_string()];
        assert_eq!(tool_args(Some(&l)), vec!["--tools", "read,grep"]);
    }
}
