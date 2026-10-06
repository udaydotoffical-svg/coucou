// Notification-area icon: Open, Settings, Pause, Quit — plus the Knowura entries
// (text box, voice, full app) while Knowura mode is on.

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager};

use crate::island::WINDOW_LABEL;
use crate::knowura::{self, Mode};

const TRAY_ID: &str = "coucou";

fn menu(app: &AppHandle, knowura_mode: bool, autostart: bool, on_desktop: bool) -> tauri::Result<Menu<tauri::Wry>> {
    let open = MenuItem::with_id(app, "open", "Open Coucou", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
    let pause = MenuItem::with_id(app, "pause", "Pause", true, None::<&str>)?;
    let start = CheckMenuItem::with_id(app, "autostart", "Start with Windows", true, autostart, None::<&str>)?;
    let desk = CheckMenuItem::with_id(app, "desktop", "Mochi on the desktop", true, on_desktop, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

    let menu = Menu::new(app)?;
    if knowura_mode {
        menu.append(&MenuItem::with_id(app, "kw_text", "Open Knowura (text)", true, None::<&str>)?)?;
        menu.append(&MenuItem::with_id(app, "kw_voice", "Start voice", true, None::<&str>)?)?;
        menu.append(&MenuItem::with_id(app, "kw_app", "Open the full Knowura app", true, None::<&str>)?)?;
        menu.append(&MenuItem::with_id(app, "kw_signin", "Sign in with the browser…", true, None::<&str>)?)?;
        menu.append(&PredefinedMenuItem::separator(app)?)?;
    }
    menu.append(&open)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&settings)?;
    menu.append(&pause)?;
    menu.append(&start)?;
    menu.append(&desk)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&quit)?;
    Ok(menu)
}

pub fn build(app: &AppHandle, knowura_mode: bool, autostart: bool) -> tauri::Result<()> {
    let menu = menu(app, knowura_mode, autostart, false)?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("Coucou")
        .menu(&menu)
        .on_menu_event(|app: &AppHandle, event| match event.id.as_ref() {
            "quit" => app.exit(0),
            "settings" => crate::show_settings_window(app),
            "autostart" => crate::toggle_autostart(app),
            "desktop" => {
                crate::desktop::toggle(app);
                refresh(app);
            }
            "kw_text" => knowura::open(app, Mode::Text),
            "kw_voice" => knowura::open(app, Mode::Voice),
            "kw_app" => knowura::open_full(app, "/"),
            "kw_signin" => knowura::sign_in_browser(),
            id => {
                let _ = app.emit_to(WINDOW_LABEL, "tray", id.to_string());
            }
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }

    builder.build(app)?;
    Ok(())
}

/// The menu depends on the settings (Knowura mode, start with Windows).
pub fn refresh(app: &AppHandle) {
    let (knowura_mode, autostart, on_desktop) = app
        .try_state::<crate::Shared>()
        .map(|s| {
            let s = s.settings.lock().unwrap();
            (s.assistant_mode == "knowura", s.autostart, s.desktop_mochi)
        })
        .unwrap_or((false, false, false));
    if let (Some(tray), Ok(menu)) = (app.tray_by_id(TRAY_ID), menu(app, knowura_mode, autostart, on_desktop)) {
        let _ = tray.set_menu(Some(menu));
    }
}
