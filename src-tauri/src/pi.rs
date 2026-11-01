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
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;

type Pending = Arc<Mutex<HashMap<String, oneshot::Sender<Value>>>>;

struct PiProc {
    stdin: Mutex<ChildStdin>,
    child: Mutex<Child>,
    pending: Pending,
    /// Last ~4000 characters Pi wrote to stderr (warnings, network errors)
    stderr_tail: Arc<Mutex<String>>,
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
    ) -> Result<u32, String> {
        let mut args = Vec::new();
        if let Some(p) = session_path {
            args.push("--session".to_string());
            args.push(p);
        }
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
                    let mut t = tail.lock().unwrap();
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

        // stdout: responses go to the waiting call, everything else is an event for the UI
        {
            let pending = pending.clone();
            let app = app.clone();
            let tail = stderr_tail.clone();
            std::thread::spawn(move || {
                for line in BufReader::new(stdout).lines().map_while(Result::ok) {
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
                            if let Some(tx) = pending.lock().unwrap().remove(id) {
                                let _ = tx.send(v);
                                continue;
                            }
                        }
                    }
                    let _ = app.emit("pi-event", json!({ "handle": handle, "event": v }));
                }
                let stderr = tail.lock().unwrap().clone();
                let _ = app.emit("pi-exit", json!({ "handle": handle, "stderr": stderr }));
            });
        }

        let proc = Arc::new(PiProc { stdin: Mutex::new(stdin), child: Mutex::new(child), pending, stderr_tail });
        self.procs.lock().unwrap().insert(handle, proc);
        Ok(handle)
    }

    pub async fn send(&self, handle: u32, mut cmd: Value) -> Result<Value, String> {
        let proc = self
            .procs
            .lock()
            .unwrap()
            .get(&handle)
            .cloned()
            .ok_or_else(|| tr("Pi process not found", "Pi-Prozess nicht gefunden"))?;
        let id = format!("r{}", self.next_req.fetch_add(1, Ordering::SeqCst) + 1);
        cmd["id"] = Value::String(id.clone());
        let (tx, rx) = oneshot::channel();
        proc.pending.lock().unwrap().insert(id.clone(), tx);
        {
            let mut stdin = proc.stdin.lock().unwrap();
            let line = serde_json::to_string(&cmd).map_err(|e| e.to_string())?;
            stdin
                .write_all(line.as_bytes())
                .and_then(|_| stdin.write_all(b"\n"))
                .and_then(|_| stdin.flush())
                .map_err(|e| tr(format!("Pi not reachable: {e}"), format!("Pi nicht erreichbar: {e}")))?;
        }
        match tokio::time::timeout(Duration::from_secs(60), rx).await {
            Ok(Ok(v)) => Ok(v),
            Ok(Err(_)) => Err(tr("Pi process has ended", "Pi-Prozess wurde beendet")),
            Err(_) => {
                proc.pending.lock().unwrap().remove(&id);
                Err(tr("Pi did not answer in time", "Zeitüberschreitung bei Pi"))
            }
        }
    }

    /// What the Pi process wrote to stderr so far (tail), for the error details in the chat
    pub fn stderr(&self, handle: u32) -> String {
        self.procs.lock().unwrap().get(&handle).map(|p| p.stderr_tail.lock().unwrap().clone()).unwrap_or_default()
    }

    pub fn close(&self, handle: u32) {
        if let Some(p) = self.procs.lock().unwrap().remove(&handle) {
            let _ = p.child.lock().unwrap().kill();
        }
    }

    pub fn close_all(&self) {
        let all: Vec<u32> = self.procs.lock().unwrap().keys().copied().collect();
        for h in all {
            self.close(h);
        }
    }
}
