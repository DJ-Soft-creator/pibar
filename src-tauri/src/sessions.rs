//! Read a host's session list from Pi's session folder (~/.pi/agent/sessions) and delete session files.
//! Pi has no list command itself, but the files are plain JSONL.

use crate::config::HostCfg;
use crate::hostexec::{self, sq};
use crate::i18n::tr;
use serde::Serialize;
use serde_json::Value;

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub path: String,
    pub id: String,
    pub cwd: String,
    pub timestamp: String,
    pub title: String,
    pub name: Option<String>,
    /// Session this one was branched from (header `parentSession`, set by Pi's fork)
    pub parent: Option<String>,
}

const LIST_SCRIPT: &str = r#"
dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/sessions"
[ -d "$dir" ] || exit 0
ls -t "$dir"/*/*.jsonl 2>/dev/null | head -n 300 | while IFS= read -r f; do
  printf '%s\t' "$f"
  head -n 1 "$f" | tr -d '\t\n'
  printf '\t'
  grep -m1 '"role":"user"' "$f" | cut -c1-2000 | tr -d '\t\n'
  printf '\t'
  grep '"type":"session_info"' "$f" | tail -n 1 | tr -d '\t\n'
  printf '\n'
done
"#;

/// Extract the first text from a (possibly truncated) JSON line.
fn first_text(raw: &str) -> String {
    let key = "\"text\":\"";
    let Some(start) = raw.find(key) else { return String::new() };
    let mut out = String::new();
    let mut chars = raw[start + key.len()..].chars();
    while let Some(c) = chars.next() {
        match c {
            '"' => break,
            '\\' => match chars.next() {
                Some('n') | Some('t') | Some('r') => out.push(' '),
                Some(other) => out.push(other),
                None => break,
            },
            _ => out.push(c),
        }
        if out.chars().count() > 120 {
            break;
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub fn list(host: &HostCfg) -> Result<Vec<SessionInfo>, String> {
    let out = hostexec::run_shell(host, LIST_SCRIPT, None)?;
    let mut result = Vec::new();
    for line in out.lines() {
        let parts: Vec<&str> = line.splitn(4, '\t').collect();
        if parts.len() < 3 {
            continue;
        }
        let header: Value = serde_json::from_str(parts[1]).unwrap_or(Value::Null);
        let title = first_text(parts[2]);
        if title.is_empty() {
            continue; // skip empty sessions without a message
        }
        let name = parts
            .get(3)
            .and_then(|s| serde_json::from_str::<Value>(s).ok())
            .and_then(|v| v.get("name").and_then(Value::as_str).map(String::from));
        result.push(SessionInfo {
            path: parts[0].to_string(),
            id: header.get("id").and_then(Value::as_str).unwrap_or_default().to_string(),
            cwd: header.get("cwd").and_then(Value::as_str).unwrap_or_default().to_string(),
            timestamp: header.get("timestamp").and_then(Value::as_str).unwrap_or_default().to_string(),
            title,
            name,
            parent: header.get("parentSession").and_then(Value::as_str).map(String::from),
        });
    }
    Ok(result)
}

/// User messages of a session file in file order: entry id and the start of the text. Branches made by Pi's fork
/// keep the entry ids of the shared history, so comparing the id lists shows where two branches part.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionOutline {
    pub path: String,
    /// Last change, seconds since the epoch (0 = unknown)
    pub mtime: i64,
    pub users: Vec<UserEntry>,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct UserEntry {
    pub id: String,
    pub text: String,
}

const OUTLINE_MARK: &str = "__PIBAR_OUTLINE__";

/// The value of the first `"id":"…"` in a JSON line (for a message entry: the entry id, it comes before the message)
fn entry_id(line: &str) -> Option<String> {
    let key = "\"id\":\"";
    let start = line.find(key)? + key.len();
    let end = line[start..].find('"')?;
    Some(line[start..start + end].to_string())
}

/// Output: per file a marker line "MARK<TAB>path<TAB>mtime", then its user message lines (shortened)
pub fn parse_outlines(out: &str) -> Vec<SessionOutline> {
    let mut result: Vec<SessionOutline> = Vec::new();
    for line in out.lines() {
        if let Some(rest) = line.strip_prefix(OUTLINE_MARK) {
            let mut parts = rest.trim_start_matches('\t').splitn(2, '\t');
            let path = parts.next().unwrap_or_default().to_string();
            let mtime = parts.next().and_then(|m| m.trim().parse().ok()).unwrap_or(0);
            result.push(SessionOutline { path, mtime, users: vec![] });
        } else if let (Some(cur), Some(id)) = (result.last_mut(), entry_id(line)) {
            cur.users.push(UserEntry { id, text: first_text(line) });
        }
    }
    result
}

/// Shell script printing the outline of each file (see [`parse_outlines`])
fn outline_script(paths: &[String]) -> String {
    let args: Vec<String> = paths.iter().map(|p| sq(p)).collect();
    format!(
        "for f in {}; do [ -f \"$f\" ] || continue; printf '{OUTLINE_MARK}\\t%s\\t%s\\n' \"$f\" \"$(date -r \"$f\" +%s 2>/dev/null)\"; \
         grep -F '\"type\":\"message\"' \"$f\" | grep -F '\"role\":\"user\"' | cut -c1-3000; done",
        args.join(" ")
    )
}

pub fn outlines(host: &HostCfg, paths: &[String]) -> Result<Vec<SessionOutline>, String> {
    if let Some(bad) = paths.iter().find(|p| !is_session_file(p)) {
        return Err(tr(format!("Not a Pi session file: {bad}"), format!("Keine Pi-Session-Datei: {bad}")));
    }
    if paths.is_empty() {
        return Ok(vec![]);
    }
    hostexec::run_shell(host, &outline_script(paths), None).map(|out| parse_outlines(&out))
}

/// Only Pi session files may be deleted: "…/sessions/…/<name>.jsonl", absolute, without "..".
pub fn is_session_file(path: &str) -> bool {
    path.starts_with('/')
        && path.ends_with(".jsonl")
        && path.contains("/sessions/")
        && !path.split('/').any(|seg| seg == ".." || seg == ".")
}

/// Delete session files on the host; returns how many paths were handed over
pub fn delete(host: &HostCfg, paths: &[String]) -> Result<usize, String> {
    if let Some(bad) = paths.iter().find(|p| !is_session_file(p)) {
        return Err(tr(format!("Not a Pi session file: {bad}"), format!("Keine Pi-Session-Datei: {bad}")));
    }
    if paths.is_empty() {
        return Ok(0);
    }
    let args: Vec<String> = paths.iter().map(|p| sq(p)).collect();
    hostexec::run_shell(host, &format!("rm -f -- {}", args.join(" ")), None)?;
    Ok(paths.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_outlines() {
        let out = "__PIBAR_OUTLINE__\t/s/a.jsonl\t1730000000\n\
{\"type\":\"message\",\"id\":\"u1\",\"parentId\":null,\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"Erste Frage\"}]}}\n\
{\"type\":\"message\",\"id\":\"u2\",\"parentId\":\"a1\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"Zweite\"}]}}\n\
__PIBAR_OUTLINE__\t/s/b.jsonl\t\n";
        let o = parse_outlines(out);
        assert_eq!(o.len(), 2);
        assert_eq!(o[0].path, "/s/a.jsonl");
        assert_eq!(o[0].mtime, 1730000000);
        assert_eq!(
            o[0].users,
            vec![
                UserEntry { id: "u1".into(), text: "Erste Frage".into() },
                UserEntry { id: "u2".into(), text: "Zweite".into() }
            ]
        );
        assert_eq!((o[1].mtime, o[1].users.len()), (0, 0));
    }

    #[test]
    fn only_session_files_can_be_deleted() {
        assert!(is_session_file("/home/u/.pi/agent/sessions/--home-u--/2026-10-31_abc.jsonl"));
        assert!(!is_session_file("/home/u/.pi/agent/sessions/../../.bashrc"));
        assert!(!is_session_file("/home/u/notes.jsonl"));
        assert!(!is_session_file("relative/sessions/x.jsonl"));
        assert!(!is_session_file("/home/u/.pi/agent/sessions/x.md"));
    }

    #[test]
    fn extracts_text() {
        let raw = r#"{"type":"message","message":{"role":"user","content":[{"type":"text","text":"Hallo \"Welt\"\nzweite Zeile"}]}}"#;
        assert_eq!(first_text(raw), "Hallo \"Welt\" zweite Zeile");
    }

    #[test]
    fn outline_script_reads_a_session_file() {
        let dir = std::env::temp_dir().join(format!("pibar-outline-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("it's a session.jsonl");
        std::fs::write(
            &f,
            "{\"type\":\"session\",\"id\":\"s1\"}\n\
{\"type\":\"message\",\"id\":\"u1\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"Hallo\"}]}}\n\
{\"type\":\"message\",\"id\":\"a1\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"say \\\"role\\\":\\\"user\\\"\"}]}}\n",
        )
        .unwrap();
        let path = f.to_string_lossy().to_string();
        let out = std::process::Command::new("sh")
            .arg("-c")
            .arg(outline_script(std::slice::from_ref(&path)))
            .output()
            .unwrap();
        let o = parse_outlines(&String::from_utf8_lossy(&out.stdout));
        assert_eq!(o.len(), 1);
        assert_eq!(o[0].path, path);
        assert!(o[0].mtime > 0);
        assert_eq!(o[0].users, vec![UserEntry { id: "u1".into(), text: "Hallo".into() }]);
    }
}
