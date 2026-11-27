//! Requests to the PiBar webapp (sign-in, sign-out, sync of the session organisation): sent from the Rust core
//! through `curl`, so the WebView's CSP stays closed to foreign addresses and no HTTP crate is needed. Only the
//! webapp's desktop endpoints can be called; the API token goes to curl through stdin, never on the command line.

use crate::i18n::tr;
use serde::Serialize;
use std::io::Write;
use std::process::Stdio;

/// The webapp endpoints the desktop may call (webapp/src/server/routes/tokens.ts)
pub const PATHS: &[&str] = &["/api/desktop/login", "/api/desktop/logout", "/api/sync/meta"];

/// Status and body of the webapp's answer (the UI reads the JSON)
#[derive(Serialize, Debug, PartialEq)]
pub struct Answer {
    pub status: u16,
    pub body: String,
}

/// Value for curl's config syntax: double quotes with escapes
fn quote(s: &str) -> String {
    format!(
        "\"{}\"",
        s.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', "\\n").replace('\r', "\\r").replace('\t', "\\t")
    )
}

/// "<base>/<path>" for an allowed path; the base must be an http(s) address without credentials
pub fn url(base: &str, path: &str) -> Result<String, String> {
    if !PATHS.contains(&path) {
        return Err(tr(
            format!("Not a webapp sync address: {path}"),
            format!("Keine Abgleich-Adresse der Webapp: {path}"),
        ));
    }
    let base = base.trim().trim_end_matches('/');
    let rest = base.strip_prefix("https://").or_else(|| base.strip_prefix("http://"));
    let host = rest.map(|r| r.split('/').next().unwrap_or_default()).unwrap_or_default();
    if host.is_empty() || host.contains('@') || base.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(tr(
            "The webapp address must start with http:// or https://",
            "Die Webapp-Adresse muss mit http:// oder https:// beginnen",
        ));
    }
    Ok(format!("{base}{path}"))
}

/// curl config (read from stdin): method, address, token, JSON body and the status code after the body
pub fn config(url: &str, token: &str, body: Option<&str>) -> String {
    let mut cfg = format!("url = {}\nwrite-out = \"\\n%{{http_code}}\"\n", quote(url));
    cfg.push_str("header = \"Accept: application/json\"\n");
    if !token.trim().is_empty() {
        cfg.push_str(&format!("header = {}\n", quote(&format!("Authorization: Bearer {}", token.trim()))));
    }
    match body {
        Some(b) => {
            cfg.push_str("header = \"Content-Type: application/json\"\n");
            cfg.push_str(&format!("data-binary = {}\n", quote(b)));
        }
        None => cfg.push_str("request = \"POST\"\n"),
    }
    cfg
}

/// Split curl's output into body and status code (written last by `write-out`)
pub fn parse(out: &[u8]) -> Option<Answer> {
    let text = String::from_utf8_lossy(out);
    let (body, code) = text.rsplit_once('\n')?;
    let status = code.trim().parse::<u16>().ok().filter(|s| *s > 0)?;
    Some(Answer { status, body: body.to_string() })
}

/// POST to the webapp (blocking; call it off the main thread). Network errors are errors, HTTP errors are answers.
pub fn post(base: &str, path: &str, token: &str, body: Option<&str>) -> Result<Answer, String> {
    let url = url(base, path)?;
    // "@…" would make curl read a file; a JSON body never starts like that
    if body.is_some_and(|b| b.starts_with('@')) {
        return Err(tr("Invalid request body", "Ungültiger Inhalt der Anfrage"));
    }
    let mut cmd = crate::disclaim::command("curl");
    cmd.args(["-sS", "--proto", "=http,https", "--connect-timeout", "10", "--max-time", "60", "--config", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            tr("Program 'curl' not found", "Programm 'curl' nicht gefunden")
        } else {
            e.to_string()
        }
    })?;
    if let Some(mut si) = child.stdin.take() {
        si.write_all(config(&url, token, body).as_bytes()).map_err(|e| e.to_string())?;
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if out.status.success() {
        if let Some(answer) = parse(&out.stdout) {
            return Ok(answer);
        }
    }
    let err = String::from_utf8_lossy(&out.stderr).trim().chars().take(400).collect::<String>();
    Err(tr(format!("Webapp not reachable: {err}"), format!("Webapp nicht erreichbar: {err}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_urls_for_allowed_paths_only() {
        assert_eq!(url(" http://10.0.0.2:8787/ ", "/api/sync/meta").unwrap(), "http://10.0.0.2:8787/api/sync/meta");
        assert_eq!(
            url("https://pi.example/app", "/api/desktop/login").unwrap(),
            "https://pi.example/app/api/desktop/login"
        );
        assert!(url("http://10.0.0.2", "/api/cmd/run").is_err());
        assert!(url("file:///etc", "/api/sync/meta").is_err());
        assert!(url("10.0.0.2:8787", "/api/sync/meta").is_err());
        assert!(url("http://user:pw@host", "/api/sync/meta").is_err());
        assert!(url("http://", "/api/sync/meta").is_err());
        assert!(url("http://a b", "/api/sync/meta").is_err());
    }

    #[test]
    fn config_quotes_values_and_hides_nothing_on_the_command_line() {
        let cfg = config("http://h/api/sync/meta", " pbt_x\"y ", Some("{\"a\":\"b\\\\n\"}"));
        assert!(cfg.contains("url = \"http://h/api/sync/meta\"\n"));
        assert!(cfg.contains("header = \"Authorization: Bearer pbt_x\\\"y\"\n"));
        assert!(cfg.contains("data-binary = \"{\\\"a\\\":\\\"b\\\\\\\\n\\\"}\"\n"));
        assert!(cfg.contains("write-out = \"\\n%{http_code}\"\n"));
        let empty = config("http://h/api/desktop/logout", "", None);
        assert!(!empty.contains("Authorization"));
        assert!(empty.contains("request = \"POST\""));
        assert_eq!(quote("a\nb"), "\"a\\nb\"");
    }

    #[test]
    fn parses_body_and_status() {
        assert_eq!(parse(b"{\"ok\":1}\n200"), Some(Answer { status: 200, body: "{\"ok\":1}".into() }));
        assert_eq!(parse(b"line1\nline2\n401"), Some(Answer { status: 401, body: "line1\nline2".into() }));
        assert_eq!(parse(b"\n000"), None);
        assert_eq!(parse(b"no status"), None);
    }

    #[test]
    fn refuses_file_bodies() {
        assert!(post("http://127.0.0.1:9", "/api/sync/meta", "", Some("@/etc/passwd")).is_err());
    }
}
