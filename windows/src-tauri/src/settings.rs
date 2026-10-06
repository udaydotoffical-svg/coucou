// Preferences, stored as plain JSON in settings.json under platform::config_dir().
// No secret ever lands here — API keys live in the OS keychain (see secrets.rs).

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub sound_enabled: bool,
    pub sound_volume: f64,
    pub auto_close_interval: f64,
    pub absence_interval: f64,
    pub active_integrations: Vec<String>,
    /// "primary" = the main display, "cursor" = whichever display the mouse is on.
    pub screen: String,
    pub autostart: bool,
    pub hooks_installed: bool,
    /// Claude model used by the chat. Changeable in the settings window.
    /// Defaulted explicitly so a settings.json written by an older build still loads.
    #[serde(default = "default_model")]
    pub model: String,
    /// "anthropic" or "openai" (any OpenAI-compatible endpoint).
    #[serde(default = "default_provider")]
    pub ai_provider: String,
    /// Base URL of an OpenAI-compatible API, e.g. https://api.openai.com/v1.
    #[serde(default)]
    pub ai_base_url: String,
    /// Width of the open island, logical px.
    #[serde(default = "default_island_width")]
    pub island_width: f64,
    /// Height added to (or, when negative, taken from) the open island's text
    /// views, logical px.
    #[serde(default)]
    pub island_height_extra: f64,
    /// Height of the closed (compact) island, logical px.
    #[serde(default = "default_compact_height")]
    pub compact_height: f64,
    /// "knowura" hosts the Knowura assistant in place of the chat; "mochi" keeps
    /// the built-in chat.
    #[serde(default = "default_assistant_mode")]
    pub assistant_mode: String,
    /// Which avatar is selected (the big one) when Coucou starts; empty = VS Code.
    #[serde(default)]
    pub main_avatar: String,
    /// The two small squares of the overview: which unselected avatars they hold.
    /// An empty entry picks one automatically.
    #[serde(default = "two_empty")]
    pub square_slots: Vec<String>,
    /// While music plays, show the album art on the closed island.
    #[serde(default = "yes")]
    pub show_music_on_notch: bool,
    /// Mochi wears headphones while music plays.
    #[serde(default = "yes")]
    pub mochi_headphones: bool,
    /// Colour overrides for individual Mochis: avatar id → "#rrggbb".
    #[serde(default)]
    pub mochi_colors: HashMap<String, String>,
    /// Weather: the city chosen in the settings (empty = none yet) and where it is.
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
    /// The small integration pills beside Mochi on the closed island.
    #[serde(default = "yes")]
    pub show_mini_pills: bool,
    /// Close the open island, and the Knowura panel, when you click anywhere else.
    #[serde(default = "yes")]
    pub close_on_click_outside: bool,
    /// Open when the pointer rests on the island, close when it leaves.
    #[serde(default)]
    pub open_on_hover: bool,
    /// When off, the island never closes or hides by itself.
    #[serde(default = "yes")]
    pub auto_hide: bool,
    #[serde(default = "yes")]
    pub always_on_top: bool,
    #[serde(default)]
    pub show_in_taskbar: bool,
}

pub const ISLAND_WIDTH_MIN: f64 = 560.0;
pub const ISLAND_WIDTH_MAX: f64 = 1100.0;
pub const COMPACT_HEIGHT_MIN: f64 = 16.0;
pub const COMPACT_HEIGHT_MAX: f64 = 48.0;
pub const ISLAND_HEIGHT_EXTRA_MIN: f64 = -60.0;
pub const ISLAND_HEIGHT_EXTRA_MAX: f64 = 200.0;

fn default_model() -> String {
    crate::claude::DEFAULT_MODEL.to_string()
}

fn default_provider() -> String {
    "anthropic".into()
}

fn two_empty() -> Vec<String> {
    vec![String::new(), String::new()]
}

fn default_assistant_mode() -> String {
    "knowura".into()
}

fn default_compact_height() -> f64 {
    32.0
}

fn default_island_width() -> f64 {
    640.0
}

fn yes() -> bool {
    true
}

impl Settings {
    /// Keeps hand-edited or stale values inside what the island can draw.
    pub fn sanitized(mut self) -> Self {
        self.island_width = self.island_width.clamp(ISLAND_WIDTH_MIN, ISLAND_WIDTH_MAX);
        self.island_height_extra =
            self.island_height_extra.clamp(ISLAND_HEIGHT_EXTRA_MIN, ISLAND_HEIGHT_EXTRA_MAX);
        self.compact_height = self.compact_height.clamp(COMPACT_HEIGHT_MIN, COMPACT_HEIGHT_MAX);
        self.mochi_colors.retain(|id, c| {
            id.len() <= 48
                && c.len() == 7
                && c.starts_with('#')
                && c[1..].chars().all(|ch| ch.is_ascii_hexdigit())
        });
        if self.mochi_colors.len() > 24 {
            self.mochi_colors.clear();
        }
        self.weather_place.truncate(80);
        self.weather_lat = self.weather_lat.clamp(-90.0, 90.0);
        self.weather_lon = self.weather_lon.clamp(-180.0, 180.0);
        self.square_slots.resize(2, String::new());
        for slot in self.square_slots.iter_mut().chain(std::iter::once(&mut self.main_avatar)) {
            slot.truncate(48);
        }
        if self.assistant_mode != "mochi" {
            self.assistant_mode = default_assistant_mode();
        }
        if self.ai_provider != "openai" {
            self.ai_provider = default_provider();
        }
        self.ai_base_url = self.ai_base_url.trim().to_string();
        self
    }
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            sound_enabled: true,
            sound_volume: 0.12,
            auto_close_interval: 15.0,
            absence_interval: 180.0,
            active_integrations: vec![
                "integration_resend".into(),
                "integration_n8n".into(),
                "integration_vercel".into(),
                "integration_github".into(),
            ],
            screen: "primary".into(),
            autostart: false,
            hooks_installed: false,
            model: default_model(),
            ai_provider: default_provider(),
            ai_base_url: String::new(),
            island_width: default_island_width(),
            island_height_extra: 0.0,
            compact_height: default_compact_height(),
            assistant_mode: default_assistant_mode(),
            main_avatar: String::new(),
            square_slots: two_empty(),
            show_music_on_notch: true,
            mochi_headphones: true,
            mochi_colors: HashMap::new(),
            weather_place: String::new(),
            weather_lat: 0.0,
            weather_lon: 0.0,
            weather_fahrenheit: false,
            show_weather: true,
            show_mini_pills: true,
            close_on_click_outside: true,
            open_on_hover: false,
            auto_hide: true,
            always_on_top: true,
            show_in_taskbar: false,
        }
    }
}

pub use crate::platform::{config_dir, local_dir};

pub fn hook_exe_path() -> PathBuf {
    local_dir().join("bin").join(crate::platform::HOOK_EXE)
}

fn settings_path() -> PathBuf {
    config_dir().join("settings.json")
}

pub fn load() -> Settings {
    match std::fs::read(settings_path()) {
        Ok(bytes) => serde_json::from_slice::<Settings>(&bytes)
            .unwrap_or_default()
            .sanitized(),
        Err(_) => Settings::default(),
    }
}

pub fn save(settings: &Settings) -> std::io::Result<()> {
    let dir = config_dir();
    crate::platform::ensure_private_dir(&dir)?;
    let json = serde_json::to_vec_pretty(settings)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    std::fs::write(settings_path(), json)
}
