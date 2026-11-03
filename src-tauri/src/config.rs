//! App settings: hosts, extra folders per session, reminders, UI options.
//! Stored as JSON in the app's config folder. New fields always get `#[serde(default)]`
//! so older config files keep loading.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

use crate::i18n::tr;

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HostCfg {
    pub id: String,
    pub name: String,
    /// "local" or "ssh"
    pub kind: String,
    /// SSH target: alias from ~/.ssh/config or host name
    #[serde(default)]
    pub ssh_target: String,
    #[serde(default)]
    pub ssh_user: String,
    #[serde(default)]
    pub ssh_port: Option<u16>,
    /// Command that starts Pi (default: "pi")
    #[serde(default)]
    pub pi_command: String,
    /// Preselected folder for new sessions
    #[serde(default)]
    pub default_dir: String,
    /// Reserved: start Pi through herdr
    #[serde(default)]
    pub use_herdr: bool,
    /// Colour profile of the chat on this host (id from AppConfig.colorProfiles); empty = the default profile
    #[serde(default)]
    pub color_profile: String,
}

/// A reminder on a saved session (managed by the UI, src/main/reminders.ts)
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Reminder {
    /// Session key "<hostId>|<sessionPath>"
    pub key: String,
    pub host_id: String,
    pub path: String,
    #[serde(default)]
    pub cwd: String,
    #[serde(default)]
    pub title: String,
    /// Due time in milliseconds since the epoch
    pub at: i64,
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub fired: bool,
}

/// Saved combination of model and thinking level for quick selection (managed by the UI,
/// src/main/settings.ts). Empty fields keep the session's current value.
#[derive(Clone, Serialize, Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ModelPreset {
    pub id: String,
    pub name: String,
    /// "<provider>/<model id>"
    #[serde(default)]
    pub model: String,
    /// Pi thinking level, e.g. "high"
    #[serde(default)]
    pub thinking: String,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UiPrefs {
    #[serde(default = "yes")]
    pub show_tools: bool,
    #[serde(default = "yes")]
    pub show_thinking: bool,
    /// UI language: "auto", "de" or "en"
    #[serde(default = "auto")]
    pub language: String,
    /// Selected host at the top left: "all" or a host id
    #[serde(default = "all")]
    pub selected_host: String,
    /// Hosts collapsed in the "All" view
    #[serde(default)]
    pub collapsed_hosts: Vec<String>,
    /// Collapsed date or folder sections of the session list: "<hostId>|<date|folder>|<section>"
    #[serde(default)]
    pub collapsed_sections: Vec<String>,
    #[serde(default)]
    pub left_collapsed: bool,
    #[serde(default)]
    pub right_collapsed: bool,
    /// Shortcut for the quick launcher, e.g. "Alt+Shift+Space"
    #[serde(default = "default_hotkey")]
    pub quick_hotkey: String,
    /// Double-tap key: off, option, rightOption, command, rightCommand, control, shift
    #[serde(default = "default_double_tap")]
    pub double_tap: String,
    /// Remembered position of the quick bar (physical pixels), None = default spot
    #[serde(default)]
    pub quick_pos: Option<[i32; 2]>,
    /// Colour scheme: "auto" (follow the system), "light" or "dark"
    #[serde(default = "auto")]
    pub theme: String,
    /// Chat view: "natural" (text only), "technical" (collapsed thinking/tool cards) or "debug" (cards open live)
    #[serde(default = "default_chat_mode")]
    pub chat_mode: String,
    /// Answer style hint sent with each message: "short", "normal" or "technical"
    #[serde(default = "default_answer_mode")]
    pub answer_mode: String,
    /// Width of the left and right panel in pixels, None = default
    #[serde(default)]
    pub left_width: Option<u32>,
    #[serde(default)]
    pub right_width: Option<u32>,
    /// Height of the file tree above the editor, in percent of the right panel; None = default
    #[serde(default)]
    pub files_split: Option<f64>,
    /// Height of the terminal below the chat in pixels; None = default
    #[serde(default)]
    pub term_height: Option<u32>,
    /// Show the Git status (branch, unpushed commits, changed files) in the file tree
    #[serde(default)]
    pub show_git: bool,
    /// Show the time of each chat message
    #[serde(default)]
    pub show_times: bool,
    /// System notification when a session finishes while PiBar is in the background
    #[serde(default = "yes")]
    pub notify_done: bool,
    /// Default for new sessions: a preset id, or a model "<provider>/<id>" with a thinking level; empty = Pi's default
    #[serde(default)]
    pub default_preset: String,
    #[serde(default)]
    pub default_model: String,
    #[serde(default)]
    pub default_thinking: String,
    /// Auto scroll of the chat: "auto" (pauses when scrolling up), "always" (forced) or "off"
    #[serde(default = "default_auto_scroll")]
    pub auto_scroll: String,
    /// File tree: only Markdown, HTML and images instead of all files
    #[serde(default)]
    pub files_docs_only: bool,
    /// Send messages as detached runs on the host by default ("in the background")
    #[serde(default)]
    pub background: bool,
    /// Order of the session list: "activity" (last change), "created", "name" or "folder"
    #[serde(default = "default_session_sort")]
    pub session_sort: String,
    /// Sections of the session list: "none", "date" or "folder"
    #[serde(default = "default_session_group")]
    pub session_group: String,
    /// Last session shown per host (host id → session file), so switching hosts brings it back
    #[serde(default)]
    pub session_by_host: HashMap<String, String>,
    /// Colour profile for hosts without their own (id from AppConfig.colorProfiles); empty = theme colours
    #[serde(default)]
    pub color_profile: String,
}

pub fn default_auto_scroll() -> String {
    "auto".into()
}

pub fn default_session_sort() -> String {
    "activity".into()
}

pub fn default_session_group() -> String {
    "date".into()
}

pub fn default_chat_mode() -> String {
    "technical".into()
}

pub fn default_answer_mode() -> String {
    "normal".into()
}

pub fn default_double_tap() -> String {
    "option".into()
}

pub fn default_hotkey() -> String {
    "Alt+Shift+Space".into()
}

fn all() -> String {
    "all".into()
}

fn auto() -> String {
    "auto".into()
}

fn yes() -> bool {
    true
}

impl Default for UiPrefs {
    fn default() -> Self {
        UiPrefs {
            show_tools: true,
            show_thinking: true,
            language: auto(),
            selected_host: all(),
            collapsed_hosts: vec![],
            collapsed_sections: vec![],
            left_collapsed: false,
            right_collapsed: false,
            quick_hotkey: default_hotkey(),
            double_tap: default_double_tap(),
            quick_pos: None,
            theme: auto(),
            chat_mode: default_chat_mode(),
            answer_mode: default_answer_mode(),
            left_width: None,
            right_width: None,
            files_split: None,
            term_height: None,
            show_git: false,
            show_times: false,
            notify_done: true,
            default_preset: String::new(),
            default_model: String::new(),
            default_thinking: String::new(),
            auto_scroll: default_auto_scroll(),
            files_docs_only: false,
            background: false,
            session_sort: default_session_sort(),
            session_group: default_session_group(),
            session_by_host: HashMap::new(),
            color_profile: String::new(),
        }
    }
}

/// Name, pin, colour and group of a session (managed by the UI, src/main/sessionGroups.ts)
#[derive(Clone, Serialize, Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct SessionMeta {
    /// Own name; empty = Pi's name or first message
    pub name: String,
    pub pinned: bool,
    /// Colour name such as "blue", empty = none
    pub color: String,
    /// Id of a SessionGroup, empty = none
    pub group: String,
    /// Pi tools for this session (allowlist); None = Pi's default, empty = no tools
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<String>>,
    /// "on": every message of this session runs in the background, "off": never, empty: as in the settings
    pub background: String,
    /// Start time of the newest run in the background (ms since epoch), 0 = none
    pub background_at: u64,
}

/// User-defined group of sessions with a colour
#[derive(Clone, Serialize, Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct SessionGroup {
    pub id: String,
    pub name: String,
    pub color: String,
    pub collapsed: bool,
}

/// Speech to text (dictation). Used by src-tauri/src/voice.rs.
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct SttCfg {
    /// "off", "api" (OpenAI-compatible /audio/transcriptions) or "command" (local program)
    pub provider: String,
    /// API base URL, e.g. "https://api.openai.com/v1"; empty = OpenAI
    pub base_url: String,
    pub api_key: String,
    /// e.g. "whisper-1", "gpt-4o-transcribe", "whisper-large-v3"
    pub model: String,
    /// Language hint such as "de"; empty = detect
    pub language: String,
    /// Local command; {file} is replaced by the recording, stdout is the text
    pub command: String,
}

impl Default for SttCfg {
    fn default() -> Self {
        SttCfg {
            provider: "off".into(),
            base_url: String::new(),
            api_key: String::new(),
            model: "whisper-1".into(),
            language: String::new(),
            command: String::new(),
        }
    }
}

/// Text to speech (read answers aloud)
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct TtsCfg {
    /// "system" (voice of the operating system) or "api" (OpenAI-compatible /audio/speech)
    pub provider: String,
    pub base_url: String,
    pub api_key: String,
    /// e.g. "gpt-4o-mini-tts", "tts-1"
    pub model: String,
    /// e.g. "alloy"; for "system" the name of a system voice (empty = default)
    pub voice: String,
    /// Read answers aloud automatically: "off", "quick" (answers to quick bar messages) or "all"
    pub auto_read: String,
}

impl Default for TtsCfg {
    fn default() -> Self {
        TtsCfg {
            provider: "system".into(),
            base_url: String::new(),
            api_key: String::new(),
            model: "gpt-4o-mini-tts".into(),
            voice: String::new(),
            auto_read: "off".into(),
        }
    }
}

/// Second pass over a text by another LLM (OpenAI-compatible /chat/completions) with its own prompt
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct ImproveCfg {
    pub enabled: bool,
    /// Improve dictated text automatically before it lands in the input
    pub after_dictation: bool,
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    /// System prompt; empty = built-in default (see src/shared/voice.ts)
    pub prompt: String,
}

impl Default for ImproveCfg {
    fn default() -> Self {
        ImproveCfg {
            enabled: false,
            after_dictation: false,
            base_url: String::new(),
            api_key: String::new(),
            model: "gpt-4o-mini".into(),
            prompt: String::new(),
        }
    }
}

#[derive(Clone, Serialize, Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct VoiceCfg {
    pub stt: SttCfg,
    pub tts: TtsCfg,
    pub improve: ImproveCfg,
}

/// Background and text colour of one part of the chat (empty = theme default)
#[derive(Clone, Serialize, Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct RoleColor {
    pub background: String,
    pub text: String,
}

/// The four parts of the chat that can be coloured
#[derive(Clone, Serialize, Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ChatColors {
    pub thinking: RoleColor,
    pub tools: RoleColor,
    pub answer: RoleColor,
    /// Own messages
    pub own: RoleColor,
}

/// Colour profile of the chat: one set for the dark and one for the light theme, chosen per host
#[derive(Clone, Serialize, Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ColorProfile {
    pub id: String,
    pub name: String,
    pub dark: ChatColors,
    pub light: ChatColors,
}

/// Settings of the app
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    pub hosts: Vec<HostCfg>,
    /// Extra folders per session. Key: "<hostId>|<sessionPath>"
    #[serde(default)]
    pub session_folders: HashMap<String, Vec<String>>,
    #[serde(default)]
    pub reminders: Vec<Reminder>,
    /// Presets for model and thinking level
    #[serde(default)]
    pub presets: Vec<ModelPreset>,
    #[serde(default)]
    pub ui: UiPrefs,
    /// Dictation, read aloud and text improvement
    #[serde(default)]
    pub voice: VoiceCfg,
    /// Name, pin, colour and group per session. Key: "<hostId>|<sessionPath>"
    #[serde(default)]
    pub session_meta: HashMap<String, SessionMeta>,
    #[serde(default)]
    pub groups: Vec<SessionGroup>,
    /// Colour profiles for the chat (thinking, tool calls, answers, own messages)
    #[serde(default)]
    pub color_profiles: Vec<ColorProfile>,
}

impl Default for AppConfig {
    fn default() -> Self {
        AppConfig {
            hosts: vec![HostCfg {
                id: "local".into(),
                name: tr("Local", "Lokal"),
                kind: "local".into(),
                ssh_target: String::new(),
                ssh_user: String::new(),
                ssh_port: None,
                pi_command: "pi".into(),
                default_dir: "~".into(),
                use_herdr: false,
                color_profile: String::new(),
            }],
            session_folders: HashMap::new(),
            reminders: vec![],
            presets: vec![],
            ui: UiPrefs::default(),
            voice: VoiceCfg::default(),
            session_meta: HashMap::new(),
            groups: vec![],
            color_profiles: vec![],
        }
    }
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("config.json"))
}

/// Settings in memory (read from disk once), so commands do not parse the file again on every call
static CACHE: Mutex<Option<AppConfig>> = Mutex::new(None);
/// Why the settings file could not be read at start (shown once by the UI), None = all fine
static LOAD_ERROR: Mutex<Option<String>> = Mutex::new(None);

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Read the settings file. A missing file gives the defaults. A broken file is first copied to
/// `config.json.broken-<unix seconds>`, so the next save cannot destroy the user's hosts and sessions;
/// the second value then says what happened.
pub fn read_from(path: &Path) -> (AppConfig, Option<String>) {
    let text = match std::fs::read_to_string(path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return (AppConfig::default(), None),
        Err(e) => {
            let msg = tr(format!("Settings could not be read: {e}"), format!("Einstellungen nicht lesbar: {e}"));
            return (AppConfig::default(), Some(msg));
        }
    };
    match serde_json::from_str(&text) {
        Ok(cfg) => (cfg, None),
        Err(e) => {
            let ts = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
            let backup = path.with_extension(format!("json.broken-{ts}"));
            let msg = match std::fs::copy(path, &backup) {
                Ok(_) => tr(
                    format!("Settings were damaged ({e}) and have been reset. Backup: {}", backup.display()),
                    format!(
                        "Einstellungen waren beschädigt ({e}) und wurden zurückgesetzt. Sicherung: {}",
                        backup.display()
                    ),
                ),
                Err(ce) => tr(
                    format!("Settings were damaged ({e}) and have been reset. Backup failed: {ce}"),
                    format!(
                        "Einstellungen waren beschädigt ({e}) und wurden zurückgesetzt. Sicherung fehlgeschlagen: {ce}"
                    ),
                ),
            };
            (AppConfig::default(), Some(msg))
        }
    }
}

/// Write a file so that it is either complete or untouched: temp file next to it, flush to disk, rename
pub fn write_atomic(path: &Path, content: &str) -> Result<(), String> {
    let tmp = path.with_extension("json.tmp");
    let res = (|| {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(content.as_bytes())?;
        f.sync_all()?;
        std::fs::rename(&tmp, path)
    })();
    if res.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    res.map_err(|e| e.to_string())
}

pub fn load(app: &AppHandle) -> AppConfig {
    let mut cache = lock(&CACHE);
    if let Some(cfg) = cache.as_ref() {
        return cfg.clone();
    }
    let (cfg, err) = match config_path(app) {
        Ok(path) => read_from(&path),
        Err(e) => (AppConfig::default(), Some(e)),
    };
    if let Some(e) = &err {
        eprintln!("{e}");
    }
    *lock(&LOAD_ERROR) = err;
    *cache = Some(cfg.clone());
    cfg
}

pub fn save(app: &AppHandle, cfg: &AppConfig) -> Result<(), String> {
    let path = config_path(app)?;
    let s = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    write_atomic(&path, &s)?;
    *lock(&CACHE) = Some(cfg.clone());
    Ok(())
}

/// Problem with the settings file at start (taken once: the UI shows it a single time)
pub fn take_load_error() -> Option<String> {
    lock(&LOAD_ERROR).take()
}

pub fn find_host(app: &AppHandle, host_id: &str) -> Result<HostCfg, String> {
    load(app)
        .hosts
        .into_iter()
        .find(|h| h.id == host_id)
        .ok_or_else(|| tr(format!("Host '{host_id}' not found"), format!("Host '{host_id}' nicht gefunden")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn old_config_without_new_fields_still_loads() {
        let json = r#"{"hosts":[{"id":"local","name":"Lokal","kind":"local"}],"ui":{"showTools":false}}"#;
        let cfg: AppConfig = serde_json::from_str(json).unwrap();
        assert_eq!(cfg.hosts.len(), 1);
        assert!(!cfg.ui.show_tools);
        assert_eq!(cfg.ui.language, "auto");
        assert!(cfg.reminders.is_empty());
        assert!(cfg.presets.is_empty());
        assert_eq!(cfg.ui.theme, "auto");
        assert_eq!(cfg.ui.chat_mode, "technical");
        assert_eq!(cfg.ui.answer_mode, "normal");
        assert!(cfg.ui.left_width.is_none());
        assert_eq!(cfg.voice.stt.provider, "off");
        assert_eq!(cfg.voice.tts.provider, "system");
        assert!(!cfg.voice.improve.enabled);
        assert!(cfg.session_meta.is_empty() && cfg.groups.is_empty());
    }

    #[test]
    fn session_meta_loads_partially() {
        let json =
            r#"{"hosts":[],"sessionMeta":{"local|/s.jsonl":{"pinned":true}},"groups":[{"id":"g1","name":"Work"}]}"#;
        let cfg: AppConfig = serde_json::from_str(json).unwrap();
        let m = &cfg.session_meta["local|/s.jsonl"];
        assert!(m.pinned && m.name.is_empty() && m.group.is_empty());
        assert_eq!(cfg.groups[0].color, "");
    }

    #[test]
    fn partial_voice_config_loads() {
        let json = r#"{"hosts":[],"voice":{"stt":{"provider":"api","model":"gpt-4o-transcribe"}}}"#;
        let cfg: AppConfig = serde_json::from_str(json).unwrap();
        assert_eq!(cfg.voice.stt.provider, "api");
        assert_eq!(cfg.voice.stt.language, "");
        assert_eq!(cfg.voice.tts.auto_read, "off");
    }

    #[test]
    fn preset_without_thinking_loads() {
        let json = r#"{"id":"p1","name":"Fast","model":"openai/gpt-5-mini"}"#;
        let p: ModelPreset = serde_json::from_str(json).unwrap();
        assert_eq!(p.model, "openai/gpt-5-mini");
        assert_eq!(p.thinking, "");
    }

    #[test]
    fn reminder_roundtrip() {
        let json = r#"{"key":"local|/s.jsonl","hostId":"local","path":"/s.jsonl","at":1793440000000}"#;
        let r: Reminder = serde_json::from_str(json).unwrap();
        assert_eq!(r.at, 1_793_440_000_000);
        assert!(!r.fired);
    }

    fn temp_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("pibar-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn missing_file_gives_defaults_without_error() {
        let d = temp_dir("missing");
        let (cfg, err) = read_from(&d.join("config.json"));
        assert!(err.is_none());
        assert_eq!(cfg.hosts.len(), 1);
    }

    #[test]
    fn broken_file_is_backed_up_before_reset() {
        let d = temp_dir("broken");
        let path = d.join("config.json");
        std::fs::write(&path, "{ \"hosts\": [ broken").unwrap();
        let (cfg, err) = read_from(&path);
        assert!(err.is_some());
        assert_eq!(cfg.hosts.len(), 1);
        let backups: Vec<_> = std::fs::read_dir(&d)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|e| e.file_name().to_string_lossy().starts_with("config.json.broken-"))
            .collect();
        assert_eq!(backups.len(), 1);
        assert_eq!(std::fs::read_to_string(backups[0].path()).unwrap(), "{ \"hosts\": [ broken");
    }

    #[test]
    fn atomic_write_leaves_no_temp_file() {
        let d = temp_dir("atomic");
        let path = d.join("config.json");
        write_atomic(&path, "{\"hosts\":[]}").unwrap();
        write_atomic(&path, "{\"hosts\":[],\"x\":1}").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{\"hosts\":[],\"x\":1}");
        assert!(!d.join("config.json.tmp").exists());
    }
}
