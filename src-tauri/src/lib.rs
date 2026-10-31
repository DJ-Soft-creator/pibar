mod config;
mod doubletap;
mod files;
mod hostexec;
mod i18n;
mod models;
mod pi;
mod quick;
mod sessions;

use config::AppConfig;
use pi::PiManager;
use serde_json::Value;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, RunEvent, State, WindowEvent};

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

// ---------- Pi processes ----------

#[tauri::command]
fn pi_open(
    app: AppHandle,
    mgr: State<'_, PiManager>,
    host_id: String,
    cwd: String,
    session_path: Option<String>,
) -> Result<u32, String> {
    let host = config::find_host(&app, &host_id)?;
    mgr.open(&app, &host, &cwd, session_path)
}

#[tauri::command]
async fn pi_send(mgr: State<'_, PiManager>, handle: u32, cmd: Value) -> Result<Value, String> {
    mgr.send(handle, cmd).await
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
) -> Result<Vec<files::FolderListing>, String> {
    let host = config::find_host(&app, &host_id)?;
    tauri::async_runtime::spawn_blocking(move || files::list(&host, &folders)).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn read_file(app: AppHandle, host_id: String, path: String) -> Result<String, String> {
    let host = config::find_host(&app, &host_id)?;
    tauri::async_runtime::spawn_blocking(move || files::read(&host, &path)).await.map_err(|e| e.to_string())?
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
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .manage(PiManager::default())
        .setup(|app| {
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
            test_host,
            list_sessions,
            list_models,
            pi_open,
            pi_send,
            pi_close,
            pi_close_all,
            set_language,
            list_files,
            read_file,
            write_file,
            create_file,
            quick_hide,
            quick_reset_pos,
            quick_resize,
            show_main,
            set_hotkey,
            set_double_tap,
            double_tap_status,
            capture_screen,
            ocr_image
        ])
        .build(tauri::generate_context!())
        .expect("PiBar failed to start");

    app.run(|handle, event| match event {
        RunEvent::Exit => handle.state::<PiManager>().close_all(),
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => quick::show_main(handle),
        _ => {}
    });
}
