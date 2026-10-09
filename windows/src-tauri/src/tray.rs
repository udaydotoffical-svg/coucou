// Notification-area icon: Open, Weekly recap, Wardrobe, Settings, Pause, Quit — plus, on Windows,
// the Knowura entries (text box, voice, full app) while Knowura mode is on, and "Start with Windows".

use std::sync::Mutex;

use tauri::menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, Wry};

use crate::i18n::{n_, t};
use crate::island::WINDOW_LABEL;
use crate::knowura::{self, Mode};

const TRAY_ID: &str = "coucou";

/// The menu's items, id and English label, in order. The labels are shown in
/// the interface language (i18n.rs) and follow it when it changes.
const ITEMS: [(&str, &str); 6] = [
    ("open", n_("Open Coucou")),
    ("recap", n_("Weekly recap")),
    ("wardrobe", n_("Wardrobe…")),
    ("settings", n_("Settings…")),
    ("pause", n_("Pause")),
    ("quit", n_("Quit")),
];

/// Kept so a language change relabels the menu without rebuilding the tray.
struct Items(Mutex<Vec<(&'static str, MenuItem<Wry>)>>);

/// What the menu depends on in the settings: Knowura mode, and starting with Windows.
fn wanted(app: &AppHandle) -> (bool, bool) {
    app.try_state::<crate::Shared>()
        .map(|s| {
            let s = s.settings.lock().unwrap();
            (s.assistant_mode == "knowura", s.autostart)
        })
        .unwrap_or((false, false))
}

fn make_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let (knowura_mode, autostart) = wanted(app);
    let mut items = Vec::new();
    for (id, label) in ITEMS {
        items.push((label, MenuItem::with_id(app, id, t(label), true, None::<&str>)?));
    }
    let [open, recap, wardrobe, settings, pause, quit] = [0, 1, 2, 3, 4, 5].map(|i| &items[i].1);
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let sep3 = PredefinedMenuItem::separator(app)?;
    let start = CheckMenuItem::with_id(app, "autostart", "Start with Windows", true, autostart, None::<&str>)?;

    let menu = Menu::new(app)?;
    if knowura_mode {
        menu.append(&MenuItem::with_id(app, "kw_text", "Open Knowura (text)", true, None::<&str>)?)?;
        menu.append(&MenuItem::with_id(app, "kw_voice", "Start voice", true, None::<&str>)?)?;
        menu.append(&MenuItem::with_id(app, "kw_app", "Open the full Knowura app", true, None::<&str>)?)?;
        menu.append(&MenuItem::with_id(app, "kw_signin", "Sign in with the browser…", true, None::<&str>)?)?;
        menu.append(&sep3)?;
    }
    let all: [&dyn IsMenuItem<Wry>; 9] = [open, recap, &sep1, wardrobe, settings, pause, &start, &sep2, quit];
    for item in all {
        menu.append(item)?;
    }
    match app.try_state::<Items>() {
        Some(state) => *state.0.lock().unwrap() = items,
        None => {
            app.manage(Items(Mutex::new(items)));
        }
    }
    Ok(menu)
}

pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let menu = make_menu(app)?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("Coucou")
        .menu(&menu)
        .on_menu_event(|app: &AppHandle, event| match event.id.as_ref() {
            "quit" => app.exit(0),
            "settings" => crate::show_settings_window(app),
            "autostart" => crate::toggle_autostart(app),
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

/// The menu depends on the settings (Knowura mode, start with Windows): rebuild it.
pub fn refresh(app: &AppHandle) {
    if let (Some(tray), Ok(menu)) = (app.tray_by_id(TRAY_ID), make_menu(app)) {
        let _ = tray.set_menu(Some(menu));
    }
}

/// Relabels the menu in the current language.
pub fn retitle(app: &AppHandle) {
    let Some(items) = app.try_state::<Items>() else { return };
    for (label, item) in items.0.lock().unwrap().iter() {
        let _ = item.set_text(t(label));
    }
}
