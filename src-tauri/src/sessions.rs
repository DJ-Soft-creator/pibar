//! Read a host's session list from Pi's session folder (~/.pi/agent/sessions), read whole session files for the
//! export and delete session files. Pi has no list command itself, but the files are plain JSONL.

use crate::config::HostCfg;
use crate::files;
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
    /// Last change of the file (last activity), seconds since the epoch; 0 = unknown
    pub modified: i64,
}

const LIST_SCRIPT: &str = r#"
dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/sessions"
[ -d "$dir" ] || exit 0
ls -t "$dir"/*/*.jsonl 2>/dev/null | head -n 300 | while IFS= read -r f; do
  printf '%s\t%s\t' "$f" "$(date -r "$f" +%s 2>/dev/null)"
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
        let parts: Vec<&str> = line.splitn(5, '\t').collect();
        if parts.len() < 4 {
            continue;
        }
        let modified = parts[1].trim().parse().unwrap_or(0);
        let header: Value = serde_json::from_str(parts[2]).unwrap_or(Value::Null);
        let title = first_text(parts[3]);
        if title.is_empty() {
            continue; // skip empty sessions without a message
        }
        let name = parts
            .get(4)
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
            modified,
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

// ---------- Search in the messages of all sessions ----------

/// A session file with a message that contains the search text, see [`search`]. Title and folder come from the file
/// itself, so a hit also works for a session that is no longer in the list of the newest ones.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub path: String,
    pub cwd: String,
    /// Name from Pi (session_info) or the first own message; empty if the file has neither
    pub title: String,
    /// Role of that message: "user", "assistant" or a tool result
    pub role: String,
    /// Text around the match (JSON escapes removed, leading and trailing "…" where it was cut)
    pub snippet: String,
}

/// Session files one host reports per search: the newest matches are enough to pick one
const SEARCH_MAX_FILES: usize = 40;
/// Characters of a matching line that cross the wire (a tool result can be megabytes)
const SEARCH_LINE_CHARS: usize = 4000;
/// Characters of the message kept around the match
const SNIPPET_CHARS: usize = 160;

/// Shell script: one `grep` over all session files of the host, first matching line per file, plus the header line and
/// the first own message of each hit (path, header, first message, matching line - separated by tabs)
fn search_script(query: &str) -> String {
    format!(
        r#"dir="${{PI_CODING_AGENT_DIR:-$HOME/.pi/agent}}/sessions"
[ -d "$dir" ] || exit 0
grep -i -H -m1 -F -- {} "$dir"/*/*.jsonl 2>/dev/null | head -n {} | while IFS= read -r hit; do
  f="${{hit%%:*}}"
  printf '%s\t%s\t%s\t%s\n' "$f" \
    "$(head -n 1 "$f" | cut -c1-2000 | tr -d '\t')" \
    "$(grep -m1 -F '"role":"user"' "$f" | cut -c1-2000 | tr -d '\t')" \
    "$(printf '%s' "${{hit#*:}}" | cut -c1-{})"
done || true
"#,
        sq(query),
        SEARCH_MAX_FILES,
        SEARCH_LINE_CHARS
    )
}

/// Every string inside a JSON value in reading order (message text, tool arguments …)
fn texts_of(v: &Value, out: &mut Vec<String>) {
    match v {
        Value::String(s) => out.push(s.clone()),
        Value::Array(a) => a.iter().for_each(|x| texts_of(x, out)),
        Value::Object(o) => o.values().for_each(|x| texts_of(x, out)),
        _ => {}
    }
}

/// Text around the (case insensitive) match, whitespace collapsed; None if the text does not contain it
fn window(text: &str, q_lower: &str) -> Option<String> {
    let lower = text.to_lowercase();
    let at = lower.find(q_lower)?;
    let cut = SNIPPET_CHARS / 2;
    let chars: Vec<char> = text.chars().collect();
    // the lowercase copy can have other char counts (İ, ß …): stay near the match, that is enough for a snippet
    let hit = lower[..at].chars().count().min(chars.len().saturating_sub(1));
    let start = hit.saturating_sub(cut);
    let end = (start + SNIPPET_CHARS).min(chars.len());
    let body = chars[start..end].iter().collect::<String>();
    let body = body.split_whitespace().collect::<Vec<_>>().join(" ");
    Some(format!(
        "{}{}{}",
        if start > 0 { "…" } else { "" },
        body.trim_matches(|c: char| matches!(c, '"' | ':' | ',' | '{' | '}' | '[' | ']')),
        if end < chars.len() { "…" } else { "" }
    ))
}

/// JSON escapes of a raw line as readable text (for a line the shell cut short, which no longer parses)
fn unescape_json(raw: &str) -> String {
    let mut out = String::new();
    let mut chars = raw.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('n') | Some('t') | Some('r') => out.push(' '),
            Some('u') => {
                for _ in 0..4 {
                    chars.next();
                }
                out.push(' ');
            }
            Some('"') => out.push('"'),
            Some(other) => out.push(other),
            None => break,
        }
    }
    out
}

/// Role from the raw line, for a line the shell cut short (it no longer parses as JSON)
fn raw_role(raw: &str) -> String {
    let key = "\"role\":\"";
    let Some(start) = raw.find(key) else { return String::new() };
    let rest = &raw[start + key.len()..];
    rest[..rest.find('"').unwrap_or(0)].to_string()
}

/// Role of the matching message and the text around the match. The line is parsed as JSON when it is whole (a tool
/// result can be cut by the shell); then the snippet is clean text instead of the raw JSON around the match.
fn snippet_for(raw: &str, q_lower: &str) -> (String, String) {
    let entry: Value = serde_json::from_str(raw).unwrap_or(Value::Null);
    let role = entry
        .get("message")
        .and_then(|m| m.get("role"))
        .and_then(Value::as_str)
        .map(String::from)
        .unwrap_or_else(|| raw_role(raw));
    let mut found = Vec::new();
    if let Some(message) = entry.get("message") {
        texts_of(message.get("content").unwrap_or(message), &mut found);
    }
    for text in &found {
        if let Some(snippet) = window(text, q_lower) {
            return (role, snippet);
        }
    }
    let raw_text = unescape_json(raw);
    (role, window(&raw_text, q_lower).unwrap_or_default())
}

/// Lines of [`search_script`]: path, header, first message and the matching line, separated by tabs
pub fn parse_hits(out: &str, query: &str) -> Vec<SearchHit> {
    let q_lower = query.to_lowercase();
    let mut hits: Vec<SearchHit> = Vec::new();
    for line in out.lines() {
        let parts: Vec<&str> = line.splitn(4, '\t').collect();
        if parts.len() < 4 {
            continue; // shell chatter before the first hit (a greeting, a prompt)
        }
        let (path, raw) = (parts[0], parts[3]);
        if !is_session_file(path) || hits.iter().any(|h| h.path == path) {
            continue; // the same file twice
        }
        let header: Value = serde_json::from_str(parts[1]).unwrap_or(Value::Null);
        let cwd = header.get("cwd").and_then(Value::as_str).unwrap_or_default().to_string();
        let (role, snippet) = snippet_for(raw, &q_lower);
        // a line cut by the shell can hide the match behind the cut: the session still counts as a hit, shown with
        // the beginning of the message instead of the text around the match
        let snippet = match snippet.is_empty() {
            true => window(&unescape_json(raw), "").unwrap_or_default(),
            false => snippet,
        };
        if snippet.is_empty() {
            continue;
        }
        hits.push(SearchHit { path: path.to_string(), cwd, title: first_text(parts[2]), role, snippet });
    }
    hits
}

/// Sessions of a host whose messages contain `query` (one file per hit, newest first is up to the UI: it knows the
/// session list). Runs one `grep` over all session files, locally or over SSH.
pub fn search(host: &HostCfg, query: &str) -> Result<Vec<SearchHit>, String> {
    let q: String = query.split_whitespace().collect::<Vec<_>>().join(" ");
    let q: String = q.chars().take(200).collect();
    if q.chars().count() < 2 {
        return Ok(vec![]); // one letter matches everything and would ask the host on every keystroke
    }
    hostexec::run_shell(host, &search_script(&q), None).map(|out| parse_hits(&out, &q))
}

/// Tools that change files: the `path` (or `file_path`) of their call is the file Pi wrote
const FILE_TOOLS: &[&str] = &["edit", "write", "multi_edit", "create"];

/// The files Pi changed after one own message: its entry id (stable across branches and compaction) and the paths as
/// Pi named them (absolute, "~/…" or relative to the working folder)
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MessageTouches {
    pub id: String,
    pub paths: Vec<String>,
}

/// Files per own message of a session file, in file order like [`parse_outlines`]: the tool calls of an assistant
/// message belong to the user message before them.
pub fn touched_by_message(text: &str) -> Vec<MessageTouches> {
    let mut result: Vec<MessageTouches> = Vec::new();
    for line in text.lines() {
        let Ok(entry) = serde_json::from_str::<Value>(line) else { continue };
        let Some(message) = entry.get("message") else { continue };
        match message.get("role").and_then(Value::as_str) {
            Some("user") => {
                let id = entry.get("id").and_then(Value::as_str).unwrap_or_default();
                result.push(MessageTouches { id: id.to_string(), paths: Vec::new() });
            }
            Some("assistant") => {
                let parts = message.get("content").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
                for part in parts {
                    let file_tool = part
                        .get("name")
                        .and_then(Value::as_str)
                        .map(|name| FILE_TOOLS.contains(&name))
                        .unwrap_or(false);
                    if part.get("type").and_then(Value::as_str) != Some("toolCall") || !file_tool {
                        continue;
                    }
                    let path = part
                        .get("arguments")
                        .and_then(|a| a.get("path").or_else(|| a.get("file_path")))
                        .and_then(Value::as_str);
                    if let (Some(path), Some(bucket)) = (path, result.last_mut()) {
                        if !bucket.paths.iter().any(|p| p == path) {
                            bucket.paths.push(path.to_string());
                        }
                    }
                }
            }
            _ => {}
        }
    }
    result
}

/// Files Pi changed per own message of the session file `path` (see [`touched_by_message`])
pub fn touches(host: &HostCfg, path: &str) -> Result<Vec<MessageTouches>, String> {
    if !is_session_file(path) {
        return Err(tr(format!("Not a Pi session file: {path}"), format!("Keine Pi-Session-Datei: {path}")));
    }
    let script = format!("grep -F -e '\"role\":\"user\"' -e '\"type\":\"toolCall\"' -- {} || true", sq(path));
    hostexec::run_shell(host, &script, None).map(|out| touched_by_message(&out))
}

/// Only Pi session files may be deleted: "…/sessions/…/<name>.jsonl", absolute, without "..".
pub fn is_session_file(path: &str) -> bool {
    path.starts_with('/')
        && path.ends_with(".jsonl")
        && path.contains("/sessions/")
        && !path.split('/').any(|seg| seg == ".." || seg == ".")
}

/// Whole session file as JSONL text for the export (JSON/CSV in the UI, src/main/sessionExport.ts);
/// only Pi session files, read through [`files::download`] so it works over SSH too (max. 50 MB)
pub fn export(host: &HostCfg, path: &str) -> Result<String, String> {
    if !is_session_file(path) {
        return Err(tr(format!("Not a Pi session file: {path}"), format!("Keine Pi-Session-Datei: {path}")));
    }
    let bytes = files::download(host, path)?;
    String::from_utf8(bytes)
        .map_err(|_| tr("Session file is not valid UTF-8 text", "Session-Datei ist kein gültiger UTF-8-Text"))
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
    fn export_only_reads_session_files() {
        let host = HostCfg {
            id: "local".into(),
            name: String::new(),
            kind: "local".into(),
            ssh_target: String::new(),
            ssh_user: String::new(),
            ssh_port: None,
            pi_command: String::new(),
            default_dir: String::new(),
            use_herdr: false,
            color_profile: String::new(),
        };
        // the guard refuses before any shell runs
        assert!(export(&host, "/home/u/notes.jsonl").is_err());
        assert!(export(&host, "/home/u/.pi/agent/sessions/../../.bashrc").is_err());
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
    fn files_per_own_message() {
        let out = "\
{\"type\":\"message\",\"id\":\"u1\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"Mach was\"}]}}\n\
{\"type\":\"message\",\"id\":\"a1\",\"message\":{\"role\":\"assistant\",\"content\":[\
{\"type\":\"toolCall\",\"id\":\"c1\",\"name\":\"edit\",\"arguments\":{\"path\":\"/work/a.ts\"}},\
\
{\"type\":\"toolCall\",\"id\":\"c2\",\"name\":\"write\",\"arguments\":{\"file_path\":\"b.ts\"}},\
\
{\"type\":\"toolCall\",\"id\":\"c3\",\"name\":\"bash\",\"arguments\":{\"command\":\"rm x\"}},\
\
{\"type\":\"toolCall\",\"id\":\"c4\",\"name\":\"edit\",\"arguments\":{\"path\":\"/work/a.ts\"}}]}}\n\
{\"type\":\"message\",\"id\":\"u2\",\"message\":{\"role\":\"user\",\"content\":\"weiter\"}}\n\
{\"type\":\"message\",\"id\":\"t1\",\"message\":{\"role\":\"toolResult\",\"content\":[{\"type\":\"text\",\"text\":\"sag \\\"type\\\":\\\"toolCall\\\"\"}]}}\n";
        let per = touched_by_message(out);
        assert_eq!(per.len(), 2);
        assert_eq!(per[0].id, "u1");
        assert_eq!(per[0].paths, vec!["/work/a.ts", "b.ts"]);
        assert_eq!(per[1].id, "u2");
        assert!(per[1].paths.is_empty());
    }

    #[test]
    fn extracts_text() {
        let raw = r#"{"type":"message","message":{"role":"user","content":[{"type":"text","text":"Hallo \"Welt\"\nzweite Zeile"}]}}"#;
        assert_eq!(first_text(raw), "Hallo \"Welt\" zweite Zeile");
    }

    #[test]
    fn finds_the_text_around_the_match() {
        let raw = "{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"Bitte die Suche über alle Sessions bauen\"}]}}";
        let (role, snippet) = snippet_for(raw, "suche");
        assert_eq!(role, "user");
        assert_eq!(snippet, "Bitte die Suche über alle Sessions bauen");
        // tool call arguments are searched too
        let tool = "{\"type\":\"message\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"toolCall\",\"name\":\"bash\",\"arguments\":{\"command\":\"grep -r TODO src\"}}]}}";
        let (role, snippet) = snippet_for(tool, "todo");
        assert_eq!((role.as_str(), snippet.as_str()), ("assistant", "grep -r TODO src"));
    }

    #[test]
    fn a_cut_off_line_still_gives_a_snippet() {
        // the shell cuts long lines: the JSON no longer parses, the raw text around the match is shown instead
        let raw = "{\"type\":\"message\",\"message\":{\"role\":\"toolResult\",\"content\":[{\"type\":\"text\",\"text\":\"zwei Zeilen\\nmit dem Treffer\";";
        let (role, snippet) = snippet_for(raw, "treffer");
        assert_eq!(role, "toolResult");
        assert!(snippet.contains("mit dem Treffer"), "{snippet}");
        assert!(!snippet.contains("\\n"), "{snippet}");
    }

    #[test]
    fn long_texts_are_shortened() {
        let text = format!("{} Treffer {}", "a ".repeat(200), "b ".repeat(200));
        let win = window(&text, "treffer").unwrap();
        assert!(win.len() < SNIPPET_CHARS + 40, "{}", win.len());
        assert!(win.starts_with('…') && win.ends_with('…'));
        assert!(window(&text, "nichts").is_none());
    }

    #[test]
    fn parses_one_hit_per_file() {
        let line = "{\"type\":\"message\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"die Suche\"}]}}";
        let header = "{\"type\":\"session\",\"id\":\"s1\",\"cwd\":\"/work/pibar\"}";
        let first = "{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"Bau eine Suche\"}]}}";
        let hit = |path: &str| format!("{path}\t{header}\t{first}\t{line}");
        let out = format!(
            "willkommen im login-shell\n{}\n{}\n{}\n",
            hit("/s/u/.pi/agent/sessions/a/1.jsonl"),
            hit("/s/u/.pi/agent/sessions/a/2.jsonl"),
            hit("/s/u/.pi/agent/sessions/a/1.jsonl")
        );
        let hits = parse_hits(&out, "suche");
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].path, "/s/u/.pi/agent/sessions/a/1.jsonl");
        assert_eq!(hits[0].cwd, "/work/pibar");
        assert_eq!(hits[0].title, "Bau eine Suche");
        assert_eq!(hits[0].snippet, "die Suche");
        assert!(parse_hits("/etc/passwd\t\t\troot", "root").is_empty());
    }

    #[test]
    fn a_match_behind_a_cut_is_still_a_hit() {
        let raw = "{\"type\":\"message\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"Anfang ohne den Treffer\";";
        let out = format!("/s/u/.pi/agent/sessions/a/1.jsonl\t\t\t{raw}\n");
        let hits = parse_hits(&out, "treffer");
        assert_eq!(hits.len(), 1);
        assert!(hits[0].snippet.contains("Anfang ohne"), "{}", hits[0].snippet);
    }

    #[test]
    fn search_script_reads_the_files() {
        let dir = std::env::temp_dir().join(format!("pibar-search-{}", std::process::id()));
        let sessions = dir.join("sessions").join("--work--");
        std::fs::create_dir_all(&sessions).unwrap();
        std::fs::write(
            sessions.join("a.jsonl"),
            "{\"type\":\"session\",\"id\":\"s1\",\"cwd\":\"/work/pibar\"}\n\
{\"type\":\"message\",\"id\":\"u1\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"Bau eine Suche\"}]}}\n\
{\"type\":\"message\",\"id\":\"a1\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"Die Suche steht\"}]}}\n",
        )
        .unwrap();
        std::fs::write(sessions.join("b.jsonl"), "{\"type\":\"session\",\"id\":\"s2\"}\n").unwrap();
        let out = std::process::Command::new("sh")
            .arg("-c")
            .arg(search_script("Suche"))
            .env("PI_CODING_AGENT_DIR", &dir)
            .output()
            .unwrap();
        let hits = parse_hits(&String::from_utf8_lossy(&out.stdout), "Suche");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].cwd, "/work/pibar");
        assert_eq!(hits[0].title, "Bau eine Suche");
        // the first matching line is the own message here, not the answer
        assert_eq!((hits[0].role.as_str(), hits[0].snippet.as_str()), ("user", "Bau eine Suche"));
    }

    #[test]
    fn search_script_quotes_the_query() {
        let script = search_script("it's $(rm -rf ~)");
        assert!(script.contains("'it'\\''s $(rm -rf ~)'"));
        assert!(script.contains("grep -i -H -m1 -F --"));
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
