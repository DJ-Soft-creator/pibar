//! Session lock on the host (task D1): a session must never run in two Pi processes at once (desktop and webapp).
//! The script that starts Pi writes `~/.pibar/<hash>.lock` ("<owner> <pid> <unix seconds>", hash as in bg.rs) and
//! then becomes Pi (`exec`), so the pid in the file is Pi's. A lock counts only while that process lives and its
//! command line names the session file (pid reuse); stale locks are ignored. Same scripts as the webapp's
//! webapp/src/server/host/lock.ts. Owners: "desktop:<instance>" (this app run) or "webapp:<instance>".

use crate::bg;
use crate::config::HostCfg;
use crate::hostexec::{self, sq};
use crate::i18n::tr;
use std::sync::OnceLock;

/// Lock file of a session (shell snippet, expands "$HOME")
pub fn path(session: &str) -> String {
    format!("\"$HOME\"/.pibar/{}.lock", bg::hash(session))
}

/// Owner id of this app run, so its own locks never block it (a reopen after a close or a crash of Pi)
pub fn owner() -> &'static str {
    static OWNER: OnceLock<String> = OnceLock::new();
    OWNER.get_or_init(|| {
        let nanos =
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        format!("desktop:{}", &bg::hash(&format!("{}-{nanos}", std::process::id()))[..8])
    })
}

/// Shell condition: process "$p" lives and its command line names the session file
fn alive_check(session: &str) -> String {
    format!(
        "[ -n \"$p\" ] && kill -0 \"$p\" 2>/dev/null && \
         {{ ps -ww -p \"$p\" -o args= 2>/dev/null || ps -p \"$p\" -o args= 2>/dev/null; }} | grep -qF -e {}",
        sq(session)
    )
}

/// Prints "<owner> <pid> <time>" of a live lock, nothing when the session is free or the lock is stale
pub fn check_script(session: &str) -> String {
    format!(
        "f={}; if [ -s \"$f\" ]; then read -r o p t < \"$f\"; if {}; then echo \"$o $p $t\"; fi; fi; true",
        path(session),
        alive_check(session)
    )
}

/// Take a session over: stop the Pi process holding the lock (TERM, after 3 s KILL); a stale lock is left alone
pub fn takeover_script(session: &str) -> String {
    format!(
        "f={}; if [ -s \"$f\" ]; then read -r o p t < \"$f\"; if {}; then kill -TERM \"$p\" 2>/dev/null; i=0; \
         while kill -0 \"$p\" 2>/dev/null && [ $i -lt 30 ]; do sleep 0.1; i=$((i+1)); done; \
         kill -0 \"$p\" 2>/dev/null && kill -KILL \"$p\" 2>/dev/null; fi; fi; true",
        path(session),
        alive_check(session)
    )
}

/// Put in front of the Pi start script: writes the lock with the pid of the shell that then becomes Pi
pub fn write_prefix(owner: &str, session: &str) -> String {
    let clean: String = owner.chars().filter(|c| c.is_ascii_alphanumeric() || ":._-".contains(*c)).collect();
    let clean = if clean.is_empty() { "unknown".to_string() } else { clean };
    format!("mkdir -p \"$HOME\"/.pibar && echo {} \"$$\" \"$(date +%s)\" > {} && ", sq(&clean), path(session))
}

/// Holder of a live lock
#[derive(Debug, PartialEq)]
pub struct Holder {
    pub owner: String,
    /// "desktop" or "webapp"
    pub kind: String,
    /// Unix seconds the holder started (0 = unknown)
    pub since: u64,
}

/// The output of check_script; None = free
pub fn parse(out: &str) -> Option<Holder> {
    let mut it = out.split_whitespace();
    let owner = it.next()?.to_string();
    let pid = it.next()?;
    if pid.is_empty() || !pid.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let since = it.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    let kind = owner.split(':').next().unwrap_or(&owner).to_string();
    Some(Holder { owner, kind, since })
}

/// Error text of a locked session: a tag the UI recognises (src/shared/sessionLock.ts), then a readable sentence
pub fn locked_error(h: &Holder) -> String {
    let text = if h.kind == "webapp" {
        tr("This session is open in the webapp right now", "Diese Session ist gerade in der Webapp offen")
    } else {
        tr("This session is open in another PiBar right now", "Diese Session ist gerade in einem anderen PiBar offen")
    };
    format!("session-locked:{}:{} {text}", h.kind, h.since)
}

/// Before Pi starts for a session: no other live Pi may hold it. Own locks count as free; `force` stops the other.
pub fn claim(host: &HostCfg, session: &str, force: bool) -> Result<(), String> {
    let out = hostexec::run_shell(host, &check_script(session), None)?;
    let Some(holder) = parse(&out) else { return Ok(()) };
    if holder.owner == owner() {
        return Ok(());
    }
    if !force {
        return Err(locked_error(&holder));
    }
    hostexec::run_shell(host, &takeover_script(session), None).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_hash_and_path_as_the_webapp() {
        // webapp/test/sessionLock.test.ts checks the same value
        assert_eq!(bg::hash("/a/b/c.jsonl"), "76d5cfaef7a0f99a");
        assert_eq!(path("/a/b/c.jsonl"), "\"$HOME\"/.pibar/76d5cfaef7a0f99a.lock");
    }

    #[test]
    fn scripts_quote_the_session_path() {
        let evil = "/tmp/$(touch pwned)'x.jsonl";
        for s in [check_script(evil), takeover_script(evil)] {
            assert!(s.contains("-e '/tmp/$(touch pwned)'\\''x.jsonl'"), "{s}");
            assert!(s.contains("kill -0 \"$p\""));
        }
        assert!(!write_prefix("desktop:1", evil).contains("touch"));
    }

    #[test]
    fn prefix_writes_owner_pid_and_time_before_pi() {
        let p = write_prefix("desktop:ab;rm -rf", "/s.jsonl");
        assert!(p.starts_with("mkdir -p \"$HOME\"/.pibar && echo 'desktop:abrm-rf' \"$$\" \"$(date +%s)\" > "));
        assert!(p.ends_with(".lock && "));
    }

    #[test]
    fn parses_the_check_output() {
        assert_eq!(
            parse("webapp:1a2b 4242 1700000000\n"),
            Some(Holder { owner: "webapp:1a2b".into(), kind: "webapp".into(), since: 1700000000 })
        );
        assert_eq!(parse(""), None);
        assert_eq!(parse("garbage"), None);
        assert_eq!(parse("x y"), None);
        let e = locked_error(&parse("webapp:1 2 3").unwrap());
        assert!(e.starts_with("session-locked:webapp:3 "));
    }

    #[test]
    fn owner_is_stable_and_desktop() {
        assert_eq!(owner(), owner());
        assert!(owner().starts_with("desktop:") && owner().len() == 16);
    }
}
