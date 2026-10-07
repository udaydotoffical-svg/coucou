// Coucou for Android — the commands the page calls. The chat and the weather are the very
// same code as Coucou for Windows (they are included from there, not copied).

#[path = "../../../windows/src-tauri/src/claude.rs"]
mod claude;
#[path = "../../../windows/src-tauri/src/weather.rs"]
mod weather;
mod secrets;
mod store;

use std::sync::Mutex;

use tauri::{Manager, State};

use claude::{AiConfig, Chat, ChatReply};
use store::Settings;

struct Shared {
    settings: Mutex<Settings>,
}

#[tauri::command]
fn boot(shared: State<Shared>) -> Settings {
    shared.settings.lock().unwrap().clone()
}

#[tauri::command]
fn save_settings(shared: State<Shared>, settings: Settings) -> Result<(), String> {
    let settings = settings.sanitized();
    store::save(&settings)?;
    *shared.settings.lock().unwrap() = settings;
    Ok(())
}

/// The page may write a key and ask whether one exists — never read it back.
#[tauri::command]
fn secret_set(key: String, value: String) -> Result<(), String> {
    store::secret_set(&key, &value)
}

#[tauri::command]
fn secret_present(key: String) -> bool {
    store::secret_get(&key).is_some()
}

#[tauri::command]
async fn chat_send(
    shared: State<'_, Shared>,
    chat: State<'_, Chat>,
    query: String,
) -> Result<ChatReply, String> {
    let cfg = {
        let s = shared.settings.lock().unwrap();
        AiConfig {
            provider: s.ai_provider.clone(),
            base_url: s.ai_base_url.clone(),
            model: s.model.clone(),
        }
    };
    claude::send(&chat, &cfg, query, None).await
}

#[tauri::command]
fn chat_reset(chat: State<Chat>) {
    chat.reset();
}

#[tauri::command]
async fn weather_search(query: String) -> Result<Vec<weather::Place>, String> {
    weather::search(&query).await
}

#[tauri::command]
async fn weather_get(lat: f64, lon: f64, fahrenheit: bool) -> Result<weather::Weather, String> {
    weather::fetch(lat, lon, fahrenheit).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            store::init(app.path().app_data_dir()?);
            app.manage(Shared { settings: Mutex::new(store::load()) });
            app.manage(Chat::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            boot,
            save_settings,
            secret_set,
            secret_present,
            chat_send,
            chat_reset,
            weather_search,
            weather_get,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Coucou");
}
