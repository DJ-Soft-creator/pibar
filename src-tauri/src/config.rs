//! App settings: hosts, extra folders per session, reminders, UI options.
//! Stored as JSON in the app's config folder. New fields always get `#[serde(default)]`
//! so older config files keep loading.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
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
            left_collapsed: false,
            right_collapsed: false,
            quick_hotkey: default_hotkey(),
            double_tap: default_double_tap(),
            quick_pos: None,
        }
    }
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    pub hosts: Vec<HostCfg>,
    /// Extra folders per session. Key: "<hostId>|<sessionPath>"
    #[serde(default)]
    pub session_folders: HashMap<String, Vec<String>>,
    #[serde(default)]
    pub reminders: Vec<Reminder>,
    #[serde(default)]
    pub ui: UiPrefs,
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
            }],
            session_folders: HashMap::new(),
            reminders: vec![],
            ui: UiPrefs::default(),
        }
    }
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("config.json"))
}

pub fn load(app: &AppHandle) -> AppConfig {
    let Ok(path) = config_path(app) else { return AppConfig::default() };
    match std::fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => AppConfig::default(),
    }
}

pub fn save(app: &AppHandle, cfg: &AppConfig) -> Result<(), String> {
    let path = config_path(app)?;
    let s = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    std::fs::write(path, s).map_err(|e| e.to_string())
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
    }

    #[test]
    fn reminder_roundtrip() {
        let json = r#"{"key":"local|/s.jsonl","hostId":"local","path":"/s.jsonl","at":1793440000000}"#;
        let r: Reminder = serde_json::from_str(json).unwrap();
        assert_eq!(r.at, 1_793_440_000_000);
        assert!(!r.fired);
    }
}
