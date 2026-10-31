//! Language of messages coming from the Rust core (errors, tray menu).
//! The UI tells us its language via the `set_language` command; until then the setting or the system
//! language is used. Messages are written as `tr(english, german)` right where they are produced.

use std::sync::atomic::{AtomicBool, Ordering};

static GERMAN: AtomicBool = AtomicBool::new(false);

/// Apply a language preference: "de", "en" or "auto" (system language)
pub fn set(pref: &str) {
    let german = match pref {
        "de" => true,
        "en" => false,
        _ => sys_locale::get_locale().map(|l| l.to_lowercase().starts_with("de")).unwrap_or(false),
    };
    GERMAN.store(german, Ordering::SeqCst);
}

pub fn is_german() -> bool {
    GERMAN.load(Ordering::SeqCst)
}

/// Pick the message in the active language
pub fn tr(en: impl Into<String>, de: impl Into<String>) -> String {
    if is_german() {
        de.into()
    } else {
        en.into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_language() {
        set("de");
        assert_eq!(tr("Hello", "Hallo"), "Hallo");
        set("en");
        assert_eq!(tr("Hello", "Hallo"), "Hello");
    }
}
