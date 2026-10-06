// Coucou for Windows — app wiring and the commands the island calls.

mod claude;
mod files;
mod hooks;
mod desktop;
mod github;
mod integrations;
mod island;
mod knowura;
mod log;
mod music;
mod pipe;
mod privacy;
mod platform;
mod secrets;
mod settings;
mod tray;
mod weather;

use std::process::Command;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_autostart::{ManagerExt, MacosLauncher};

use claude::{Chat, ChatContext, ChatReply};
use files::DroppedFile;
use hooks::{HookPreview, HookStatus};
use island::{PollGate, ScreenInfo};
use knowura::Knowura;
use pipe::Pending;
use settings::Settings;

pub struct Shared {
    pub settings: Mutex<Settings>,
    pub gate: Arc<PollGate>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootInfo {
    settings: Settings,
    screen: ScreenInfo,
    version: String,
    hook_path: String,
    /// False where the OS has no global cursor (Wayland): the page then reports
    /// the cursor from its own mouse events.
    cursor_poll: bool,
    /// The combo that opens Knowura's text box, when Knowura mode is on and Windows allowed one.
    knowura_hotkey: Option<String>,
}

#[tauri::command]
fn boot(app: AppHandle, shared: State<Shared>) -> BootInfo {
    let mut settings = shared.settings.lock().unwrap().clone();
    // The real state of ~/.claude/settings.json wins over whatever we stored.
    settings.hooks_installed = hooks::status().installed;
    let screen = island::screen_info(&app, &settings.screen);
    BootInfo {
        settings,
        screen,
        version: env!("CARGO_PKG_VERSION").to_string(),
        hook_path: settings::hook_exe_path().to_string_lossy().to_string(),
        cursor_poll: platform::CURSOR_POLL,
        knowura_hotkey: app.state::<Knowura>().hotkey(),
    }
}

#[tauri::command]
fn save_settings(app: AppHandle, shared: State<Shared>, settings: Settings) {
    let settings = settings.sanitized();
    let desktop_changed;
    let (screen_changed, autostart_changed, size_changed, on_top_changed, taskbar_changed, mode_changed) = {
        let mut current = shared.settings.lock().unwrap();
        let screen_changed = current.screen != settings.screen;
        let autostart_changed = current.autostart != settings.autostart;
        let size_changed = current.island_width != settings.island_width
            || current.island_height_extra != settings.island_height_extra;
        let on_top_changed = current.always_on_top != settings.always_on_top;
        let taskbar_changed = current.show_in_taskbar != settings.show_in_taskbar;
        let mode_changed = current.assistant_mode != settings.assistant_mode;
        desktop_changed = current.desktop_mochi != settings.desktop_mochi;
        // Where he was left is the desktop module's to remember, not the page's.
        let mut settings = settings.clone();
        settings.desktop_mochi_pos = current.desktop_mochi_pos;
        *current = settings;
        (screen_changed, autostart_changed, size_changed, on_top_changed, taskbar_changed, mode_changed)
    };
    if let Err(err) = settings::save(&settings) {
        eprintln!("[coucou] could not save settings: {err}");
    }
    if autostart_changed {
        let manager = app.autolaunch();
        let result = if settings.autostart { manager.enable() } else { manager.disable() };
        if let Err(err) = result {
            eprintln!("[coucou] autostart: {err}");
        }
    }
    if desktop_changed {
        desktop::set_enabled(&app, settings.desktop_mochi);
        tray::refresh(&app);
    }
    if mode_changed {
        knowura::apply_mode(&app, settings.assistant_mode == "knowura");
    }
    if mode_changed || autostart_changed {
        tray::refresh(&app);
    }
    if taskbar_changed {
        if let Some(win) = island::window(&app) {
            // The style only takes effect when the window is shown again.
            let _ = win.hide();
            platform::set_taskbar_visible(&win, settings.show_in_taskbar);
            let _ = win.show();
            island::enforce_taskbar_style_soon(&app);
        }
    }
    if screen_changed || size_changed || on_top_changed || taskbar_changed {
        let collapsed = shared.gate.collapsed.load(Ordering::Relaxed);
        island::apply_geometry(&app, &settings.screen, collapsed);
        if size_changed {
            island::refresh_click_through(&app, &shared.gate);
        }
    }
    // Keep the other window in step (island ⇄ settings window).
    let _ = app.emit("settings-changed", settings);
}

/// Opens the Knowura panel ("text" or "voice").
#[tauri::command]
fn knowura_open(app: AppHandle, mode: String) {
    knowura::open(&app, knowura::Mode::parse(&mode));
}

/// Is the camera or the microphone in use right now (the island also gets a "privacy" event on every change).
#[tauri::command]
fn privacy_state() -> privacy::Privacy {
    privacy::status()
}

/// Cities matching a name, for choosing where the weather is for.
#[tauri::command]
async fn weather_search(query: String) -> Result<Vec<weather::Place>, String> {
    weather::search(&query).await
}

/// The weather now and the next few days at a place.
#[tauri::command]
async fn weather_get(lat: f64, lon: f64, fahrenheit: bool) -> Result<weather::Weather, String> {
    weather::fetch(lat, lon, fahrenheit).await
}

/// The player: what is playing now.
#[tauri::command]
fn music_state() -> music::MusicInfo {
    music::state()
}

/// The player's buttons: "toggle" | "play" | "pause" | "next" | "prev" | "seek:<seconds>".
#[tauri::command]
fn music_control(action: String) {
    music::control(action);
}

/// Settings → "Sign in with the browser".
#[tauri::command]
fn knowura_sign_in_browser() {
    knowura::sign_in_browser();
}

/// Mochi's file drop in Knowura mode: the file lands in the Knowura composer.
#[tauri::command]
fn knowura_attach(app: AppHandle, path: String) {
    knowura::attach_file(&app, &path);
}

/// The tray's "Start with Windows" entry.
pub fn toggle_autostart(app: &AppHandle) {
    let shared = app.state::<Shared>();
    let updated = {
        let mut current = shared.settings.lock().unwrap();
        current.autostart = !current.autostart;
        let _ = settings::save(&current);
        current.clone()
    };
    let manager = app.autolaunch();
    let result = if updated.autostart { manager.enable() } else { manager.disable() };
    if let Err(err) = result {
        eprintln!("[coucou] autostart: {err}");
    }
    tray::refresh(app);
    let _ = app.emit("settings-changed", updated);
}

/// Hidden island → shrink the window to the invisible wake strip and park the
/// cursor poll; anything else → full panel and 60 Hz polling.
#[tauri::command]
fn set_collapsed(app: AppHandle, shared: State<Shared>, collapsed: bool) {
    let pref = shared.settings.lock().unwrap().screen.clone();
    shared.gate.collapsed.store(collapsed, Ordering::Relaxed);
    island::apply_geometry(&app, &pref, collapsed);
    // The wake strip must always take the mouse, and a resize invalidates the flag.
    island::refresh_click_through(&app, &shared.gate);
    shared.gate.set_active(!collapsed);
}

/// The front end pushes the island shape; Rust decides click-through from it.
#[tauri::command]
fn set_island_rect(app: AppHandle, shared: State<Shared>, x: f64, y: f64, width: f64, height: f64) {
    shared.gate.set_rect(island::IslandRect { x, y, w: width, h: height });
    // Without the cursor poll the input region is the click-through: it follows the island.
    if !platform::CURSOR_POLL {
        island::refresh_click_through(&app, &shared.gate);
    }
}

#[tauri::command]
fn focus_window(app: AppHandle, focused: bool) {
    let Some(win) = island::window(&app) else { return };
    platform::set_activating(&win, focused);
    if focused {
        let _ = win.set_focus();
    }
}

#[tauri::command]
fn reposition(app: AppHandle, shared: State<Shared>) {
    let pref = shared.settings.lock().unwrap().screen.clone();
    let collapsed = shared.gate.collapsed.load(Ordering::Relaxed);
    island::apply_geometry(&app, &pref, collapsed);
}

#[tauri::command]
fn open_url(url: String) {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return;
    }
    platform::open_url(&url);
}

/// The ↗ on a file diff: opens the file in VS Code when `code` is on PATH, otherwise shows its folder.
/// The path comes from a hook payload, so only an existing file given by its full path goes any
/// further, and it is never handed to the shell or "opened" by whatever handles its type (a script
/// Claude just wrote must not run because someone tapped an arrow).
#[tauri::command]
fn open_changed_file(path: String) -> bool {
    let p = std::path::Path::new(&path);
    if !(p.is_absolute() && p.is_file()) {
        return false;
    }
    if let Some(code) = platform::find_on_path("code") {
        let mut cmd = Command::new(code);
        cmd.arg("--").arg(p);
        if platform::no_console(&mut cmd).spawn().is_ok() {
            return true;
        }
    }
    match p.parent() {
        Some(dir) => {
            platform::reveal_folder(&dir.to_string_lossy());
            true
        }
        None => false,
    }
}

/// The desktop Mochi's page asks to be carried (a press that became a drag).
#[tauri::command]
fn desktop_mochi_drag(app: AppHandle) {
    desktop::begin_drag(&app);
}

/// A double click on the desktop Mochi, or the island's "bring him home".
#[tauri::command]
fn desktop_mochi_home(app: AppHandle) {
    desktop::fly_home(&app);
}

/// The island's Mochi was dragged out of it.
#[tauri::command]
fn desktop_mochi_pick_up(app: AppHandle) {
    desktop::pick_up(&app);
}

/// An approval or a question started or stopped waiting: Mochi goes back to the notch to show it.
#[tauri::command]
fn desktop_mochi_alert(app: AppHandle, active: bool) {
    desktop::set_alert(&app, active);
}

/// "Open terminal" opens the working folder in VS Code when `code` is on PATH,
/// and falls back to the file manager otherwise.
#[tauri::command]
fn open_in_vscode(path: Option<String>) -> bool {
    // No shell anywhere near this. The path is a project folder chosen by
    // whoever is using Claude Code, and a shell would happily read `&`, `^`, `%`
    // or `$` in a folder name as syntax. Finding the launcher ourselves and
    // handing the path over as a separate argument keeps it a path.
    let path = path.filter(|p| !p.is_empty());
    // It arrives in a hook payload: only an existing folder, given by its full
    // path, goes any further. `code` would read `--something` as an option, and
    // xdg-open would launch a file with whatever handles its type.
    if let Some(p) = path.as_deref() {
        let p = std::path::Path::new(p);
        if !(p.is_absolute() && p.is_dir()) {
            return false;
        }
    }
    if let Some(code) = platform::find_on_path("code") {
        let mut cmd = Command::new(code);
        if let Some(p) = path.as_deref() {
            cmd.arg(p);
        }
        if platform::no_console(&mut cmd).spawn().is_ok() {
            return true;
        }
    }
    if let Some(p) = path.as_deref() {
        platform::reveal_folder(p);
    }
    false
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

/// Tray → Pause. Paused means paused: the pollers stop talking to the network,
/// not just the island stopping showing things.
#[tauri::command]
fn set_paused(paused: bool) {
    integrations::set_paused(paused);
}

// ── Claude Code hooks ─────────────────────────────────────────────────────────

#[tauri::command]
fn hooks_status() -> HookStatus {
    hooks::status()
}

/// Returns the diff the user has to look at before anything is written.
#[tauri::command]
fn hooks_preview(install: bool) -> Result<HookPreview, String> {
    hooks::preview(install)
}

/// Only ever called from an explicit click in the settings window.
#[tauri::command]
fn hooks_apply(
    app: AppHandle,
    shared: State<Shared>,
    install: bool,
    fingerprint: String,
) -> Result<String, String> {
    // The fingerprint comes from the preview the user actually looked at, so a
    // settings.json that changed in between is refused rather than overwritten.
    let backup = hooks::write(install, &fingerprint)?;
    let updated = {
        let mut current = shared.settings.lock().unwrap();
        current.hooks_installed = install;
        let _ = settings::save(&current);
        current.clone()
    };
    let _ = app.emit("settings-changed", updated);
    Ok(backup)
}

#[tauri::command]
fn approval_decision(app: AppHandle, request_id: String, decision: String) {
    pipe::answer(&app, &request_id, &decision);
}

/// The island has the card on screen, so the long wait for a human may begin.
/// Until this arrives the relay only waits a few hundred milliseconds, which is
/// what stops a paused or unresponsive island from freezing Claude Code.
#[tauri::command]
fn approval_ack(app: AppHandle, request_id: String) {
    pipe::acknowledge(&app, &request_id);
}

/// Nobody can act on this request — the island is paused, or another card is
/// already up. Claude Code falls back to asking in the terminal immediately.
#[tauri::command]
fn approval_decline(app: AppHandle, request_id: String) {
    pipe::decline(&app, &request_id);
}

// ── Chat, files and secrets ───────────────────────────────────────────────────

/// One chat turn. The API key and any file bytes stay on the Rust side.
#[tauri::command]
async fn chat_send(
    shared: State<'_, Shared>,
    chat: State<'_, Chat>,
    query: String,
    context: Option<ChatContext>,
) -> Result<ChatReply, String> {
    let cfg = {
        let s = shared.settings.lock().unwrap();
        claude::AiConfig {
            provider: s.ai_provider.clone(),
            base_url: s.ai_base_url.clone(),
            model: s.model.clone(),
        }
    };
    claude::send(&chat, &cfg, query, context).await
}

#[tauri::command]
fn chat_reset(chat: State<Chat>) {
    chat.reset();
}

/// Copies a dropped file into the inbox and reports its name back.
#[tauri::command]
fn ingest_file(path: String) -> Result<DroppedFile, String> {
    files::ingest(&path)
}

/// The island may only ask whether a key exists — never read it.
#[tauri::command]
fn secret_present(key: String) -> bool {
    secrets::present(&key)
}

#[tauri::command]
fn secret_set(key: String, value: String) -> Result<(), String> {
    secrets::set(&key, &value)
}

#[tauri::command]
fn secret_clear(key: String) -> Result<(), String> {
    secrets::clear(&key)
}

/// Opens the configured n8n instance — the URL lives in the Credential Manager.
#[tauri::command]
fn open_n8n() {
    if let Some(url) = secrets::get("n8n-url") {
        open_url(url);
    }
}

/// Refresh buttons in the integration cards.
#[tauri::command]
async fn refresh_integration(app: AppHandle, id: String) {
    integrations::poll_once(app, &id).await;
}

/// Lets the island write to the same log as the Rust side.
#[tauri::command]
fn log_line(message: String) {
    log::line(format!("ui  {message}"));
}

// ── Settings window ───────────────────────────────────────────────────────────

/// WebView2 allows exactly one browser environment per app, and its options are
/// fixed by whichever webview is created first. Every window must therefore ask
/// for the *same* arguments as the island (see `additionalBrowserArgs` in
/// tauri.conf.json) — a mismatch makes the second window come up blank, with no
/// error anywhere.
pub const BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required --js-flags=--max-old-space-size=384";

/// In a dev build the pages are served by Vite, so the second window needs the
/// absolute dev URL; a bundled build resolves it inside the app bundle.
fn settings_page_url(app: &AppHandle) -> WebviewUrl {
    #[cfg(dev)]
    if let Some(mut base) = app.config().build.dev_url.clone() {
        base.set_path("/settings.html");
        return WebviewUrl::External(base);
    }
    let _ = app;
    WebviewUrl::App("settings.html".into())
}

/// The settings window is created hidden at launch and only ever shown and
/// hidden afterwards. A WebView2 window created later — on the main thread or
/// not — silently comes up blank in this app, so the window that works is the
/// one that exists before the island's webview does.
fn create_settings_window(app: &AppHandle) {
    let url = settings_page_url(app);
    match WebviewWindowBuilder::new(app, "settings", url)
        .additional_browser_args(BROWSER_ARGS)
        .title("Settings — Coucou")
        .inner_size(560.0, 680.0)
        .min_inner_size(460.0, 480.0)
        .resizable(true)
        .visible(false)
        .center()
        .build()
    {
        Ok(win) => {
            // Closing it must only hide it, or it could never be reopened.
            let hidden = win.clone();
            win.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = hidden.hide();
                }
            });
        }
        Err(err) => log::line(format!("settings window failed: {err}")),
    }
}

pub fn show_settings_window(app: &AppHandle) {
    let Some(win) = app.get_webview_window("settings") else {
        log::line("settings window missing");
        return;
    };
    let _ = win.unminimize();
    let _ = win.show();
    let _ = win.set_focus();
}

#[tauri::command]
fn open_settings_window(app: AppHandle) {
    show_settings_window(&app);
}

pub fn run() {
    platform::prepare_environment();
    let loaded = settings::load();
    let gate = Arc::new(PollGate::new());

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // The "Knowura AI" Start menu entry runs `coucou.exe --knowura`.
            if argv.iter().any(|a| a == "--knowura") {
                knowura::open_full(app, "/");
            } else {
                let _ = app.emit_to(island::WINDOW_LABEL, "tray", "open".to_string());
            }
        }))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(Shared {
            settings: Mutex::new(loaded.clone()),
            gate: gate.clone(),
        })
        .manage(Pending::default())
        .manage(Chat::default())
        .manage(Knowura::default())
        .invoke_handler(tauri::generate_handler![
            boot,
            save_settings,
            set_collapsed,
            knowura_open,
            knowura_attach,
            knowura_sign_in_browser,
            music_state,
            privacy_state,
            weather_search,
            weather_get,
            music_control,
            set_island_rect,
            focus_window,
            reposition,
            open_url,
            open_in_vscode,
            open_changed_file,
            desktop_mochi_drag,
            desktop_mochi_home,
            desktop_mochi_pick_up,
            desktop_mochi_alert,
            quit_app,
            hooks_status,
            hooks_preview,
            hooks_apply,
            approval_decision,
            approval_ack,
            approval_decline,
            log_line,
            chat_send,
            chat_reset,
            ingest_file,
            secret_present,
            secret_set,
            secret_clear,
            refresh_integration,
            open_n8n,
            open_settings_window,
            set_paused,
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            tray::build(&handle, loaded.assistant_mode == "knowura", loaded.autostart)?;
            // Before the island: see create_settings_window.
            create_settings_window(&handle);

            if let Some(win) = island::window(&handle) {
                platform::make_non_activating(&win);
                platform::set_taskbar_visible(&win, loaded.show_in_taskbar);
                island::apply_geometry(&handle, &loaded.screen, false);
                let _ = win.show();
                island::enforce_taskbar_style_soon(&handle);
            }
            gate.collapsed.store(false, Ordering::Relaxed);
            // Nothing drawn yet, so nothing takes the mouse until the page
            // reports the island's shape.
            if !platform::CURSOR_POLL {
                island::refresh_click_through(&handle, &gate);
            }
            gate.set_active(true);
            island::spawn_cursor_poll(handle.clone(), gate.clone());

            log::line(format!("--- Coucou {} started ---", env!("CARGO_PKG_VERSION")));
            if loaded.assistant_mode == "knowura" {
                knowura::register_hotkey(&handle);
            }
            // Started from the "Knowura AI" Start menu entry: show the full app once the
            // island's own web view is up (the window borrows its user agent).
            if std::env::args().any(|a| a == "--knowura") {
                let h = handle.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(2500));
                    knowura::open_full(&h, "/");
                });
            }
            music::start(handle.clone());
            hooks::ensure_hook_exe(&handle);
            pipe::start(handle.clone());
            integrations::start(handle.clone());
            github::start(handle.clone());
            desktop::start(handle.clone());
            desktop::register_hotkey(&handle);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Coucou");
}
