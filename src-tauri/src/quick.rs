//! Quick launcher: global hotkey, floating input bar, screenshot and OCR.

use base64::Engine;
use serde::Serialize;
use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

use crate::i18n::tr;

pub const QUICK: &str = "quick";
pub const MAIN: &str = "main";
pub const QUICK_WIDTH: f64 = 920.0;

// ---------- Window ----------

pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(MAIN) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Hide the bar and remember its position (in case it was moved)
pub fn hide_quick(app: &AppHandle) {
    let Some(w) = app.get_webview_window(QUICK) else { return };
    if w.is_visible().unwrap_or(false) {
        if let Ok(p) = w.outer_position() {
            let mut cfg = crate::config::load(app);
            if cfg.ui.quick_pos != Some([p.x, p.y]) {
                cfg.ui.quick_pos = Some([p.x, p.y]);
                let _ = crate::config::save(app, &cfg);
            }
        }
    }
    let _ = w.hide();
}

/// Set the bar's height. Only touches the window when the size actually changes.
pub fn resize_quick(app: &AppHandle, height: f64) {
    let Some(w) = app.get_webview_window(QUICK) else { return };
    let height = height.clamp(80.0, 600.0);
    if let (Ok(cur), Ok(scale)) = (w.inner_size(), w.scale_factor()) {
        if (cur.height as f64 / scale - height).abs() < 1.0 {
            return;
        }
    }
    let size = tauri::LogicalSize::new(QUICK_WIDTH, height);
    if cfg!(target_os = "macos") {
        // macOS resizes non-resizable windows fine; toggling the style mask there costs focus
        let _ = w.set_size(size);
    } else {
        // GTK ignores set_size on non-resizable windows: allow it briefly
        let _ = w.set_resizable(true);
        let _ = w.set_min_size(Some(tauri::LogicalSize::new(QUICK_WIDTH, 80.0)));
        let _ = w.set_size(size);
        let _ = w.set_resizable(false);
    }
}

/// Forget the remembered position: the next opening uses the default spot again
pub fn reset_quick_pos(app: &AppHandle) {
    let mut cfg = crate::config::load(app);
    cfg.ui.quick_pos = None;
    let _ = crate::config::save(app, &cfg);
}

pub fn toggle_quick(app: &AppHandle) {
    let Some(w) = app.get_webview_window(QUICK) else { return };
    if w.is_visible().unwrap_or(false) {
        hide_quick(app);
        return;
    }
    let monitors = app.available_monitors().unwrap_or_default();
    let saved = crate::config::load(app).ui.quick_pos;
    // only use the remembered position if it is still on a screen
    let saved_ok = saved.filter(|[x, y]| {
        monitors.iter().any(|m| {
            let (mp, ms) = (m.position(), m.size());
            *x + 100 > mp.x && *x < mp.x + ms.width as i32 - 100 && *y >= mp.y && *y < mp.y + ms.height as i32 - 60
        })
    });
    if let Some([x, y]) = saved_ok {
        let _ = w.set_position(PhysicalPosition::new(x, y));
    } else {
        // default: centred in the lower third of the screen with the mouse pointer
        let monitor = app
            .cursor_position()
            .ok()
            .and_then(|p| app.monitor_from_point(p.x, p.y).ok().flatten())
            .or_else(|| w.current_monitor().ok().flatten());
        if let Some(m) = monitor {
            let mp = m.position();
            let ms = m.size();
            // width from the fixed logical width (outer_size is unreliable for hidden windows)
            let width = (QUICK_WIDTH * m.scale_factor()) as i32;
            let x = mp.x + (ms.width as i32 - width) / 2;
            let y = mp.y + (ms.height as f64 * 0.72) as i32;
            let _ = w.set_position(PhysicalPosition::new(x, y));
        }
    }
    let _ = w.show();
    let _ = w.set_focus();
    let _ = app.emit_to(QUICK, "quick-show", ());
}

/// Result of the last hotkey registration: (shortcut, error). Shown in the settings, since the start-up
/// registration has no window to report to.
static HOTKEY: std::sync::Mutex<(String, Option<String>)> = std::sync::Mutex::new((String::new(), None));

pub fn hotkey_status() -> (String, Option<String>) {
    HOTKEY.lock().map(|s| s.clone()).unwrap_or_default()
}

pub fn register_hotkey(app: &AppHandle, accel: &str) -> Result<(), String> {
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    let accel = if accel.trim().is_empty() { crate::config::default_hotkey() } else { accel.trim().to_string() };
    let res = gs
        .on_shortcut(accel.as_str(), |app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                toggle_quick(app);
            }
        })
        .map_err(|e| {
            tr(
                format!("Shortcut '{accel}' not possible: {e}. Is it used by another app (or a PiBar still running from the terminal)?"),
                format!("Tastenkürzel '{accel}' nicht möglich: {e}. Belegt es eine andere App (oder ein PiBar, das noch im Terminal läuft)?"),
            )
        });
    if let Ok(mut s) = HOTKEY.lock() {
        *s = (accel.clone(), res.as_ref().err().cloned());
    }
    res
}

// ---------- Screenshot ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capture {
    pub path: String,
    pub data: String,
    pub mime_type: String,
}

fn temp_png() -> PathBuf {
    let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    std::env::temp_dir().join(format!("pibar-shot-{ts}.png"))
}

fn has(cmd: &str) -> bool {
    Command::new("sh").args(["-c", &format!("command -v {cmd}")]).output().map(|o| o.status.success()).unwrap_or(false)
}

/// Take a screenshot. mode = "region" (drag an area) or "screen" (whole screen).
/// Returns None when the user cancels (Esc).
pub fn capture(app: &AppHandle, mode: &str) -> Result<Option<Capture>, String> {
    let quick = app.get_webview_window(QUICK);
    let pos = quick.as_ref().and_then(|w| w.outer_position().ok());
    if let Some(w) = &quick {
        let _ = w.hide();
    }
    std::thread::sleep(Duration::from_millis(250));
    let path = temp_png();
    let p = path.to_string_lossy().to_string();

    let status = if cfg!(target_os = "macos") {
        let mut c = Command::new("screencapture");
        c.arg("-x");
        if mode == "region" {
            c.arg("-i");
        } else {
            c.arg("-m");
        }
        c.arg(&p).status()
    } else if has("import") {
        // Linux/X11 with ImageMagick
        let mut c = Command::new("import");
        if mode != "region" {
            c.args(["-window", "root"]);
        }
        c.arg(&p).status()
    } else if has("gnome-screenshot") {
        let mut c = Command::new("gnome-screenshot");
        if mode == "region" {
            c.arg("-a");
        }
        c.args(["-f", &p]).status()
    } else {
        if let Some(w) = &quick {
            let _ = w.show();
        }
        return Err(tr("No screenshot tool found", "Kein Screenshot-Werkzeug gefunden"));
    };

    if let Some(w) = &quick {
        let _ = w.show();
        if let Some(p) = pos {
            let _ = w.set_position(p);
        }
        let _ = w.set_focus();
    }
    status.map_err(|e| tr(format!("Screenshot failed: {e}"), format!("Screenshot fehlgeschlagen: {e}")))?;
    if !path.exists() {
        return Ok(None); // cancelled
    }

    // shrink large images (saves tokens; Pi would resize them anyway)
    if cfg!(target_os = "macos") {
        let _ = Command::new("sips").args(["-Z", "2000", &p]).output();
    } else if has("convert") {
        let _ = Command::new("convert").args([&p, "-resize", "2000x2000>", &p]).output();
    }

    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    Ok(Some(Capture {
        path: p,
        data: base64::engine::general_purpose::STANDARD.encode(bytes),
        mime_type: "image/png".into(),
    }))
}

// ---------- OCR ----------

const OCR_SWIFT: &str = r#"
import Foundation
import Vision
import AppKit

let args = CommandLine.arguments
guard args.count > 1,
      let img = NSImage(contentsOfFile: args[1]),
      let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    FileHandle.standardError.write("Cannot read image\n".data(using: .utf8)!)
    exit(1)
}
let req = VNRecognizeTextRequest()
req.recognitionLevel = .accurate
req.usesLanguageCorrection = true
req.recognitionLanguages = ["de-DE", "en-US"]
do {
    try VNImageRequestHandler(cgImage: cg, options: [:]).perform([req])
} catch {
    FileHandle.standardError.write("OCR error: \(error)\n".data(using: .utf8)!)
    exit(2)
}
let lines = (req.results ?? []).compactMap { $0.topCandidates(1).first?.string }
print(lines.joined(separator: "\n"))
"#;

/// macOS: a small helper using Apple's Vision text recognition, compiled on first use.
fn mac_ocr_helper(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let bin = dir.join("pibar-ocr-v2");
    if bin.exists() {
        return Ok(bin);
    }
    let src = dir.join("pibar-ocr.swift");
    std::fs::write(&src, OCR_SWIFT).map_err(|e| e.to_string())?;
    let out = Command::new("xcrun")
        .args(["swiftc", "-O", &src.to_string_lossy(), "-o", &bin.to_string_lossy()])
        .output()
        .map_err(|e| tr(format!("swiftc not found: {e}"), format!("swiftc nicht gefunden: {e}")))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(tr(
            format!("Could not build the OCR helper:\n{err}"),
            format!("OCR-Hilfsprogramm ließ sich nicht bauen:\n{err}"),
        ));
    }
    Ok(bin)
}

pub fn ocr(app: &AppHandle, path: &str) -> Result<String, String> {
    let out = if cfg!(target_os = "macos") {
        let helper = mac_ocr_helper(app)?;
        Command::new(helper).arg(path).output()
    } else if has("tesseract") {
        Command::new("tesseract").args([path, "-", "-l", "deu+eng"]).output()
    } else {
        return Err(tr(
            "No text recognition found (Linux: install tesseract)",
            "Keine Texterkennung gefunden (Linux: tesseract installieren)",
        ));
    }
    .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}
