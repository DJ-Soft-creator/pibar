//! Voice and text helpers: speech to text (dictation), text to speech and improving a text with a second LLM.
//! Talks to OpenAI-compatible APIs (OpenAI, Groq, local servers such as speaches, Ollama or LM Studio) through
//! `curl`, so no HTTP crate is needed; dictation can also run a local program (e.g. whisper.cpp).
//! The API key goes to curl through stdin, never on the command line.

use crate::config::{HostCfg, ImproveCfg, SttCfg, TtsCfg};
use crate::hostexec::{self, sq};
use crate::i18n::tr;
use base64::Engine;
use serde::Serialize;
use serde_json::{json, Value};
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};

const OPENAI: &str = "https://api.openai.com/v1";

/// Audio for the UI (base64)
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Audio {
    pub data: String,
    pub mime_type: String,
}

/// "<base>/<path>", default base OpenAI
pub fn api_url(base: &str, path: &str) -> String {
    let base = base.trim().trim_end_matches('/');
    format!("{}/{}", if base.is_empty() { OPENAI } else { base }, path)
}

/// File extension the APIs recognise for a recording's MIME type
pub fn ext_for_mime(mime: &str) -> &'static str {
    let m = mime.split(';').next().unwrap_or("").trim();
    match m {
        "audio/webm" | "video/webm" => "webm",
        "audio/ogg" => "ogg",
        "audio/wav" | "audio/x-wav" | "audio/wave" => "wav",
        "audio/mpeg" | "audio/mp3" => "mp3",
        _ => "m4a", // audio/mp4 (WebKit) and unknown
    }
}

/// Remove <think>…</think> blocks that local reasoning models put in front of the answer
pub fn strip_think(s: &str) -> String {
    let mut out = s.to_string();
    while let (Some(a), Some(b)) = (out.find("<think>"), out.find("</think>")) {
        if b < a {
            break;
        }
        out.replace_range(a..b + "</think>".len(), "");
    }
    out.trim().to_string()
}

fn tmp_file(ext: &str) -> Result<PathBuf, String> {
    static N: AtomicU32 = AtomicU32::new(0);
    let dir = std::env::temp_dir().join("pibar-voice");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let n = N.fetch_add(1, Ordering::Relaxed);
    Ok(dir.join(format!("{}-{n}.{ext}", std::process::id())))
}

/// Value for curl's config syntax: double quotes with escapes
fn curl_quote(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

/// POST with curl; returns the response body. HTTP errors return the body as the error text.
fn curl(url: &str, key: &str, args: &[String]) -> Result<Vec<u8>, String> {
    let mut cmd = Command::new("curl");
    cmd.args(["-sS", "--fail-with-body", "--max-time", "180", "--config", "-"])
        .args(args)
        .arg(url)
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
        let cfg = if key.trim().is_empty() {
            String::new()
        } else {
            format!("header = {}\n", curl_quote(&format!("Authorization: Bearer {}", key.trim())))
        };
        si.write_all(cfg.as_bytes()).map_err(|e| e.to_string())?;
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if out.status.success() {
        return Ok(out.stdout);
    }
    let body = String::from_utf8_lossy(&out.stdout);
    let msg = serde_json::from_str::<Value>(&body)
        .ok()
        .and_then(|v| v["error"]["message"].as_str().map(String::from))
        .unwrap_or_else(|| format!("{} {}", String::from_utf8_lossy(&out.stderr).trim(), body.trim()));
    Err(msg.trim().chars().take(600).collect())
}

/// POST a JSON body (written to a temp file, so large texts work)
fn post_json(url: &str, key: &str, body: &Value) -> Result<Vec<u8>, String> {
    let path = tmp_file("json")?;
    std::fs::write(&path, body.to_string()).map_err(|e| e.to_string())?;
    let res = curl(
        url,
        key,
        &["-H".into(), "Content-Type: application/json".into(), "--data-binary".into(), format!("@{}", path.display())],
    );
    let _ = std::fs::remove_file(&path);
    res
}

fn parse_json(bytes: &[u8]) -> Result<Value, String> {
    serde_json::from_slice(bytes)
        .map_err(|e| tr(format!("Unexpected answer: {e}"), format!("Unerwartete Antwort: {e}")))
}

/// Text of a transcription answer ({"text": …}) or plain text
pub fn parse_transcript(bytes: &[u8]) -> String {
    match serde_json::from_slice::<Value>(bytes) {
        Ok(v) => v["text"].as_str().unwrap_or_default().trim().to_string(),
        Err(_) => String::from_utf8_lossy(bytes).trim().to_string(),
    }
}

/// Recording (base64) → text
pub fn transcribe(cfg: &SttCfg, data_b64: &str, mime: &str) -> Result<String, String> {
    let bytes = base64::engine::general_purpose::STANDARD.decode(data_b64).map_err(|e| e.to_string())?;
    let path = tmp_file(ext_for_mime(mime))?;
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    let file = path.display().to_string();
    let res = match cfg.provider.as_str() {
        "command" => {
            if cfg.command.trim().is_empty() {
                Err(tr("No dictation command set", "Kein Diktier-Befehl eingestellt"))
            } else {
                let local = HostCfg {
                    id: "local".into(),
                    name: String::new(),
                    kind: "local".into(),
                    ssh_target: String::new(),
                    ssh_user: String::new(),
                    ssh_port: None,
                    pi_command: String::new(),
                    default_dir: String::new(),
                    use_herdr: false,
                };
                let script = cfg.command.replace("{file}", &sq(&file));
                hostexec::run_shell(&local, &script, None).map(|s| s.trim().to_string())
            }
        }
        "api" => {
            let mut args = vec![
                "-F".to_string(),
                format!("file=@{file};type={}", mime.split(';').next().unwrap_or("audio/mp4")),
                "-F".into(),
                format!("model={}", if cfg.model.trim().is_empty() { "whisper-1" } else { cfg.model.trim() }),
                "-F".into(),
                "response_format=json".into(),
            ];
            if !cfg.language.trim().is_empty() {
                args.extend(["-F".into(), format!("language={}", cfg.language.trim())]);
            }
            curl(&api_url(&cfg.base_url, "audio/transcriptions"), &cfg.api_key, &args).map(|b| parse_transcript(&b))
        }
        _ => Err(tr("Dictation is off (Settings → Voice)", "Diktieren ist aus (Einstellungen → Sprache)")),
    };
    let _ = std::fs::remove_file(&path);
    res
}

/// Answer text of a chat completion
pub fn parse_chat(v: &Value) -> Option<String> {
    v["choices"][0]["message"]["content"].as_str().map(strip_think)
}

/// Improve a text with the second LLM and its prompt
pub fn improve(cfg: &ImproveCfg, prompt: &str, text: &str) -> Result<String, String> {
    let body = json!({
        "model": cfg.model.trim(),
        "messages": [
            { "role": "system", "content": prompt },
            { "role": "user", "content": text },
        ],
    });
    let v = parse_json(&post_json(&api_url(&cfg.base_url, "chat/completions"), &cfg.api_key, &body)?)?;
    parse_chat(&v).filter(|s| !s.is_empty()).ok_or_else(|| tr("Empty answer", "Leere Antwort"))
}

/// Text → speech (mp3)
pub fn speak(cfg: &TtsCfg, text: &str) -> Result<Audio, String> {
    let body = json!({
        "model": if cfg.model.trim().is_empty() { "gpt-4o-mini-tts" } else { cfg.model.trim() },
        "voice": if cfg.voice.trim().is_empty() { "alloy" } else { cfg.voice.trim() },
        "input": text,
        "response_format": "mp3",
    });
    let bytes = post_json(&api_url(&cfg.base_url, "audio/speech"), &cfg.api_key, &body)?;
    Ok(Audio { data: base64::engine::general_purpose::STANDARD.encode(bytes), mime_type: "audio/mpeg".into() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_urls() {
        assert_eq!(api_url("", "audio/speech"), "https://api.openai.com/v1/audio/speech");
        assert_eq!(api_url("http://mini:8000/v1/", "chat/completions"), "http://mini:8000/v1/chat/completions");
    }

    #[test]
    fn maps_mime_to_extension() {
        assert_eq!(ext_for_mime("audio/webm;codecs=opus"), "webm");
        assert_eq!(ext_for_mime("audio/mp4"), "m4a");
        assert_eq!(ext_for_mime("audio/wav"), "wav");
    }

    #[test]
    fn strips_thinking_blocks() {
        assert_eq!(strip_think("<think>hmm</think>\n\nHello"), "Hello");
        assert_eq!(strip_think("Hello"), "Hello");
    }

    #[test]
    fn parses_answers() {
        assert_eq!(parse_transcript(br#"{"text":" Hallo Welt "}"#), "Hallo Welt");
        assert_eq!(parse_transcript(b"plain text\n"), "plain text");
        let v: Value = serde_json::from_str(r#"{"choices":[{"message":{"content":"Better."}}]}"#).unwrap();
        assert_eq!(parse_chat(&v).as_deref(), Some("Better."));
    }

    #[test]
    fn quotes_curl_config() {
        assert_eq!(curl_quote(r#"a"b\c"#), r#""a\"b\\c""#);
    }
}
