// Knowura Speak: hold Ctrl+Win, talk, let go, and the words are typed where you were typing.
//
// * A low-level keyboard hook (only installed while the feature is on) watches for Ctrl and Win
//   held together. Held for a moment with nothing else pressed it means "listen": a quick tap of
//   Win, or Ctrl+Win+Arrow to switch desktops, is left to Windows.
// * While it is held the default microphone is recorded and a small Mochi with headphones appears
//   above your text caret (or where the pointer is, in apps that do not report a caret).
// * On release the audio goes through Whisper on this PC (src/whisper.rs) and the text is typed
//   into whatever has the focus. The audio never leaves the machine and is never written to disk.

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM};
use windows::Win32::Graphics::Gdi::ClientToScreen;
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE,
    VIRTUAL_KEY,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, GetCursorPos, GetForegroundWindow, GetGUIThreadInfo, GetMessageW,
    GetWindowThreadProcessId, PostThreadMessageW, SetWindowsHookExW, TranslateMessage, UnhookWindowsHookEx,
    GUITHREADINFO, HHOOK, KBDLLHOOKSTRUCT, MSG, WH_KEYBOARD_LL, WM_KEYDOWN, WM_KEYUP, WM_QUIT, WM_SYSKEYDOWN,
    WM_SYSKEYUP,
};

use crate::{log, platform, whisper};

pub const LABEL: &str = "speak";
const HOLD_MS: u64 = 180;
const MAX_SECONDS: usize = 120;
/// The overlay's size in logical pixels.
const W: f64 = 132.0;
const H: f64 = 88.0;
/// A key code nothing uses, tapped while Win is held so Windows does not open the Start menu.
const VK_NOTHING: u16 = 0xE8;

// ── Settings, as the rest of the app sees them ────────────────────────────────

fn config(app: &AppHandle) -> (bool, String, String) {
    app.try_state::<crate::Shared>()
        .map(|s| {
            let s = s.settings.lock().unwrap();
            (s.speak_enabled, s.speak_model.clone(), s.speak_language.clone())
        })
        .unwrap_or((false, "base.en".into(), "en".into()))
}

// ── Keyboard hook ─────────────────────────────────────────────────────────────

#[derive(Debug, PartialEq)]
enum Hold {
    Start,
    Stop,
    Quit,
}

static CTRL: AtomicBool = AtomicBool::new(false);
static WIN: AtomicBool = AtomicBool::new(false);
static ACTIVE: AtomicBool = AtomicBool::new(false);
/// When Ctrl and Win both went down, in ms since START_CLOCK; 0 when not pending.
static PENDING: AtomicU64 = AtomicU64::new(0);
static HOOK_THREAD: AtomicU32 = AtomicU32::new(0);
static TX: Mutex<Option<Sender<Hold>>> = Mutex::new(None);
static START_CLOCK: OnceLock<Instant> = OnceLock::new();

fn clock_ms() -> u64 {
    START_CLOCK.get_or_init(Instant::now).elapsed().as_millis() as u64 + 1
}

fn send(h: Hold) {
    if let Some(tx) = TX.lock().unwrap().as_ref() {
        let _ = tx.send(h);
    }
}

/// The hook itself: remembers which of Ctrl and Win are down and returns at once, so typing is
/// never held up. (The timing is done by `watcher`, not here.)
unsafe extern "system" fn hook_proc(code: i32, w: WPARAM, l: LPARAM) -> LRESULT {
    if code >= 0 {
        let k = unsafe { &*(l.0 as *const KBDLLHOOKSTRUCT) };
        // Our own typing and our Start-menu trick are not the user's keys.
        let injected = k.flags.0 & 0x10 != 0;
        if !injected {
            let down = matches!(w.0 as u32, WM_KEYDOWN | WM_SYSKEYDOWN);
            let up = matches!(w.0 as u32, WM_KEYUP | WM_SYSKEYUP);
            match k.vkCode {
                0xA2 | 0xA3 | 0x11 => key_state(&CTRL, down, up),
                0x5B | 0x5C => key_state(&WIN, down, up),
                // Any other key while Ctrl+Win are going down means a shortcut, not dictation.
                _ if down => PENDING.store(0, Ordering::SeqCst),
                _ => {}
            }
        }
    }
    unsafe { CallNextHookEx(None, code, w, l) }
}

fn key_state(flag: &AtomicBool, down: bool, up: bool) {
    if down {
        flag.store(true, Ordering::SeqCst);
        if CTRL.load(Ordering::SeqCst) && WIN.load(Ordering::SeqCst) && !ACTIVE.load(Ordering::SeqCst) {
            let _ = PENDING.compare_exchange(0, clock_ms(), Ordering::SeqCst, Ordering::SeqCst);
        }
    } else if up {
        flag.store(false, Ordering::SeqCst);
        PENDING.store(0, Ordering::SeqCst);
        if ACTIVE.swap(false, Ordering::SeqCst) {
            send(Hold::Stop);
        }
    }
}

/// Turns "both held for a moment, nothing else pressed" into a Start.
fn watcher(stop: Arc<AtomicBool>) {
    while !stop.load(Ordering::Relaxed) {
        std::thread::sleep(Duration::from_millis(20));
        let since = PENDING.load(Ordering::SeqCst);
        if since != 0
            && clock_ms().saturating_sub(since) >= HOLD_MS
            && CTRL.load(Ordering::SeqCst)
            && WIN.load(Ordering::SeqCst)
            && !ACTIVE.swap(true, Ordering::SeqCst)
        {
            PENDING.store(0, Ordering::SeqCst);
            neutralise_start_menu();
            send(Hold::Start);
        }
    }
}

/// Windows opens the Start menu when Win is released with no other key pressed in between. A tap
/// on a key that does nothing, while Win is still down, counts as that other key.
fn neutralise_start_menu() {
    let key = |flags| INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT { wVk: VIRTUAL_KEY(VK_NOTHING), wScan: 0, dwFlags: flags, time: 0, dwExtraInfo: 0 },
        },
    };
    let inputs = [key(Default::default()), key(KEYEVENTF_KEYUP)];
    unsafe {
        SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
    }
}

/// Runs the hook and its message loop until told to quit.
fn hook_thread(ready: Sender<bool>) {
    let hmod = unsafe { GetModuleHandleW(None) }.ok();
    let hook: HHOOK = match unsafe { SetWindowsHookExW(WH_KEYBOARD_LL, Some(hook_proc), hmod.map(|h| h.into()), 0) } {
        Ok(h) => h,
        Err(err) => {
            log::line(format!("speak: could not watch the keyboard: {err}"));
            let _ = ready.send(false);
            return;
        }
    };
    HOOK_THREAD.store(unsafe { GetCurrentThreadId() }, Ordering::SeqCst);
    let _ = ready.send(true);
    let mut msg = MSG::default();
    unsafe {
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
        let _ = UnhookWindowsHookEx(hook);
    }
    HOOK_THREAD.store(0, Ordering::SeqCst);
    CTRL.store(false, Ordering::SeqCst);
    WIN.store(false, Ordering::SeqCst);
    ACTIVE.store(false, Ordering::SeqCst);
    PENDING.store(0, Ordering::SeqCst);
}

// ── Microphone ────────────────────────────────────────────────────────────────

struct Capture {
    stream: cpal::Stream,
    samples: Arc<Mutex<Vec<f32>>>,
    rate: u32,
    level: Arc<AtomicU32>,
}

fn start_capture() -> Result<Capture, String> {
    let host = cpal::default_host();
    let device = host.default_input_device().ok_or("No microphone found.")?;
    let supported = device.default_input_config().map_err(|e| format!("The microphone refused: {e}"))?;
    let rate = supported.sample_rate().0;
    let channels = supported.channels() as usize;
    let format = supported.sample_format();
    let config: cpal::StreamConfig = supported.into();

    let samples = Arc::new(Mutex::new(Vec::<f32>::with_capacity(rate as usize * 10)));
    let level = Arc::new(AtomicU32::new(0));
    let cap = rate as usize * MAX_SECONDS;

    // Every format becomes mono f32 here.
    let sink = {
        let samples = samples.clone();
        let level = level.clone();
        move |frames: &mut dyn Iterator<Item = f32>| {
            let mut mono = Vec::new();
            let mut acc = 0f32;
            let mut n = 0usize;
            for v in frames {
                acc += v;
                n += 1;
                if n == channels {
                    mono.push(acc / channels as f32);
                    acc = 0.0;
                    n = 0;
                }
            }
            if mono.is_empty() {
                return;
            }
            let rms = (mono.iter().map(|v| v * v).sum::<f32>() / mono.len() as f32).sqrt();
            level.store(rms.to_bits(), Ordering::Relaxed);
            let mut buf = samples.lock().unwrap();
            if buf.len() < cap {
                buf.extend_from_slice(&mono);
            }
        }
    };
    let err = |e| log::line(format!("speak: microphone stream error: {e}"));
    let stream = match format {
        cpal::SampleFormat::F32 => {
            let sink = sink;
            device.build_input_stream(&config, move |d: &[f32], _| sink(&mut d.iter().copied()), err, None)
        }
        cpal::SampleFormat::I16 => {
            let sink = sink;
            device.build_input_stream(&config, move |d: &[i16], _| sink(&mut d.iter().map(|v| *v as f32 / 32768.0)), err, None)
        }
        cpal::SampleFormat::U16 => {
            let sink = sink;
            device.build_input_stream(
                &config,
                move |d: &[u16], _| sink(&mut d.iter().map(|v| (*v as f32 - 32768.0) / 32768.0)),
                err,
                None,
            )
        }
        other => return Err(format!("The microphone's sample format ({other:?}) is not supported.")),
    }
    .map_err(|e| format!("Could not open the microphone: {e}"))?;
    stream.play().map_err(|e| format!("Could not start the microphone: {e}"))?;
    Ok(Capture { stream, samples, rate, level })
}

/// Mono audio at any rate to the 16 kHz Whisper wants (linear interpolation: speech is far below
/// the band that would alias).
fn resample_16k(input: &[f32], rate: u32) -> Vec<f32> {
    if rate == 16_000 || input.is_empty() {
        return input.to_vec();
    }
    let ratio = rate as f64 / 16_000.0;
    let n = (input.len() as f64 / ratio) as usize;
    (0..n)
        .map(|i| {
            let pos = i as f64 * ratio;
            let i0 = pos as usize;
            let frac = (pos - i0 as f64) as f32;
            let a = input[i0];
            let b = *input.get(i0 + 1).unwrap_or(&a);
            a + (b - a) * frac
        })
        .collect()
}

// ── Typing ────────────────────────────────────────────────────────────────────

/// Types text into whatever has the focus, one UTF-16 unit at a time (no clipboard involved, so
/// whatever you had copied stays copied).
fn type_text(text: &str) {
    // The user may still be letting go of Ctrl or Win: typed with one of them down, letters would
    // be shortcuts.
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline {
        let held = |vk: i32| unsafe { GetAsyncKeyState(vk) } < 0;
        if !(held(0x11) || held(0x5B) || held(0x5C) || held(0xA2) || held(0xA3)) {
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let mut inputs: Vec<INPUT> = Vec::new();
    for unit in text.encode_utf16() {
        for flags in [KEYEVENTF_UNICODE, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP] {
            inputs.push(INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: VIRTUAL_KEY(0), wScan: unit, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
            });
        }
    }
    for chunk in inputs.chunks(120) {
        unsafe {
            SendInput(chunk, std::mem::size_of::<INPUT>() as i32);
        }
        std::thread::sleep(Duration::from_millis(2));
    }
}

// ── Where the text will go ────────────────────────────────────────────────────

/// The text caret in screen pixels (its top left and its height), if the focused app reports one.
fn caret() -> Option<(i32, i32, i32)> {
    unsafe {
        let fg = GetForegroundWindow();
        if fg.0.is_null() {
            return None;
        }
        let thread = GetWindowThreadProcessId(fg, None);
        let mut info = GUITHREADINFO { cbSize: std::mem::size_of::<GUITHREADINFO>() as u32, ..Default::default() };
        GetGUIThreadInfo(thread, &mut info).ok()?;
        let hwnd: HWND = info.hwndCaret;
        if hwnd.0.is_null() {
            return None;
        }
        let mut p = POINT { x: info.rcCaret.left, y: info.rcCaret.top };
        if !ClientToScreen(hwnd, &mut p).as_bool() {
            return None;
        }
        let height = (info.rcCaret.bottom - info.rcCaret.top).max(0);
        // Some apps report a zero rectangle at the window's corner when they have no caret.
        (info.rcCaret.right != 0 || info.rcCaret.bottom != 0).then_some((p.x, p.y, height))
    }
}

fn pointer() -> Option<(i32, i32)> {
    let mut p = POINT::default();
    unsafe { GetCursorPos(&mut p).ok()? };
    Some((p.x, p.y))
}

// ── The overlay ───────────────────────────────────────────────────────────────

#[derive(Serialize, Clone)]
struct Phase {
    /// "listening" | "thinking" | "done" | "silent" | "error"
    phase: &'static str,
    message: Option<String>,
}

fn overlay(app: &AppHandle) -> Option<WebviewWindow> {
    if let Some(w) = app.get_webview_window(LABEL) {
        return Some(w);
    }
    let built = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("speak.html".into()))
        .title("Knowura Speak")
        .inner_size(W, H)
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
        .additional_browser_args(crate::BROWSER_ARGS)
        .build();
    match built {
        Ok(win) => {
            // Never takes the mouse and never takes the focus: the text must keep going where it was.
            let _ = win.set_ignore_cursor_events(true);
            platform::enforce_taskbar_style(&win, false);
            platform::make_non_activating(&win);
            Some(win)
        }
        Err(err) => {
            log::line(format!("speak: could not open the overlay: {err}"));
            None
        }
    }
}

/// Places the overlay above the caret (or the pointer), kept inside the display it is on.
fn place(app: &AppHandle, win: &WebviewWindow) {
    let (cx, cy, ch) = caret().unwrap_or_else(|| {
        let (x, y) = pointer().unwrap_or((400, 400));
        (x, y, 0)
    });
    let monitors = app.available_monitors().unwrap_or_default();
    let m = monitors
        .iter()
        .find(|m| {
            let p = m.position();
            let s = m.size();
            cx >= p.x && cx < p.x + s.width as i32 && cy >= p.y && cy < p.y + s.height as i32
        })
        .cloned()
        .or_else(|| app.primary_monitor().ok().flatten());
    let scale = m.as_ref().map(|m| m.scale_factor()).unwrap_or(1.0);
    let (w, h) = ((W * scale) as i32, (H * scale) as i32);
    // Mochi's head sits at the overlay's left; the caret is just under his chin.
    let mut x = cx - (w as f64 * 0.28) as i32;
    let mut y = cy - h + (6.0 * scale) as i32;
    if let Some(m) = m {
        let (mp, ms) = (m.position(), m.size());
        x = x.clamp(mp.x + 4, (mp.x + ms.width as i32 - w - 4).max(mp.x + 4));
        // No room above the caret: below it.
        if y < mp.y + 4 {
            y = cy + ch + (8.0 * scale) as i32;
        }
        y = y.clamp(mp.y + 4, (mp.y + ms.height as i32 - h - 4).max(mp.y + 4));
    }
    let _ = win.set_position(PhysicalPosition::new(x, y));
}

fn phase(app: &AppHandle, phase: &'static str, message: Option<String>) {
    let _ = app.emit_to(LABEL, "speak-phase", Phase { phase, message });
}

// ── The loop that ties it together ────────────────────────────────────────────

struct Loaded {
    id: String,
    model: whisper::Whisper,
    last_used: Instant,
}

fn run(app: AppHandle, rx: Receiver<Hold>) {
    let mut loaded: Option<Loaded> = None;
    let mut capture: Option<Capture> = None;
    let mut started = Instant::now();

    loop {
        match rx.recv_timeout(Duration::from_millis(50)) {
            Ok(Hold::Quit) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Ok(Hold::Start) => {
                let (_, model_id, _) = config(&app);
                if !whisper::is_downloaded(&model_id) {
                    show(&app, "error", Some("Download a speech model in the settings first.".into()));
                    hide_later(&app, 2600);
                    continue;
                }
                match start_capture() {
                    Ok(c) => {
                        capture = Some(c);
                        started = Instant::now();
                        show(&app, "listening", None);
                    }
                    Err(err) => {
                        log::line(format!("speak: {err}"));
                        show(&app, "error", Some(err));
                        hide_later(&app, 2600);
                        continue;
                    }
                }
                // Loading the model while the first words are being recorded hides most of its delay.
                if loaded.as_ref().map(|l| l.id != model_id).unwrap_or(true) {
                    loaded = None;
                    match whisper::Whisper::load(&model_id) {
                        Ok(model) => loaded = Some(Loaded { id: model_id, model, last_used: Instant::now() }),
                        Err(err) => log::line(format!("speak: could not load the model: {err}")),
                    }
                }
            }
            Ok(Hold::Stop) => {
                let Some(c) = capture.take() else { continue };
                let rate = c.rate;
                drop(c.stream);
                let raw = std::mem::take(&mut *c.samples.lock().unwrap());
                let seconds = raw.len() as f32 / rate as f32;
                if seconds < 0.4 {
                    // A brush against the keys, not a sentence.
                    hide_now(&app);
                    continue;
                }
                phase(&app, "thinking", None);
                let mut pcm = resample_16k(&raw, rate);
                let rms = (pcm.iter().map(|v| v * v).sum::<f32>() / pcm.len().max(1) as f32).sqrt();
                // A quiet microphone makes Whisper guess: bring the loudest sound up to a normal level.
                let peak = pcm.iter().fold(0f32, |m, v| m.max(v.abs()));
                if peak > 0.0 && peak < 0.5 {
                    let gain = (0.6 / peak).min(30.0);
                    pcm.iter_mut().for_each(|v| *v *= gain);
                }
                log::line(format!("speak: heard {:.1}s, peak {:.3}, level {:.4}", seconds, peak, rms));
                if rms < 0.002 {
                    phase(&app, "silent", Some("I didn't hear anything.".into()));
                    hide_later(&app, 1600);
                    continue;
                }
                let (_, model_id, language) = config(&app);
                if loaded.as_ref().map(|l| l.id != model_id).unwrap_or(true) {
                    loaded = whisper::Whisper::load(&model_id).ok().map(|model| Loaded { id: model_id.clone(), model, last_used: Instant::now() });
                }
                let Some(l) = loaded.as_mut() else {
                    phase(&app, "error", Some("The speech model could not be loaded.".into()));
                    hide_later(&app, 2600);
                    continue;
                };
                let t0 = Instant::now();
                match l.model.transcribe(&pcm, &language) {
                    Ok(text) if !text.trim().is_empty() => {
                        l.last_used = Instant::now();
                        log::line(format!(
                            "speak: {:.1}s of audio → {} characters in {:.1}s",
                            seconds,
                            text.chars().count(),
                            t0.elapsed().as_secs_f32()
                        ));
                        type_text(&text);
                        phase(&app, "done", None);
                        hide_later(&app, 700);
                    }
                    Ok(_) => {
                        phase(&app, "silent", Some("I didn't catch that.".into()));
                        hide_later(&app, 1600);
                    }
                    Err(err) => {
                        log::line(format!("speak: transcription failed: {err}"));
                        phase(&app, "error", Some("Transcription failed.".into()));
                        hide_later(&app, 2600);
                    }
                }
                let _ = started;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if let Some(c) = &capture {
                    // Follow the caret and show how loud it is.
                    if let Some(win) = app.get_webview_window(LABEL) {
                        place(&app, &win);
                    }
                    let level = f32::from_bits(c.level.load(Ordering::Relaxed));
                    let _ = app.emit_to(LABEL, "speak-level", level);
                    if started.elapsed() > Duration::from_secs(MAX_SECONDS as u64) {
                        // A held key that never comes back up: stop listening.
                        send(Hold::Stop);
                    }
                }
                // The model is out of memory again after ten idle minutes.
                if let Some(l) = &loaded {
                    if capture.is_none() && l.last_used.elapsed() > Duration::from_secs(600) {
                        loaded = None;
                    }
                }
            }
        }
    }
    drop(capture);
}

fn show(app: &AppHandle, ph: &'static str, message: Option<String>) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let _ = handle;
    });
    // Built on this plain thread, like the other windows, then shown.
    let Some(win) = overlay(app) else { return };
    place(app, &win);
    let _ = win.show();
    phase(app, ph, message);
}

fn hide_now(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(LABEL) {
        let _ = win.hide();
    }
}

fn hide_later(app: &AppHandle, ms: u64) {
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(ms));
        // Not while a new recording has started in the meantime.
        if !ACTIVE.load(Ordering::SeqCst) {
            hide_now(&app);
        }
    });
}

// ── On and off ────────────────────────────────────────────────────────────────

static RUNNING: AtomicBool = AtomicBool::new(false);
static WATCH_STOP: Mutex<Option<Arc<AtomicBool>>> = Mutex::new(None);

pub fn start(app: &AppHandle) {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    let (tx, rx) = mpsc::channel::<Hold>();
    *TX.lock().unwrap() = Some(tx);
    let stop = Arc::new(AtomicBool::new(false));
    *WATCH_STOP.lock().unwrap() = Some(stop.clone());
    let (ready_tx, ready_rx) = mpsc::channel();
    std::thread::spawn(move || hook_thread(ready_tx));
    if !ready_rx.recv().unwrap_or(false) {
        RUNNING.store(false, Ordering::SeqCst);
        return;
    }
    std::thread::spawn(move || watcher(stop));
    let handle = app.clone();
    std::thread::spawn(move || run(handle, rx));
    log::line("speak: listening for Ctrl+Win".to_string());
}

pub fn stop() {
    if !RUNNING.swap(false, Ordering::SeqCst) {
        return;
    }
    if let Some(stop) = WATCH_STOP.lock().unwrap().take() {
        stop.store(true, Ordering::Relaxed);
    }
    let thread = HOOK_THREAD.load(Ordering::SeqCst);
    if thread != 0 {
        unsafe {
            let _ = PostThreadMessageW(thread, WM_QUIT, WPARAM(0), LPARAM(0));
        }
    }
    send(Hold::Quit);
    *TX.lock().unwrap() = None;
    log::line("speak: stopped".to_string());
}

/// The settings switch: the hook is only installed while Knowura Speak is on.
pub fn apply(app: &AppHandle) {
    let (on, _, _) = config(app);
    if on {
        start(app);
    } else {
        stop();
        if let Some(win) = app.get_webview_window(LABEL) {
            let _ = win.hide();
        }
    }
}

// ── Models, for the settings page ─────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelRow {
    pub id: &'static str,
    pub label: &'static str,
    pub megabytes: u32,
    pub multilingual: bool,
    pub downloaded: bool,
}

pub fn model_rows() -> Vec<ModelRow> {
    whisper::MODELS
        .iter()
        .map(|m| ModelRow {
            id: m.id,
            label: m.label,
            megabytes: m.megabytes,
            multilingual: m.multilingual,
            downloaded: whisper::is_downloaded(m.id),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resampling_keeps_the_length_and_the_shape() {
        let input: Vec<f32> = (0..48_000).map(|i| (i as f32 / 48_000.0 * 440.0 * std::f32::consts::TAU).sin()).collect();
        let out = resample_16k(&input, 48_000);
        assert!((out.len() as i32 - 16_000).abs() <= 1);
        // Still a 440 Hz tone: about 440 upward zero crossings in a second.
        let crossings = out.windows(2).filter(|w| w[0] < 0.0 && w[1] >= 0.0).count();
        assert!((crossings as i32 - 440).abs() <= 3, "{crossings}");
        assert_eq!(resample_16k(&input[..100], 16_000).len(), 100);
        assert!(resample_16k(&[], 44_100).is_empty());
    }
}
