// Mochi on the desktop: a small transparent window with the whole of Mochi in it, parked on the
// desktop. The Rust side of DesktopMochiController.swift.
//
// * He flies out of the notch to where he was last left (or to the bottom-right corner the
//   first time), and flies back with a double click, by being dropped on the island, or from the
//   tray / settings / Ctrl+Alt+D.
// * He only takes the mouse over his round body, so everything around him is click-through.
// * A drag moves him (this thread follows the cursor while the button is down, so it never
//   depends on mouse events reaching a window that keeps going click-through).
// * While an approval or a question is waiting he goes back to the notch, where the island
//   shows it, and comes out again afterwards.
// * The page inside (mochi.html) draws him and tracks the cursor; it is told where the cursor
//   is by `mochi-cursor` events from here.

use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

use crate::island::{self, WINDOW_LABEL};
use crate::platform;
use crate::log;

pub const LABEL: &str = "mochi";
/// The window's side, in logical pixels.
const SIZE: f64 = 120.0;
/// His round body: this fraction of the window is where he takes the mouse.
const BODY_RADIUS: f64 = 0.24;
const MARGIN: f64 = 24.0;
const FLIGHT_MS: u64 = 450;

/// Where in his life he is (DesktopPhase).
const HOME: u8 = 0;
const FLYING: u8 = 1;
const ON_DESKTOP: u8 = 2;
/// Gone to the notch while an alert waits; the setting stays on.
const PARKED: u8 = 3;

static PHASE: AtomicU8 = AtomicU8::new(HOME);
static DRAGGING: AtomicBool = AtomicBool::new(false);
static ALERT: AtomicBool = AtomicBool::new(false);
static POLLING: AtomicBool = AtomicBool::new(false);
/// Bumped by every flight; a flight that finds a newer number gives up.
static FLIGHT: AtomicU8 = AtomicU8::new(0);
static START: Mutex<Option<((f64, f64), (i32, i32))>> = Mutex::new(None);

#[derive(Serialize, Clone)]
struct Fade {
    to: f64,
    ms: u64,
}

fn settings_flag(app: &AppHandle) -> bool {
    app.try_state::<crate::Shared>()
        .map(|s| s.settings.lock().unwrap().desktop_mochi)
        .unwrap_or(false)
}

fn saved_position(app: &AppHandle) -> Option<(i32, i32)> {
    app.try_state::<crate::Shared>()
        .and_then(|s| s.settings.lock().unwrap().desktop_mochi_pos)
}

/// Remembers the flag (and the place) in the settings, and tells the settings page.
fn remember(app: &AppHandle, enabled: Option<bool>, pos: Option<(i32, i32)>) {
    let Some(shared) = app.try_state::<crate::Shared>() else { return };
    let snapshot = {
        let mut s = shared.settings.lock().unwrap();
        if let Some(on) = enabled {
            s.desktop_mochi = on;
        }
        if pos.is_some() {
            s.desktop_mochi_pos = pos;
        }
        s.clone()
    };
    if let Err(err) = crate::settings::save(&snapshot) {
        log::line(format!("desktop mochi: could not save settings: {err}"));
    }
    let _ = app.emit("settings-changed", snapshot);
}

// ── Geometry ──────────────────────────────────────────────────────────────────

fn size_px(app: &AppHandle) -> i32 {
    let scale = island::target_monitor(app, "primary").map(|m| m.scale_factor()).unwrap_or(1.0);
    (SIZE * scale).round() as i32
}

/// Top centre of the island's display: where he flies from and to.
fn notch_origin(app: &AppHandle) -> (i32, i32) {
    let s = size_px(app);
    match island::target_monitor(app, "primary") {
        Some(m) => (m.position().x + (m.size().width as i32 - s) / 2, m.position().y),
        None => (900, 0),
    }
}

fn default_position(app: &AppHandle) -> (i32, i32) {
    let s = size_px(app);
    let margin = (MARGIN * island::target_monitor(app, "primary").map(|m| m.scale_factor()).unwrap_or(1.0)) as i32;
    match island::target_monitor(app, "primary") {
        Some(m) => {
            let wa = m.work_area();
            (
                wa.position.x + wa.size.width as i32 - s - margin,
                wa.position.y + wa.size.height as i32 - s - margin,
            )
        }
        None => (1500, 800),
    }
}

/// Keeps the window fully inside the work area of the display it is nearest to.
fn clamp(app: &AppHandle, (x, y): (i32, i32)) -> (i32, i32) {
    let s = size_px(app);
    let Ok(monitors) = app.available_monitors() else { return (x, y) };
    let (cx, cy) = (x + s / 2, y + s / 2);
    let dist = |m: &tauri::Monitor| {
        let p = m.position();
        let sz = m.size();
        let mx = p.x + sz.width as i32 / 2;
        let my = p.y + sz.height as i32 / 2;
        ((cx - mx) as i64).pow(2) + ((cy - my) as i64).pow(2)
    };
    let Some(m) = monitors.iter().min_by_key(|m| dist(m)) else { return (x, y) };
    let wa = m.work_area();
    let margin = (MARGIN * m.scale_factor()) as i32;
    let min_x = wa.position.x + margin;
    let max_x = (wa.position.x + wa.size.width as i32 - s - margin).max(min_x);
    let min_y = wa.position.y + margin;
    let max_y = (wa.position.y + wa.size.height as i32 - s - margin).max(min_y);
    (x.clamp(min_x, max_x), y.clamp(min_y, max_y))
}

fn window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(LABEL)
}

fn build(app: &AppHandle, at: (i32, i32)) -> Option<WebviewWindow> {
    if let Some(w) = window(app) {
        return Some(w);
    }
    let built = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("mochi.html".into()))
        .title("Mochi")
        .inner_size(SIZE, SIZE)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .visible(false)
        .maximizable(false)
        .minimizable(false)
        .closable(false)
        // The same WebView2 environment as the island's: one per app, fixed by the first window.
        .additional_browser_args(crate::BROWSER_ARGS)
        .build();
    match built {
        Ok(win) => {
            let _ = win.set_position(PhysicalPosition::new(at.0, at.1));
            let _ = win.set_size(PhysicalSize::new(size_px(app) as u32, size_px(app) as u32));
            let _ = win.set_ignore_cursor_events(true);
            platform::enforce_taskbar_style(&win, false);
            let _ = win.show();
            keep_out_of_taskbars(app);
            Some(win)
        }
        Err(err) => {
            log::line(format!("desktop mochi: could not open the window: {err}"));
            None
        }
    }
}

/// tao rewrites the window's extended style whenever a flag flips, which would put him in the
/// taskbar and in docks like Seelen UI; put it back once those changes have landed.
fn keep_out_of_taskbars(app: &AppHandle) {
    let handle = app.clone();
    std::thread::spawn(move || {
        for delay in [0u64, 250, 800] {
            std::thread::sleep(Duration::from_millis(delay));
            let inner = handle.clone();
            let _ = handle.run_on_main_thread(move || {
                if let Some(win) = inner.get_webview_window(LABEL) {
                    platform::enforce_taskbar_style(&win, false);
                }
            });
        }
    });
}

fn ease_in_out(t: f64) -> f64 {
    if t < 0.5 { 4.0 * t * t * t } else { 1.0 - (-2.0 * t + 2.0).powi(3) / 2.0 }
}

/// Moves the window from one point to another in a flight of `FLIGHT_MS`, fading as asked.
/// Gives up if another flight (or a drag) starts meanwhile. Blocks the calling thread.
fn fly(app: &AppHandle, from: (i32, i32), to: (i32, i32), fade_to: Option<f64>) -> bool {
    let id = FLIGHT.fetch_add(1, Ordering::SeqCst).wrapping_add(1);
    if let Some(a) = fade_to {
        let _ = app.emit_to(LABEL, "mochi-fade", Fade { to: a, ms: FLIGHT_MS });
    }
    let start = Instant::now();
    loop {
        if FLIGHT.load(Ordering::SeqCst) != id || DRAGGING.load(Ordering::Relaxed) {
            return false;
        }
        let t = (start.elapsed().as_millis() as f64 / FLIGHT_MS as f64).min(1.0);
        let e = ease_in_out(t);
        let x = from.0 as f64 + (to.0 - from.0) as f64 * e;
        let y = from.1 as f64 + (to.1 - from.1) as f64 * e;
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            if let Some(w) = handle.get_webview_window(LABEL) {
                let _ = w.set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32));
            }
        });
        if t >= 1.0 {
            return true;
        }
        std::thread::sleep(Duration::from_millis(16));
    }
}

// ── Life cycle ────────────────────────────────────────────────────────────────

/// Called once at startup: if he was on the desktop when Coucou last closed, he flies out again
/// once the greeting is over.
pub fn start(app: AppHandle) {
    if !settings_flag(&app) {
        return;
    }
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(5600));
        fly_out(&app);
    });
}

/// From the notch to his place on the desktop. Does nothing if he is already out or an alert is up.
pub fn fly_out(app: &AppHandle) {
    if PHASE.load(Ordering::SeqCst) != HOME && PHASE.load(Ordering::SeqCst) != PARKED {
        return;
    }
    if ALERT.load(Ordering::Relaxed) {
        PHASE.store(PARKED, Ordering::SeqCst);
        return;
    }
    PHASE.store(FLYING, Ordering::SeqCst);
    let from = notch_origin(app);
    let target = clamp(app, saved_position(app).unwrap_or_else(|| default_position(app)));
    let app = app.clone();
    std::thread::spawn(move || {
        // Built from a plain thread, like Knowura's windows: creating a window from inside the main
        // thread's own callback can stall the event loop it has to wait for.
        log::line("desktop mochi: flying out".to_string());
        if build(&app, from).is_none() {
            PHASE.store(HOME, Ordering::SeqCst);
            return;
        }
        // The page needs a moment to load before it can fade in.
        std::thread::sleep(Duration::from_millis(350));
        if fly(&app, from, target, Some(1.0)) {
            PHASE.store(ON_DESKTOP, Ordering::SeqCst);
            remember(&app, Some(true), Some(target));
            start_polling(&app);
            if ALERT.load(Ordering::Relaxed) {
                alert_started(&app);
            }
        }
    });
}

/// Back to the notch for good: the setting goes off.
pub fn fly_home(app: &AppHandle) {
    log::line(format!("desktop mochi: going home (phase {})", PHASE.load(Ordering::SeqCst)));
    if PHASE.load(Ordering::SeqCst) != ON_DESKTOP {
        // Out of the notch but not settled yet, or already away: just make sure the setting is off.
        remember(app, Some(false), None);
        if PHASE.load(Ordering::SeqCst) == PARKED {
            PHASE.store(HOME, Ordering::SeqCst);
        }
        return;
    }
    PHASE.store(FLYING, Ordering::SeqCst);
    remember(app, Some(false), None);
    let app = app.clone();
    std::thread::spawn(move || {
        let from = window(&app)
            .and_then(|w| w.outer_position().ok())
            .map(|p| (p.x, p.y))
            .unwrap_or_else(|| notch_origin(&app));
        fly(&app, from, notch_origin(&app), Some(0.0));
        close(&app);
        let _ = app.emit_to(WINDOW_LABEL, "mochi-landed", ());
        PHASE.store(HOME, Ordering::SeqCst);
    });
}

fn close(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(w) = handle.get_webview_window(LABEL) {
            let _ = w.destroy();
        }
    });
}

/// The settings switch, the tray item, Ctrl+Alt+D.
pub fn set_enabled(app: &AppHandle, on: bool) {
    log::line(format!("desktop mochi: setting switched {}", if on { "on" } else { "off" }));
    if on {
        remember(app, Some(true), None);
        fly_out(app);
    } else {
        fly_home(app);
    }
}

pub fn toggle(app: &AppHandle) {
    let out = PHASE.load(Ordering::SeqCst) != HOME;
    set_enabled(app, !out);
}

/// Dragging Mochi out of the island: he appears under the cursor and follows it until the button
/// is released, then stays where he is let go (or flies home if let go over the island).
pub fn pick_up(app: &AppHandle) {
    if PHASE.load(Ordering::SeqCst) != HOME {
        return;
    }
    let Some((cx, cy)) = platform::cursor_physical() else { return };
    let s = size_px(app);
    let at = (cx.round() as i32 - s / 2, cy.round() as i32 - s / 2);
    PHASE.store(FLYING, Ordering::SeqCst);
    let app = app.clone();
    std::thread::spawn(move || {
        if build(&app, at).is_none() {
            PHASE.store(HOME, Ordering::SeqCst);
            return;
        }
        std::thread::sleep(Duration::from_millis(300));
        let _ = app.emit_to(LABEL, "mochi-fade", Fade { to: 1.0, ms: 150 });
        let _ = app.emit_to(LABEL, "mochi-emote", "happy");
        FLIGHT.fetch_add(1, Ordering::SeqCst);
        PHASE.store(ON_DESKTOP, Ordering::SeqCst);
        begin_drag(&app);
        start_polling(&app);
        remember(&app, Some(true), None);
    });
}

// ── Alerts ────────────────────────────────────────────────────────────────────

/// The island says an approval or a question started or stopped waiting.
pub fn set_alert(app: &AppHandle, active: bool) {
    let was = ALERT.swap(active, Ordering::Relaxed);
    if was == active {
        return;
    }
    if active {
        log::line("desktop mochi: an alert is waiting".to_string());
        if PHASE.load(Ordering::SeqCst) == ON_DESKTOP {
            alert_started(app);
        }
    } else if PHASE.load(Ordering::SeqCst) == PARKED {
        let app = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(600));
            if !ALERT.load(Ordering::Relaxed) {
                PHASE.store(HOME, Ordering::SeqCst);
                if settings_flag(&app) {
                    fly_out(&app);
                }
            }
        });
    }
}

/// Surprised, then back to the notch (the setting stays on).
fn alert_started(app: &AppHandle) {
    if PHASE.load(Ordering::SeqCst) != ON_DESKTOP {
        return;
    }
    PHASE.store(FLYING, Ordering::SeqCst);
    let app = app.clone();
    std::thread::spawn(move || {
        let _ = app.emit_to(LABEL, "mochi-emote", "surprised");
        std::thread::sleep(Duration::from_millis(450));
        if !ALERT.load(Ordering::Relaxed) {
            // Cleared before he left: he stays.
            PHASE.store(ON_DESKTOP, Ordering::SeqCst);
            return;
        }
        let from = window(&app)
            .and_then(|w| w.outer_position().ok())
            .map(|p| (p.x, p.y))
            .unwrap_or_else(|| notch_origin(&app));
        remember(&app, None, Some(from));
        fly(&app, from, notch_origin(&app), Some(0.0));
        close(&app);
        POLLING.store(false, Ordering::SeqCst);
        PHASE.store(PARKED, Ordering::SeqCst);
        // The alert may have cleared during the flight.
        if !ALERT.load(Ordering::Relaxed) {
            PHASE.store(HOME, Ordering::SeqCst);
            fly_out(&app);
        }
    });
}

// ── Click-through, drag and the cursor ────────────────────────────────────────

/// The page decided a press became a drag.
pub fn begin_drag(app: &AppHandle) {
    log::line("desktop mochi: drag started".to_string());
    let Some(w) = window(app) else { return };
    let Some(cursor) = platform::cursor_physical() else { return };
    let Ok(pos) = w.outer_position() else { return };
    *START.lock().unwrap() = Some((cursor, (pos.x, pos.y)));
    FLIGHT.fetch_add(1, Ordering::SeqCst);
    DRAGGING.store(true, Ordering::SeqCst);
}

/// Is this screen point over the island as it is drawn right now (with a margin)? Closed, the
/// island is a small pill at the top; open, it is as big as its card.
fn over_island(app: &AppHandle, x: f64, y: f64) -> bool {
    let Some(win) = island::window(app) else { return false };
    let Ok(p) = win.outer_position() else { return false };
    let scale = win.scale_factor().unwrap_or(1.0);
    let rect = app
        .try_state::<crate::Shared>()
        .map(|s| *s.gate.rect.lock().unwrap())
        .unwrap_or_default();
    let (rx, ry, rw, rh) = if rect.w > 0.0 {
        (rect.x, rect.y, rect.w, rect.h)
    } else {
        (0.0, 0.0, 300.0, 40.0)
    };
    let margin = 24.0 * scale;
    let (left, top) = (p.x as f64 + rx * scale - margin, p.y as f64 + ry * scale - margin);
    x >= left && x <= left + rw * scale + 2.0 * margin && y >= top && y <= top + rh * scale + 2.0 * margin
}

fn end_drag(app: &AppHandle) {
    DRAGGING.store(false, Ordering::SeqCst);
    let Some(w) = window(app) else { return };
    let Ok(pos) = w.outer_position() else { return };
    let s = size_px(app);
    let centre = (pos.x as f64 + s as f64 / 2.0, pos.y as f64 + s as f64 / 2.0);
    // Let go over the island: back into the notch.
    if over_island(app, centre.0, centre.1) {
        log::line("desktop mochi: let go over the island".to_string());
        fly_home(app);
        return;
    }
    let placed = clamp(app, (pos.x, pos.y));
    let _ = w.set_position(PhysicalPosition::new(placed.0, placed.1));
    remember(app, None, Some(placed));
}

fn start_polling(app: &AppHandle) {
    if POLLING.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let mut ignoring = true;
        let mut last = (f64::MIN, f64::MIN);
        while POLLING.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(16));
            let Some(win) = window(&app) else { break };
            let Some((cx, cy)) = platform::cursor_physical() else { continue };
            let down = platform::left_button_down();

            if DRAGGING.load(Ordering::Relaxed) {
                if down {
                    if let Some(((sx, sy), (ox, oy))) = *START.lock().unwrap() {
                        let target = (ox + (cx - sx).round() as i32, oy + (cy - sy).round() as i32);
                        let handle = app.clone();
                        let _ = app.run_on_main_thread(move || {
                            if let Some(w) = handle.get_webview_window(LABEL) {
                                let _ = w.set_position(PhysicalPosition::new(target.0, target.1));
                            }
                        });
                    }
                } else {
                    end_drag(&app);
                    if PHASE.load(Ordering::SeqCst) != ON_DESKTOP {
                        continue;
                    }
                }
            }

            let Ok(pos) = win.outer_position() else { continue };
            let scale = win.scale_factor().unwrap_or(1.0);
            let local = ((cx - pos.x as f64) / scale, (cy - pos.y as f64) / scale);
            let (mx, my) = (SIZE / 2.0, SIZE / 2.0);
            let r = SIZE * BODY_RADIUS;
            let over_body = (local.0 - mx).powi(2) + (local.1 - my).powi(2) <= r * r;

            // Only the body takes the mouse (or the whole of him while he is carried).
            let accept = over_body || DRAGGING.load(Ordering::Relaxed);
            if ignoring == accept {
                ignoring = !accept;
                let handle = app.clone();
                let _ = app.run_on_main_thread(move || {
                    if let Some(w) = handle.get_webview_window(LABEL) {
                        let _ = w.set_ignore_cursor_events(ignoring);
                        platform::enforce_taskbar_style(&w, false);
                    }
                });
            }

            // Where the cursor is relative to his centre, for his eyes and for sleeping.
            if (local.0 - last.0).abs() >= 1.0 || (local.1 - last.1).abs() >= 1.0 {
                last = local;
                let _ = app.emit_to(LABEL, "mochi-cursor", (local.0 - mx, local.1 - my));
            }
        }
        POLLING.store(false, Ordering::SeqCst);
    });
}

/// Keeps him on screen when the displays change (called from the island's screen-changed path).
pub fn reclamp(app: &AppHandle) {
    if PHASE.load(Ordering::SeqCst) != ON_DESKTOP {
        return;
    }
    if let Some(w) = window(app) {
        if let Ok(p) = w.outer_position() {
            let c = clamp(app, (p.x, p.y));
            if c != (p.x, p.y) {
                let _ = w.set_position(PhysicalPosition::new(c.0, c.1));
            }
        }
    }
}

/// Ctrl+Alt+D: send him out to the desktop, or bring him home.
pub fn register_hotkey(app: &AppHandle) {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
    let Ok(shortcut) = "Ctrl+Alt+D".parse::<Shortcut>() else { return };
    let handle = app.clone();
    let result = app.global_shortcut().on_shortcut(shortcut, move |_, _, event| {
        if event.state() == ShortcutState::Pressed {
            toggle(&handle);
            crate::tray::refresh(&handle);
        }
    });
    if result.is_err() {
        log::line("desktop mochi: Ctrl+Alt+D is taken by another app".to_string());
    }
}
