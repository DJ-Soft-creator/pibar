//! Read a host's session list from Pi's session folder (~/.pi/agent/sessions).
//! Pi has no list command itself, but the files are plain JSONL.

use crate::config::HostCfg;
use crate::hostexec;
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
        });
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::first_text;

    #[test]
    fn extracts_text() {
        let raw = r#"{"type":"message","message":{"role":"user","content":[{"type":"text","text":"Hallo \"Welt\"\nzweite Zeile"}]}}"#;
        assert_eq!(first_text(raw), "Hallo \"Welt\" zweite Zeile");
    }
}
