// Settings and keys, kept in the app's private storage (no other Android app can read it).
// Same settings names as Coucou for Windows, so a setting means the same thing everywhere.
// API keys sit in their own file, are never sent to the page, and the page can only ask
// whether one is present.

use std::path::PathBuf;
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

static DIR: OnceLock<PathBuf> = OnceLock::new();

pub fn init(dir: PathBuf) {
    let _ = std::fs::create_dir_all(&dir);
    let _ = DIR.set(dir);
}

fn dir() -> PathBuf {
    DIR.get().cloned().unwrap_or_else(|| PathBuf::from("."))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(default = "yes")]
    pub sound_enabled: bool,
    #[serde(default = "volume")]
    pub sound_volume: f64,
    /// "anthropic" or "openai" (any OpenAI-compatible endpoint).
    #[serde(default = "provider")]
    pub ai_provider: String,
    #[serde(default)]
    pub ai_base_url: String,
    #[serde(default = "model")]
    pub model: String,
    /// What Mochi wears: an outfit id, "auto" (by season) or "none".
    #[serde(default = "auto")]
    pub mochi_outfit: String,
    #[serde(default)]
    pub weather_place: String,
    #[serde(default)]
    pub weather_lat: f64,
    #[serde(default)]
    pub weather_lon: f64,
    #[serde(default)]
    pub weather_fahrenheit: bool,
    #[serde(default = "yes")]
    pub show_weather: bool,
}

fn yes() -> bool { true }
fn volume() -> f64 { 0.12 }
fn provider() -> String { "anthropic".into() }
fn model() -> String { crate::claude::DEFAULT_MODEL.to_string() }
fn auto() -> String { "auto".into() }

impl Default for Settings {
    fn default() -> Self {
        serde_json::from_str("{}").expect("defaults")
    }
}

impl Settings {
    pub fn sanitized(mut self) -> Self {
        self.sound_volume = self.sound_volume.clamp(0.0, 0.2);
        if self.ai_provider != "openai" {
            self.ai_provider = "anthropic".into();
        }
        self.ai_base_url = self.ai_base_url.trim().to_string();
        self.model = self.model.trim().to_string();
        self.weather_lat = self.weather_lat.clamp(-90.0, 90.0);
        self.weather_lon = self.weather_lon.clamp(-180.0, 180.0);
        self
    }
}

pub fn load() -> Settings {
    std::fs::read_to_string(dir().join("settings.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save(settings: &Settings) -> Result<(), String> {
    let json = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    std::fs::write(dir().join("settings.json"), json).map_err(|e| e.to_string())
}

// ── Keys ─────────────────────────────────────────────────────────────────────

pub const KNOWN_KEYS: &[&str] = &["anthropic-api-key", "ai-api-key"];

fn secrets_path() -> PathBuf {
    dir().join("secrets.json")
}

fn read_all() -> Map<String, Value> {
    std::fs::read_to_string(secrets_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn secret_get(key: &str) -> Option<String> {
    read_all().get(key)?.as_str().map(str::to_string).filter(|v| !v.is_empty())
}

pub fn secret_set(key: &str, value: &str) -> Result<(), String> {
    if !KNOWN_KEYS.contains(&key) {
        return Err(format!("unknown key {key}"));
    }
    let mut all = read_all();
    if value.trim().is_empty() {
        all.remove(key);
    } else {
        all.insert(key.to_string(), Value::String(value.trim().to_string()));
    }
    let json = serde_json::to_string(&all).map_err(|e| e.to_string())?;
    std::fs::write(secrets_path(), json).map_err(|e| e.to_string())
}
