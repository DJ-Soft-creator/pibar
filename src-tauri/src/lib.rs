mod bg;
mod config;
mod diag;
mod disclaim;
mod doubletap;
mod files;
mod gitlog;
mod hostexec;
mod i18n;
mod models;
mod pi;
mod quick;
mod sessions;
mod terminal;
mod voice;

use config::AppConfig;
use pi::PiManager;
use serde_json::Value;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, RunEvent, State, WindowEvent};
use terminal::TermManager;

// ---------- Settings ----------

#[tauri::command]
fn get_config(app: AppHandle) -> AppConfig {
    config::load(&app)
}

#[tauri::command]
fn save_config(app: AppHandle, mut cfg: AppConfig) -> Result<(), String> {
    // only the Rust core manages the quick bar position
    cfg.ui.quick_pos = config::load(&app).ui.quick_pos;
    config::save(&app, &cfg)
}

/// Problem with the settings file at start (e.g. damaged and reset), shown once by the UI
#[tauri::command]
fn config_load_error() -> Option<String> {
    config::take_load_error()
}

// ---------- Hosts ----------

/// Test a connection: returns the host's Pi version.
#[tauri::command]
async fn test_host(app: AppHandle, host_id: String) -> Result<String, String> {
    let host = config::find_host(&app, &host_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let pi = if host.pi_command.trim().is_empty() { "pi".to_string() } else { host.pi_command.clone() };
        hostexec::run_shell(&host, &format!("{pi} --version"), None).map(|s| s.trim().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// A host's available models (via `pi --list-models`, without a running session)
#[tauri::command]
async fn list_models(app: AppHandle, host_id: String) -> Result<Vec<models::ModelInfo>, String> {
    let host = config::find_host(&app, &host_id)?;
    tauri::async_runtime::spawn_blocking(move || models::list(&host)).await.map_err(|e| e.to_string())?
}

// ---------- Sessions ----------

#[tauri::command]
async fn list_sessions(app: AppHandle, host_id: String) -> Result<Vec<sessions::SessionInfo>, String> {
    let host = config::find_host(&app, &host_id)?;
    tauri::async_runtime::spawn_blocking(move || sessions::list(&host)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn delete_sessions(app: AppHandle, host_id: String, paths: Vec<String>) -> Result<usize, String> {
    let host = config::find_host(&app, &host_id)?;
    tauri::async_runtime::spawn_blocking(move || sessions::delete(&host, &paths)).await.map_err(|e| e.to_string())?
}

/// User messages (entry ids) of session files, to show where branches part (src/main/branchNav.ts)
#[tauri::command]
async fn session_outlines(
    app: AppHandle,
    host_id: String,
    paths: Vec<String>,
) -> Result<Vec<sessions::SessionOutline>, String> {
    let host = config::find_host(&app, &host_id)?;
    tauri::async_runtime::spawn_blocking(move || sessions::outlines(&host, &paths)).await.map_err(|e| e.to_string())?
}

// ---------- Pi processes ----------

#[tauri::command]
fn pi_open(
    app: AppHandle,
    mgr: State<'_, PiManager>,
    host_id: String,
    cwd: String,
    session_path: Option<String>,
    tools: Option<Vec<String>>,
) -> Result<u32, String> {
    let host = config::find_host(&app, &host_id)?;
    mgr.open(&app, &host, &cwd, session_path, tools)
}

#[tauri::command]
async fn pi_send(mgr: State<'_, PiManager>, handle: u32, cmd: Value) -> Result<Value, String> {
    mgr.send(handle, cmd).await
}

/// Answer to a dialog Pi asked for (extension_ui_response); only this message type is passed on
#[tauri::command]
fn pi_reply(mgr: State<'_, PiManager>, handle: u32, msg: Value) -> Result<(), String> {
    if msg.get("type").and_then(Value::as_str) != Some("extension_ui_response") {
        return Err("only extension_ui_response".into());
    }
    mgr.reply(handle, &msg)
}

#[tauri::command]
fn pi_stderr(mgr: State<'_, PiManager>, handle: u32) -> String {
    mgr.stderr(handle)
}

#[tauri::command]
async fn diagnose(app: AppHandle, host_id: String, provider: String, model: String) -> Result<String, String> {
    let host = config::find_host(&app, &host_id)?;
    tauri::async_runtime::spawn_blocking(move || diag::run(&host, &provider, &model)).await.map_err(|e| e.to_string())
}

#[tauri::command]
fn pi_close(mgr: State<'_, PiManager>, handle: u32) {
    mgr.close(handle);
}

/// Stop all Pi processes (the main window calls this on start, e.g. after a reload)
#[tauri::command]
fn pi_close_all(mgr: State<'_, PiManager>) {
    mgr.close_all();
}

// ---------- Runs in the background ----------

/// Send one message as a detached run on the host ("in the background"): Pi keeps going when PiBar quits or the
/// connection drops. Returns the handle of the log follower, i.e. of the stream the UI shows.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn bg_start(
    app: AppHandle,
    mgr: State<'_, PiManager>,
    host_id: String,
    cwd: String,
    session: String,
    prompt: String,
    provider: Option<String>,
    model_id: Option<String>,
    thinking: Option<String>,
    tools: Option<Vec<String>>,
) -> Result<u32, String> {
    let host = config::find_host(&app, &host_id)?;
    let mut args: Vec<String> = vec!["--session".into(), session.clone()];
    if let Some(p) = provider.filter(|p| !p.trim().is_empty()) {
        args.push("--provider".into());
        args.push(p);
    }
    if let Some(m) = model_id.filter(|m| !m.trim().is_empty()) {
        args.push("--model".into());
        args.push(m);
    }
    if let Some(t) = thinking.filter(|t| !t.trim().is_empty()) {
        args.push("--thinking".into());
        args.push(t);
    }
    args.extend(pi::tool_args(tools.as_deref()));
    args.push(prompt);
    let (h, sess) = (host.clone(), session.clone());
    tauri::async_runtime::spawn_blocking(move || bg::start(&h, &cwd, &sess, &args))
        .await
        .map_err(|e| e.to_string())??;
    mgr.open_follow(&app, &host, &session)
}

/// Follow a run in the background that was started earlier (e.g. before PiBar was restarted)
#[tauri::command]
fn bg_follow(app: AppHandle, mgr: State<'_, PiManager>, host_id: String, session: String) -> Result<u32, String> {
    let host = config::find_host(&app, &host_id)?;
    mgr.open_follow(&app, &host, &session)
}

/// Is a session's run in the background still going?
#[tauri::command]
async fn bg_running(app: AppHandle, host_id: String, session: String) -> Result<bool, String> {
    let host = config::find_host(&app, &host_id)?;
    tauri::async_runtime::spawn_blocking(move || bg::running(&host, &session)).await.map_err(|e| e.to_string())?
}

/// Stop a session's run in the background (the session file keeps what Pi wrote so far)
#[tauri::command]
async fn bg_stop(app: AppHandle, host_id: String, session: String) -> Result<(), String> {
    let host = config::find_host(&app, &host_id)?;
    tauri::async_runtime::spawn_blocking(move || bg::stop(&host, &session)).await.map_err(|e| e.to_string())?
}

// ---------- Terminal (interactive shell in a pty) ----------

/// Start a shell in a folder of the host; returns the id of the terminal
#[tauri::command]
fn term_open(
    app: AppHandle,
    mgr: State<'_, TermManager>,
    host_id: String,
    cwd: String,
    cols: u16,
    rows: u16,
) -> Result<u32, String> {
    let host = config::find_host(&app, &host_id)?;
    mgr.open(&app, &host, &cwd, cols, rows)
}

/// Keys and pasted text from the terminal
#[tauri::command]
fn term_write(mgr: State<'_, TermManager>, id: u32, data: String) -> Result<(), String> {
    mgr.write(id, &data)
}

#[tauri::command]
fn term_resize(mgr: State<'_, TermManager>, id: u32, cols: u16, rows: u16) -> Result<(), String> {
    mgr.resize(id, cols, rows)
}

#[tauri::command]
fn term_close(mgr: State<'_, TermManager>, id: u32) {
    mgr.close(id);
}

/// Stop all terminals (the main window calls this on start, e.g. after a reload)
#[tauri::command]
fn term_close_all(mgr: State<'_, TermManager>) {
    mgr.close_all();
}

// ---------- Language ----------

/// UI language changed: use it for Rust messages and rebuild the tray menu
#[tauri::command]
fn set_language(app: AppHandle, lang: String) {
    i18n::set(&lang);
    if let (Some(tray), Ok(menu)) = (app.tray_by_id("pibar"), tray_menu(&app)) {
        let _ = tray.set_menu(Some(menu));
    }
}

// ---------- Files ----------

#[tauri::command]
async fn list_files(
    app: AppHandle,
    host_id: String,
    folders: Vec<String>,
    git: Option<bool>,
    docs_only: Option<bool>,
) -> Result<Vec<files::FolderListing>, String> {
    let host = config::find_host(&app, &host_id)?;
    let git = git.unwrap_or(false);
    let docs_only = docs_only.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || files::list(&host, &folders, git, docs_only))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn read_file(app: AppHandle, host_id: String, path: String) -> Result<String, String> {
    let host = config::find_host(&app, &host_id)?;
    tauri::async_runtime::spawn_blocking(move || files::read(&host, &path)).await.map_err(|e| e.to_string())?
}

/// An image of the file panel as base64 (read only)
#[tauri::command]
async fn read_image(app: AppHandle, host_id: String, path: String) -> Result<files::ImageData, String> {
    let host = config::find_host(&app, &host_id)?;
    tauri::async_runtime::spawn_blocking(move || files::read_image(&host, &path)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn read_file_head(app: AppHandle, host_id: String, path: String) -> Result<files::HeadVersion, String> {
    let host = config::find_host(&app, &host_id)?;
    tauri::async_runtime::spawn_blocking(move || files::read_head(&host, &path)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn write_file(app: AppHandle, host_id: String, path: String, content: String) -> Result<(), String> {
    let host = config::find_host(&app, &host_id)?;
    tauri::async_runtime::spawn_blocking(move || files::write(&host, &path, &content))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn create_file(app: AppHandle, host_id: String, path: String) -> Result<(), String> {
    let host = config::find_host(&app, &host_id)?;
    tauri::async_runtime::spawn_blocking(move || files::create(&host, &path)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn list_dirs(
    app: AppHandle,
    host_id: String,
    path: String,
    hidden: Option<bool>,
) -> Result<files::DirListing, String> {
    let host = config::find_host(&app, &host_id)?;
    let hidden = hidden.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || files::list_dirs(&host, &path, hidden))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn create_dir(app: AppHandle, host_id: String, path: String) -> Result<(), String> {
    let host = config::find_host(&app, &host_id)?;
    tauri::async_runtime::spawn_blocking(move || files::create_dir(&host, &path)).await.map_err(|e| e.to_string())?
}

// ---------- Git history (read only) ----------

#[tauri::command]
async fn git_log(
    app: AppHandle,
    host_id: String,
    dir: String,
    file: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<gitlog::Commit>, String> {
    let host = config::find_host(&app, &host_id)?;
    tauri::async_runtime::spawn_blocking(move || gitlog::log(&host, &dir, file.as_deref(), limit.unwrap_or(200)))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn git_commit(
    app: AppHandle,
    host_id: String,
    dir: String,
    hash: String,
) -> Result<gitlog::CommitDetail, String> {
    let host = config::find_host(&app, &host_id)?;
    tauri::async_runtime::spawn_blocking(move || gitlog::commit(&host, &dir, &hash)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn git_diff(
    app: AppHandle,
    host_id: String,
    dir: String,
    hash: String,
    path: String,
    top: bool,
) -> Result<String, String> {
    let host = config::find_host(&app, &host_id)?;
    tauri::async_runtime::spawn_blocking(move || gitlog::diff(&host, &dir, &hash, &path, top))
        .await
        .map_err(|e| e.to_string())?
}

// ---------- Voice (dictation, read aloud, text improvement) ----------

#[tauri::command]
async fn transcribe_audio(app: AppHandle, data: String, mime: String) -> Result<String, String> {
    let cfg = config::load(&app).voice.stt;
    tauri::async_runtime::spawn_blocking(move || voice::transcribe(&cfg, &data, &mime))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn improve_text(app: AppHandle, text: String, prompt: String) -> Result<String, String> {
    let cfg = config::load(&app).voice.improve;
    tauri::async_runtime::spawn_blocking(move || voice::improve(&cfg, &prompt, &text))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn speak_text(app: AppHandle, text: String) -> Result<voice::Audio, String> {
    let cfg = config::load(&app).voice.tts;
    tauri::async_runtime::spawn_blocking(move || voice::speak(&cfg, &text)).await.map_err(|e| e.to_string())?
}

// ---------- Quick launcher ----------

#[tauri::command]
fn quick_hide(app: AppHandle) {
    quick::hide_quick(&app);
}

#[tauri::command]
fn quick_reset_pos(app: AppHandle) {
    quick::reset_quick_pos(&app);
}

#[tauri::command]
fn quick_resize(app: AppHandle, height: f64) {
    quick::resize_quick(&app, height);
}

#[tauri::command]
fn show_main(app: AppHandle) {
    quick::show_main(&app);
}

#[tauri::command]
fn set_hotkey(app: AppHandle, accel: String) -> Result<(), String> {
    quick::register_hotkey(&app, &accel)
}

/// Shortcut of the quick bar and the error of its registration, if any
#[tauri::command]
fn hotkey_status() -> serde_json::Value {
    let (accel, error) = quick::hotkey_status();
    serde_json::json!({ "accel": accel, "error": error })
}

#[tauri::command]
fn set_double_tap(key: String) -> String {
    doubletap::set_key(doubletap::TapKey::parse(&key));
    doubletap::status().to_string()
}

#[tauri::command]
fn double_tap_status() -> String {
    doubletap::status().to_string()
}

#[tauri::command]
async fn capture_screen(app: AppHandle, mode: String) -> Result<Option<quick::Capture>, String> {
    tauri::async_runtime::spawn_blocking(move || quick::capture(&app, &mode)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn ocr_image(app: AppHandle, path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || quick::ocr(&app, &path)).await.map_err(|e| e.to_string())?
}

/// Tray menu in the current language
fn tray_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    use i18n::tr;
    let open = MenuItem::with_id(app, "open", tr("Open PiBar", "PiBar öffnen"), true, None::<&str>)?;
    let quick_item = MenuItem::with_id(app, "quick", "Quick-Launcher", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", tr("Quit", "Beenden"), true, None::<&str>)?;
    Menu::with_items(app, &[&open, &quick_item, &quit])
}

fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let menu = tray_menu(app)?;
    let mut tray = TrayIconBuilder::with_id("pibar").tooltip("PiBar").menu(&menu);
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.on_menu_event(|app, ev| match ev.id.as_ref() {
        "open" => quick::show_main(app),
        "quick" => quick::toggle_quick(app),
        "quit" => app.exit(0),
        _ => {}
    })
    .build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // started as helper for a child process (see disclaim.rs): becomes that program, never returns
    disclaim::run_if_requested();
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .manage(PiManager::default())
        .manage(TermManager::default())
        .setup(|app| {
            // read the user's shell environment in the background, so the first local Pi start does not wait
            std::thread::spawn(|| {
                hostexec::user_env();
            });
            let handle = app.handle().clone();
            let cfg = config::load(&handle);
            i18n::set(&cfg.ui.language);
            if let Err(e) = quick::register_hotkey(&handle, &cfg.ui.quick_hotkey) {
                eprintln!("{e}");
            }
            // double tap (macOS): its own keyboard thread
            doubletap::set_key(doubletap::TapKey::parse(&cfg.ui.double_tap));
            let h2 = handle.clone();
            doubletap::start(move || {
                let h3 = h2.clone();
                let _ = h2.run_on_main_thread(move || quick::toggle_quick(&h3));
            });
            if let Err(e) = setup_tray(&handle) {
                eprintln!("Tray: {e}");
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // closing the main window only hides it; app and hotkey keep running
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == quick::MAIN {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_config,
            save_config,
            config_load_error,
            test_host,
            list_sessions,
            delete_sessions,
            session_outlines,
            list_models,
            pi_open,
            pi_send,
            pi_reply,
            pi_close,
            pi_stderr,
            diagnose,
            pi_close_all,
            bg_start,
            bg_follow,
            bg_running,
            bg_stop,
            term_open,
            term_write,
            term_resize,
            term_close,
            term_close_all,
            set_language,
            list_files,
            read_file,
            read_image,
            git_log,
            git_commit,
            git_diff,
            write_file,
            create_file,
            create_dir,
            list_dirs,
            read_file_head,
            quick_hide,
            quick_reset_pos,
            quick_resize,
            show_main,
            set_hotkey,
            set_double_tap,
            hotkey_status,
            double_tap_status,
            capture_screen,
            ocr_image,
            transcribe_audio,
            improve_text,
            speak_text
        ])
        .build(tauri::generate_context!())
        .expect("PiBar failed to start");

    app.run(|handle, event| match event {
        RunEvent::Exit => {
            handle.state::<PiManager>().close_all();
            handle.state::<TermManager>().close_all();
        }
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => quick::show_main(handle),
        _ => {}
    });
}
