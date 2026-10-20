// Notification-area icon: Open, Weekly recap, Wardrobe, Settings, Pause, Quit — plus, on Windows,
// the Knowura entries (text box, voice, full app) while Knowura mode is on, the computer-use entries
// while it is on, and "Start with Windows". "Update Coucou to X…" shows under Open only while a new
// version is out (update.rs).

use std::sync::Mutex;

use tauri::menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, Wry};

use crate::i18n::{n_, t, tf};
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

/// "Update Coucou to X…": in the menu only while `version` is set. The menu is rebuilt when a setting
/// changes (`refresh`), so the one it belongs to is kept up to date here.
struct UpdateItem {
    menu: Mutex<Menu<Wry>>,
    item: MenuItem<Wry>,
    version: Mutex<Option<String>>,
}

fn update_label(version: &str) -> String {
    tf("Update Coucou to {version}…", &[("version", version)])
}

/// What the menu depends on in the settings: Knowura mode, starting with Windows, computer use.
fn wanted(app: &AppHandle) -> (bool, bool, bool) {
    app.try_state::<crate::Shared>()
        .map(|s| {
            let s = s.settings.lock().unwrap();
            (s.assistant_mode == "knowura", s.autostart, s.computer_use)
        })
        .unwrap_or((false, false, false))
}

fn make_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let (knowura_mode, autostart, computer) = wanted(app);
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
    if computer && cfg!(windows) {
        menu.append(&MenuItem::with_id(app, "computer", "Mochi: do something on my PC…", true, None::<&str>)?)?;
        menu.append(&MenuItem::with_id(app, "computer_stop", "Stop Mochi", true, None::<&str>)?)?;
        menu.append(&PredefinedMenuItem::separator(app)?)?;
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
    // The update entry belongs to whichever menu is current: put it back under Open when one is out.
    match app.try_state::<UpdateItem>() {
        Some(update) => {
            let version = update.version.lock().unwrap().clone();
            *update.menu.lock().unwrap() = menu.clone();
            if let Some(v) = version {
                let _ = update.item.set_text(update_label(&v));
                let _ = menu.insert(&update.item, update_index(&menu));
            }
        }
        None => {
            // Its click goes to the island like the others (id "update"): it opens the update card.
            let item = MenuItem::with_id(app, "update", "", true, None::<&str>)?;
            app.manage(UpdateItem { menu: Mutex::new(menu.clone()), item, version: Mutex::new(None) });
        }
    }
    Ok(menu)
}

/// Right under "Open Coucou", wherever the Knowura and computer-use entries put it.
fn update_index(menu: &Menu<Wry>) -> usize {
    menu.items()
        .ok()
        .and_then(|items| items.iter().position(|i| i.id().as_ref() == "open"))
        .map(|i| i + 1)
        .unwrap_or(1)
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
            #[cfg(windows)]
            "computer_stop" => crate::computer::stop(),
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
    if let Some(update) = app.try_state::<UpdateItem>() {
        // Copied out first: the menu calls wait for the main thread, never under the lock.
        let version = update.version.lock().unwrap().clone();
        if let Some(version) = version {
            let _ = update.item.set_text(update_label(&version));
        }
    }
}

/// Shows "Update Coucou to `version`…" right under Open, or takes it out (None).
pub fn set_update(app: &AppHandle, version: Option<&str>) {
    let Some(update) = app.try_state::<UpdateItem>() else { return };
    let was_shown = {
        let mut shown = update.version.lock().unwrap();
        if shown.as_deref() == version {
            return;
        }
        let was = shown.is_some();
        *shown = version.map(str::to_string);
        was
    };
    match version {
        Some(v) => {
            let _ = update.item.set_text(update_label(v));
            if !was_shown {
                let menu = update.menu.lock().unwrap().clone();
                let _ = menu.insert(&update.item, update_index(&menu));
            }
        }
        None => {
            let menu = update.menu.lock().unwrap().clone();
            let _ = menu.remove(&update.item);
        }
    }
}
