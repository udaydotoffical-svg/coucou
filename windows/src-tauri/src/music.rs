// What is playing, and the controls for it.
//
// Windows keeps one media session per app that plays sound (Spotify, YouTube Music
// in a browser, Apple Music, VLC…) and exposes the current one: track, artist, album
// art, play state, position, and play / pause / next / previous / seek. The island
// shows it on its closed shape (the album art) and in the overview (the player).
//
// Everything is event-driven — Windows tells us when the track, the state or the
// position changes — so nothing is polled and a quiet PC costs nothing. Nothing leaves
// the machine: this only reads the local media session.

use serde::Serialize;

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct MusicInfo {
    /// There is a media session at all.
    pub active: bool,
    pub playing: bool,
    pub title: String,
    pub artist: String,
    pub album: String,
    /// The app playing it (its Windows app id).
    pub app: String,
    /// The album art as a data URL.
    pub art: Option<String>,
    /// Seconds into the track at the moment this was sent.
    pub position: f64,
    pub duration: f64,
    pub can_prev: bool,
    pub can_next: bool,
    pub can_seek: bool,
    pub can_toggle: bool,
    pub shuffle: bool,
    /// "none" | "list" | "track"
    pub repeat: String,
    pub can_shuffle: bool,
    pub can_repeat: bool,
}

#[cfg(windows)]
pub use imp::{control, start, state};

#[cfg(not(windows))]
pub fn start(_app: tauri::AppHandle) {}
#[cfg(not(windows))]
pub fn control(_action: String) {}
#[cfg(not(windows))]
pub fn state() -> MusicInfo {
    MusicInfo::default()
}

#[cfg(windows)]
mod imp {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Mutex, OnceLock};
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    use tauri::{AppHandle, Emitter};
    use windows::core::Interface;
    use windows::Foundation::TypedEventHandler;
    use windows::Media::MediaPlaybackAutoRepeatMode as Repeat;
    use windows::Media::Control::{
        GlobalSystemMediaTransportControlsSession as Session,
        GlobalSystemMediaTransportControlsSessionManager as Manager,
        GlobalSystemMediaTransportControlsSessionMediaProperties as Props,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
    };
    use windows::Storage::Streams::{DataReader, IInputStream, IRandomAccessStream};
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

    use super::MusicInfo;
    use crate::island::WINDOW_LABEL;
    use crate::log;

    /// Windows' DateTime counts 100 ns ticks from 1601; Unix time from 1970.
    const EPOCH_GAP_SECS: u64 = 11_644_473_600;
    /// Albums arts are small; anything bigger is not worth holding.
    const MAX_ART_BYTES: u32 = 4_000_000;

    struct Subscription {
        app_id: String,
        session: Session,
        tokens: [i64; 3],
    }

    struct Hub {
        app: AppHandle,
        manager: Manager,
        sub: Option<Subscription>,
        art_key: String,
        art: Option<String>,
        last: MusicInfo,
    }

    static HUB: OnceLock<Mutex<Hub>> = OnceLock::new();
    /// Events arrive in bursts (a seek fires several): one refresh answers them all.
    static PENDING: AtomicBool = AtomicBool::new(false);

    fn init_com() {
        // The media session objects live in the multithreaded apartment.
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
    }

    pub fn start(app: AppHandle) {
        let spawned = std::thread::Builder::new().name("music".into()).spawn(move || {
            init_com();
            let setup = || -> windows::core::Result<()> {
                let manager = Manager::RequestAsync()?.get()?;
                manager.CurrentSessionChanged(&TypedEventHandler::new(|_, _| {
                    on_event();
                    Ok(())
                }))?;
                let _ = HUB.set(Mutex::new(Hub {
                    app,
                    manager,
                    sub: None,
                    art_key: String::new(),
                    art: None,
                    last: MusicInfo::default(),
                }));
                Ok(())
            };
            match setup() {
                Ok(()) => {
                    refresh();
                    // Keeps the apartment, and with it the event handlers, alive.
                    loop {
                        std::thread::park();
                    }
                }
                Err(err) => log::line(format!("music: no media session available: {err}")),
            }
        });
        if let Err(err) = spawned {
            log::line(format!("music: could not start: {err}"));
        }
    }

    pub fn state() -> MusicInfo {
        HUB.get().map(|h| h.lock().unwrap().last.clone()).unwrap_or_default()
    }

    /// Windows says something changed: answer once the burst is over.
    fn on_event() {
        if PENDING.swap(true, Ordering::SeqCst) {
            return;
        }
        std::thread::spawn(|| {
            std::thread::sleep(Duration::from_millis(300));
            PENDING.store(false, Ordering::SeqCst);
            init_com();
            refresh();
        });
    }

    fn refresh() {
        let Some(hub) = HUB.get() else { return };
        let mut hub = hub.lock().unwrap();
        let info = read(&mut hub).unwrap_or_default();
        hub.last = info.clone();
        let _ = hub.app.emit_to(WINDOW_LABEL, "music", info);
    }

    fn read(hub: &mut Hub) -> windows::core::Result<MusicInfo> {
        let session = hub.manager.GetCurrentSession()?;
        subscribe(hub, &session)?;

        let props = session.TryGetMediaPropertiesAsync()?.get()?;
        let title = props.Title()?.to_string();
        let artist = props.Artist()?.to_string();
        let album = props.AlbumTitle()?.to_string();
        let app_id = session.SourceAppUserModelId()?.to_string();

        let playback = session.GetPlaybackInfo()?;
        let playing = playback.PlaybackStatus()? == Status::Playing;
        let controls = playback.Controls()?;
        let shuffle = playback.IsShuffleActive().ok().and_then(|v| v.Value().ok()).unwrap_or(false);
        let repeat = match playback.AutoRepeatMode().ok().and_then(|v| v.Value().ok()) {
            Some(Repeat::Track) => "track",
            Some(Repeat::List) => "list",
            _ => "none",
        };

        let timeline = session.GetTimelineProperties()?;
        let secs = |t: windows::Foundation::TimeSpan| t.Duration as f64 / 1e7;
        let start = secs(timeline.StartTime()?);
        let duration = (secs(timeline.EndTime()?) - start).max(0.0);
        let mut position = secs(timeline.Position()?) - start;
        if playing {
            // The position is a snapshot taken when the app last reported: carry it to now.
            let now_ticks = (SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_secs_f64())
                .unwrap_or(0.0)
                + EPOCH_GAP_SECS as f64)
                * 1e7;
            let reported = timeline.LastUpdatedTime()?.UniversalTime as f64;
            position += ((now_ticks - reported) / 1e7).clamp(0.0, 6.0 * 3600.0);
        }
        if duration > 0.0 {
            position = position.min(duration);
        }
        let position = position.max(0.0);

        let key = format!("{app_id}|{title}|{artist}|{album}");
        if key != hub.art_key {
            hub.art = fetch_art(&props);
            hub.art_key = key;
        }

        Ok(MusicInfo {
            active: true,
            playing,
            title,
            artist,
            album,
            app: app_id,
            art: hub.art.clone(),
            position,
            duration,
            can_prev: controls.IsPreviousEnabled().unwrap_or(false),
            can_next: controls.IsNextEnabled().unwrap_or(false),
            can_seek: controls.IsPlaybackPositionEnabled().unwrap_or(false),
            can_toggle: controls.IsPlayPauseToggleEnabled().unwrap_or(true),
            shuffle,
            repeat: repeat.to_string(),
            can_shuffle: controls.IsShuffleEnabled().unwrap_or(false),
            can_repeat: controls.IsRepeatEnabled().unwrap_or(false),
        })
    }

    /// Follows the current session: its track, state and position all report here.
    fn subscribe(hub: &mut Hub, session: &Session) -> windows::core::Result<()> {
        let app_id = session.SourceAppUserModelId()?.to_string();
        if hub.sub.as_ref().map(|s| s.app_id == app_id).unwrap_or(false) {
            return Ok(());
        }
        if let Some(old) = hub.sub.take() {
            let _ = old.session.RemoveMediaPropertiesChanged(old.tokens[0]);
            let _ = old.session.RemovePlaybackInfoChanged(old.tokens[1]);
            let _ = old.session.RemoveTimelinePropertiesChanged(old.tokens[2]);
        }
        let t0 = session.MediaPropertiesChanged(&TypedEventHandler::new(|_, _| {
            on_event();
            Ok(())
        }))?;
        let t1 = session.PlaybackInfoChanged(&TypedEventHandler::new(|_, _| {
            on_event();
            Ok(())
        }))?;
        let t2 = session.TimelinePropertiesChanged(&TypedEventHandler::new(|_, _| {
            on_event();
            Ok(())
        }))?;
        hub.sub = Some(Subscription { app_id, session: session.clone(), tokens: [t0, t1, t2] });
        Ok(())
    }

    fn fetch_art(props: &Props) -> Option<String> {
        let stream = props.Thumbnail().ok()?.OpenReadAsync().ok()?.get().ok()?;
        let random: IRandomAccessStream = stream.cast().ok()?;
        let size = random.Size().ok()? as u32;
        if size == 0 || size > MAX_ART_BYTES {
            return None;
        }
        let input: IInputStream = stream.cast().ok()?;
        let reader = DataReader::CreateDataReader(&input).ok()?;
        reader.LoadAsync(size).ok()?.get().ok()?;
        let mut bytes = vec![0u8; size as usize];
        reader.ReadBytes(&mut bytes).ok()?;
        let mime = stream.ContentType().map(|m| m.to_string()).unwrap_or_default();
        let mime = if mime.starts_with("image/") { mime } else { "image/jpeg".into() };
        Some(format!("data:{mime};base64,{}", crate::claude::base64_for(&bytes)))
    }

    /// "toggle" | "play" | "pause" | "next" | "prev" | "shuffle" | "repeat" | "seek:<seconds>"
    pub fn control(action: String) {
        std::thread::spawn(move || {
            init_com();
            let run = || -> windows::core::Result<()> {
                let session = Manager::RequestAsync()?.get()?.GetCurrentSession()?;
                match action.as_str() {
                    "toggle" => {
                        let _ = session.TryTogglePlayPauseAsync()?.get()?;
                    }
                    "play" => {
                        let _ = session.TryPlayAsync()?.get()?;
                    }
                    "pause" => {
                        let _ = session.TryPauseAsync()?.get()?;
                    }
                    "next" => {
                        let _ = session.TrySkipNextAsync()?.get()?;
                    }
                    "prev" => {
                        let _ = session.TrySkipPreviousAsync()?.get()?;
                    }
                    "shuffle" => {
                        let on = session
                            .GetPlaybackInfo()?
                            .IsShuffleActive()
                            .ok()
                            .and_then(|v| v.Value().ok())
                            .unwrap_or(false);
                        let _ = session.TryChangeShuffleActiveAsync(!on)?.get()?;
                    }
                    "repeat" => {
                        // off → repeat the list → repeat the track → off
                        let current = session
                            .GetPlaybackInfo()?
                            .AutoRepeatMode()
                            .ok()
                            .and_then(|v| v.Value().ok())
                            .unwrap_or(Repeat::None);
                        let next = match current {
                            Repeat::None => Repeat::List,
                            Repeat::List => Repeat::Track,
                            _ => Repeat::None,
                        };
                        let _ = session.TryChangeAutoRepeatModeAsync(next)?.get()?;
                    }
                    other => {
                        if let Some(secs) = other.strip_prefix("seek:").and_then(|s| s.parse::<f64>().ok()) {
                            let ticks = (secs.max(0.0) * 1e7) as i64;
                            let _ = session.TryChangePlaybackPositionAsync(ticks)?.get()?;
                        }
                    }
                }
                Ok(())
            };
            if let Err(err) = run() {
                log::line(format!("music: {action} failed: {err}"));
            }
            // The events will say so too, but the buttons should feel instant.
            std::thread::sleep(Duration::from_millis(250));
            refresh();
        });
    }
}
