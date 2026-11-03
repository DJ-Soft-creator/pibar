//! Runs in the background: Pi is started detached on the host (`setsid`/`nohup`), so the run keeps going when
//! PiBar quits or the connection drops. PiBar follows it through a log file (`pi --mode json`) and later reads the
//! answer from the session file, which Pi writes anyway.
//!
//! Two files per session on the host, both below `~/.pibar` and named after a hash of the session file:
//! `<hash>.log` (Pi's JSON output) and `<hash>.pid` (Pi's process id, for "is it still running?" and "stop it").

use crate::config::HostCfg;
use crate::hostexec::{self, shell_path, sq};
use crate::i18n::tr;

/// Stable name for a session's two files: FNV-1a over the session path (no dependency, same on every start)
pub fn hash(s: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.as_bytes() {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{h:016x}")
}

/// Program name of Pi on this host without a path: a pid is only ours if its command line carries it (pid reuse)
fn pi_name(h: &HostCfg) -> String {
    let pi = if h.pi_command.trim().is_empty() { "pi" } else { h.pi_command.trim() };
    pi.split_whitespace().next().unwrap_or("pi").rsplit('/').next().unwrap_or("pi").to_string()
}

/// Log and pid file of a session's run on the host (shell snippets, they expand "$HOME")
pub fn paths(session: &str) -> (String, String) {
    let h = hash(session);
    (format!("\"$HOME\"/.pibar/{h}.log"), format!("\"$HOME\"/.pibar/{h}.pid"))
}

/// Start Pi detached with the given arguments (session, model, prompt, …); returns as soon as it wrote its pid.
pub fn start(h: &HostCfg, cwd: &str, session: &str, args: &[String]) -> Result<(), String> {
    let (log, pid) = paths(session);
    let pi = if h.pi_command.trim().is_empty() { "pi" } else { h.pi_command.trim() };
    let args: Vec<String> = args.iter().map(|a| sq(a)).collect();
    // The inner shell writes its own pid and then becomes Pi (`exec`), so the pid file stays right.
    let inner = format!("echo $$ > {pid}; exec {pi} --mode json {}", args.join(" "));
    // setsid is missing on macOS: nohup alone keeps the process alive there
    let script = format!(
        "mkdir -p \"$HOME\"/.pibar && cd {} && rm -f {pid} && \
         if command -v setsid >/dev/null 2>&1; then setsid nohup sh -c {inner} > {log} 2>&1 < /dev/null & \
         else nohup sh -c {inner} > {log} 2>&1 < /dev/null & fi; \
         i=0; while [ ! -s {pid} ] && [ $i -lt 60 ]; do sleep 0.1; i=$((i+1)); done; \
         [ -s {pid} ]",
        shell_path(cwd),
        inner = sq(&inner)
    );
    hostexec::run_shell(h, &script, None).map(|_| ()).map_err(|e| {
        tr(
            format!("Pi could not be started in the background: {e}"),
            format!("Pi konnte nicht im Hintergrund starten: {e}"),
        )
    })
}

/// Is the session's run still going? false if no pid file exists or the process is gone
pub fn running(h: &HostCfg, session: &str) -> Result<bool, String> {
    let (_, pid) = paths(session);
    let script = format!(
        "p=$(cat {pid} 2>/dev/null); \
         if [ -n \"$p\" ] && kill -0 \"$p\" 2>/dev/null && ps -p \"$p\" -o args= 2>/dev/null | grep -qF -e {name}; \
         then echo yes; else echo no; fi",
        pid = pid,
        name = sq(&pi_name(h))
    );
    let out = hostexec::run_shell(h, &script, None)?;
    Ok(out.trim() == "yes")
}

/// Stop the session's run (SIGTERM) and drop its pid file; the session file keeps whatever Pi wrote so far
pub fn stop(h: &HostCfg, session: &str) -> Result<(), String> {
    let (_, pid) = paths(session);
    let script = format!(
        "p=$(cat {pid} 2>/dev/null); \
         if [ -n \"$p\" ] && ps -p \"$p\" -o args= 2>/dev/null | grep -qF -e {name}; then kill -TERM \"$p\" 2>/dev/null; fi; \
         rm -f {pid}; true",
        pid = pid,
        name = sq(&pi_name(h))
    );
    hostexec::run_shell(h, &script, None).map(|_| ())
}

/// Print the log of the session's run and follow it until the process is gone (the follower in pi.rs)
pub fn follow_script(session: &str) -> String {
    let (log, pid) = paths(session);
    format!(
        "p=$(cat {pid} 2>/dev/null); [ -n \"$p\" ] || exit 1; \
         tail -n +1 -f {log} & t=$!; \
         while kill -0 \"$p\" 2>/dev/null; do sleep 0.5; done; sleep 0.4; kill $t 2>/dev/null; rm -f {pid}; true"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_is_stable_and_short() {
        assert_eq!(hash("/a/b/c.jsonl"), hash("/a/b/c.jsonl"));
        assert_ne!(hash("/a/b/c.jsonl"), hash("/a/b/d.jsonl"));
        assert_eq!(hash("x").len(), 16);
    }

    #[test]
    fn paths_are_shell_safe() {
        let (log, pid) = paths("/home/me/.pi/agent/sessions/x.jsonl");
        assert!(log.starts_with("\"$HOME\"/.pibar/"));
        assert!(log.ends_with(".log"));
        assert!(pid.ends_with(".pid"));
        assert!(log[..].chars().all(|c| c.is_ascii_alphanumeric() || "/.$\"-_".contains(c)));
    }

    #[test]
    fn follow_waits_for_the_pid() {
        let script = follow_script("/x/y.jsonl");
        assert!(script.contains("tail -n +1 -f"));
        assert!(script.contains("kill -0"));
    }
}
