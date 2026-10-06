// Knowura mode: the island's chat is replaced by the hosted Knowura assistant,
// https://knowura.vercel.app/assistant.
//
// Nothing of the site is rebuilt here. The notch itself is the container:
//   * Alt+Space (or the chat tab, or the tray) tells the island to spring open, wide
//     and tall, into a big black shape — Mochi's pill becomes a Dynamic-Island-style
//     panel with a thick black bezel — while the page loads;
//   * a frameless window with the page sits inside that bezel and is revealed once
//     it has loaded; collapsing stops the microphone first, then the page leads the
//     way back into the notch, which shrinks to its pill;
//   * collapsed, nothing is loaded at all, and the notch ignores the pointer while
//     Knowura is open so Mochi never peeks out from underneath;
//   * two minutes hidden and the whole web view is destroyed to free its memory.
//
// The page talks to us through `window.KnowuraDesk` (hide, openApp) and we talk to
// it through `window.knowuraShown / knowuraMode / knowuraHidden`.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::webview::{
    NewWindowFeatures, NewWindowResponse, PageLoadEvent, PermissionKind, PermissionResponse,
};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, Url, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use crate::{island, log, platform};

pub const HOST: &str = "knowura.vercel.app";
const PANEL: &str = "knowura";
const FULL: &str = "knowura-app";
/// What the full app's window is called, and its icon (the site's own app icon).
const APP_TITLE: &str = "Knowura AI";
const APP_ICON: &[u8] = include_bytes!("../icons/knowura.png");

/// The page, and the black bezel the notch leaves around it. The island's size is
/// derived from these; src/core/layout.ts has the same numbers.
const PAGE_W: f64 = 440.0;
const PAGE_H: f64 = 580.0;
const BEZEL: f64 = 14.0;
pub const ISLAND_W: f64 = PAGE_W + 2.0 * BEZEL;
pub const ISLAND_H: f64 = PAGE_H + 2.0 * BEZEL;
/// With `transparent=1` the page draws only its card and leaves these margins around
/// it (top, right, bottom, left) for the card's hard shadow. The window is the card
/// plus the margins, so the card itself lands exactly in the notch's bezel.
const MARGIN_TOP: f64 = 14.0;
const MARGIN_RIGHT: f64 = 20.0;
const MARGIN_BOTTOM: f64 = 20.0;
const MARGIN_LEFT: f64 = 14.0;

/// The island starts growing first; the page follows a beat later so it never
/// outruns the black shape around it.
const SHOW_DELAY_MS: u64 = 80;
/// On the way back the page leads and the notch follows.
const COLLAPSE_LEAD_MS: u64 = 60;
const COLLAPSE_MS: u64 = 280;
/// The island needs about this long to finish shrinking before its window goes back to normal.
const SETTLE_MS: u64 = 520;
/// If the page has not loaded by then, give the notch back.
const LOAD_TIMEOUT: Duration = Duration::from_secs(20);
const IDLE_DESTROY: Duration = Duration::from_secs(120);
/// A blur this soon after showing is the window taking focus, not the user clicking away.
const BLUR_GRACE: Duration = Duration::from_millis(900);

/// First combo Windows lets us have wins. There is deliberately no voice hotkey.
const HOTKEYS: [&str; 2] = ["Alt+Space", "Ctrl+Alt+K"];

const FALLBACK_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0";

/// The only thing the page can ask of us. Each call is a navigation to a private
/// scheme that `allow_navigation` answers and cancels — no IPC is opened to the site.
const BRIDGE_JS: &str = r#"
(function () {
  if (window.KnowuraDesk) return;
  function ask(url) { try { window.location.href = url; } catch (e) {} }
  Object.defineProperty(window, 'KnowuraDesk', {
    value: Object.freeze({
      hide: function () { ask('knowura-desk://hide'); },
      // The random secret that links this PC to a Knowura account when you sign in
      // in a browser (the same mechanism as the Android app's ?kwdev= link).
      installId: function () { return '__INSTALL_ID__'; },
      // Opens Knowura in the default browser, carrying the install id, so signing in
      // there signs this app in too.
      signInBrowser: function () { ask('knowura-desk://signin-browser'); },
      openApp: function (path) {
        ask('knowura-desk://open?p=' + encodeURIComponent(typeof path === 'string' ? path : '/'));
      },
      platform: 'windows'
    })
  });
})();
"#;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Mode {
    Text,
    Voice,
}

impl Mode {
    pub fn parse(s: &str) -> Mode {
        if s == "voice" { Mode::Voice } else { Mode::Text }
    }
    fn as_str(self) -> &'static str {
        match self {
            Mode::Text => "text",
            Mode::Voice => "voice",
        }
    }
}

#[derive(Default)]
pub struct Knowura {
    inner: Mutex<Inner>,
    /// Bumped by every show / hide so a pending idle-destroy knows it is stale.
    epoch: AtomicU64,
    hotkey: Mutex<Option<String>>,
}

#[derive(Default)]
struct Inner {
    /// The page is on screen.
    visible: bool,
    /// The notch has been told to hold Knowura (it may still be loading).
    island_open: bool,
    /// Mode to reveal in once the page has loaded.
    pending: Option<Mode>,
    /// Mode in the URL the current page was loaded with.
    loaded: Option<Mode>,
    creating: bool,
    shown_at: Option<Instant>,
}

impl Knowura {
    pub fn hotkey(&self) -> Option<String> {
        self.hotkey.lock().unwrap().clone()
    }
}

fn state(app: &AppHandle) -> tauri::State<'_, Knowura> {
    app.state::<Knowura>()
}

fn panel_url(mode: Mode) -> Url {
    Url::parse(&format!(
        "https://{HOST}/assistant?desktop=1&mode={}&transparent=1",
        mode.as_str()
    ))
    .expect("static URL")
}

fn js_string(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into())
}

// ── What the page may do ──────────────────────────────────────────────────────

/// Numbers the sign-in pop-ups so two can be open at once.
static POPUPS: AtomicU64 = AtomicU64::new(0);

/// Google's sign-in, which Knowura uses. It stays inside the app: its pop-up has to
/// talk back to the page that opened it, which a browser window never could.
fn is_auth_host(host: &str) -> bool {
    host == "google.com"
        || host.ends_with(".google.com")
        || host.ends_with(".gstatic.com")
        || host.ends_with(".googleapis.com")
        || host == "accounts.youtube.com"
}

/// What a sign-in pop-up may visit: Google's sign-in pages and Knowura itself.
fn allow_auth_navigation(url: &Url) -> bool {
    match url.scheme() {
        "about" => url.as_str() == "about:blank",
        "https" => url
            .host_str()
            .map(|h| h == HOST || is_auth_host(h))
            .unwrap_or(false),
        _ => false,
    }
}

/// A real window for Google's sign-in pop-up, linked to the page that asked for it
/// (same web process, same profile) so the result reaches the page and the session
/// is kept.
fn open_auth_popup(
    app: &AppHandle,
    features: NewWindowFeatures,
    user_agent: &str,
) -> Option<WebviewWindow> {
    let n = POPUPS.fetch_add(1, Ordering::Relaxed);
    WebviewWindowBuilder::new(
        app,
        format!("knowura-auth-{n}"),
        WebviewUrl::External(Url::parse("about:blank").ok()?),
    )
    .title("Sign in")
    .inner_size(480.0, 680.0)
    .center()
    // After the size above: the page's own requested size wins.
    .window_features(features)
    .user_agent(user_agent)
    .on_navigation(allow_auth_navigation)
    .on_permission_request(|_, _| PermissionResponse::Deny)
    .build()
    .ok()
}

/// Keeps both windows on the site. Anything else on https goes to the default
/// browser; every other scheme is refused. The private `knowura-desk:` scheme is
/// the bridge.
fn allow_navigation(app: &AppHandle, url: &Url, bridge: bool) -> bool {
    match url.scheme() {
        "knowura-desk" => {
            if bridge {
                match url.host_str() {
                    Some("hide") => hide(app),
                    Some("signin-browser") => sign_in_browser(),
                    Some("open") => {
                        let path = url
                            .query_pairs()
                            .find(|(k, _)| k == "p")
                            .map(|(_, v)| v.into_owned())
                            .unwrap_or_else(|| "/".into());
                        open_full(app, &path);
                    }
                    _ => {}
                }
            }
            false
        }
        "about" => url.as_str() == "about:blank",
        "https" => {
            let host = url.host_str().unwrap_or("");
            if host == HOST || is_auth_host(host) {
                true
            } else {
                platform::open_url(url.as_str());
                false
            }
        }
        _ => false,
    }
}

/// The site's own microphone (never the camera), and nothing else.
fn permission(webview: tauri::Webview, kind: PermissionKind) -> PermissionResponse {
    let ours = webview
        .url()
        .map(|u| u.host_str() == Some(HOST))
        .unwrap_or(false);
    match kind {
        PermissionKind::Microphone if ours => PermissionResponse::Allow,
        _ => PermissionResponse::Deny,
    }
}

/// The settings both windows share: locked navigation, no pop-ups, microphone-only.
fn locked<'a>(
    builder: WebviewWindowBuilder<'a, tauri::Wry, AppHandle>,
    app: &AppHandle,
    bridge: bool,
    user_agent: &str,
) -> WebviewWindowBuilder<'a, tauri::Wry, AppHandle> {
    let nav = app.clone();
    let popup = app.clone();
    let popup_ua = user_agent.to_string();
    let mut b = builder
        // Every window must ask for the same arguments as the island (see lib.rs).
        .additional_browser_args(crate::BROWSER_ARGS)
        .user_agent(user_agent)
        // Tauri's own drop handler would swallow dropped files before the page sees them;
        // Knowura's chat takes files dropped on it, so the page has to get them itself.
        .disable_drag_drop_handler()
        .on_navigation(move |url| allow_navigation(&nav, url, bridge))
        .on_new_window(move |url, features| {
            if url.scheme() == "knowura-desk" {
                allow_navigation(&popup, &url, bridge);
                return NewWindowResponse::Deny;
            }
            if url.scheme() == "https" {
                let host = url.host_str().unwrap_or("");
                if is_auth_host(host) {
                    // Signing in happens here, in the app, not in the browser.
                    return match open_auth_popup(&popup, features, &popup_ua) {
                        Some(window) => NewWindowResponse::Create { window },
                        None => {
                            platform::open_url(url.as_str());
                            NewWindowResponse::Deny
                        }
                    };
                }
                // A link meant for a new tab: our own pages stay put, the rest leaves.
                if host != HOST {
                    platform::open_url(url.as_str());
                }
            }
            NewWindowResponse::Deny
        })
        .on_permission_request(permission);
    if bridge {
        b = b.initialization_script(BRIDGE_JS.replace("__INSTALL_ID__", &install_id()));
    }
    b
}

/// A random secret, made once and kept in the Credential Manager: it is what links
/// this PC to a Knowura account when you sign in from a browser.
fn install_id() -> String {
    if let Some(id) = crate::secrets::get("knowura-install-id") {
        return id;
    }
    const ABC: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
    let mut raw = [0u8; 43];
    let id = match getrandom::fill(&mut raw) {
        Ok(()) => raw.iter().map(|b| ABC[(*b & 63) as usize] as char).collect::<String>(),
        Err(_) => return String::new(),
    };
    let _ = crate::secrets::set("knowura-install-id", &id);
    id
}

/// Sign in with the browser: Knowura opens there with this PC's install id, and once
/// you are signed in the app picks the account up by itself.
pub fn sign_in_browser() {
    let id = install_id();
    if id.is_empty() {
        platform::open_url(&format!("https://{HOST}/"));
    } else {
        platform::open_url(&format!("https://{HOST}/?kwdev={id}"));
    }
}

/// The default user agent plus our suffix, read from the island's own web view so
/// the Chromium version is always the one actually installed.
fn user_agent(app: &AppHandle) -> String {
    let base = island::window(app).and_then(|win| {
        let (tx, rx) = mpsc::channel();
        win.eval_with_callback("navigator.userAgent", move |s| {
            let _ = tx.send(s);
        })
        .ok()?;
        let raw = rx.recv_timeout(Duration::from_millis(1500)).ok()?;
        serde_json::from_str::<String>(&raw).ok()
    });
    format!(
        "{} KnowuraDesktop/{}",
        base.unwrap_or_else(|| FALLBACK_UA.to_string()),
        env!("CARGO_PKG_VERSION")
    )
}

// ── Window plumbing ───────────────────────────────────────────────────────────

/// tao rewrites a window's extended style whenever a flag changes (showing and
/// hiding included) and always marks it as an app window, which puts the panel in
/// the taskbar and in docks like Seelen UI. Restore it once those changes landed.
fn keep_out_of_taskbars(app: &AppHandle, label: &'static str) {
    let handle = app.clone();
    std::thread::spawn(move || {
        for delay in [0u64, 250] {
            std::thread::sleep(Duration::from_millis(delay));
            let inner = handle.clone();
            let _ = handle.run_on_main_thread(move || {
                if let Some(win) = inner.get_webview_window(label) {
                    platform::enforce_taskbar_style(&win, false);
                }
            });
        }
    });
}

/// Inside the notch: the card is centred on the island's display, one bezel down from
/// the screen's top edge; the window reaches out to hold the card's margins.
fn place(app: &AppHandle, win: &WebviewWindow) {
    let pref = app
        .try_state::<crate::Shared>()
        .map(|s| s.settings.lock().unwrap().screen.clone())
        .unwrap_or_else(|| "primary".into());
    let Some(m) = island::target_monitor(app, &pref) else { return };
    let scale = m.scale_factor();
    let pos = *m.position();
    let size = *m.size();

    let page_h = PAGE_H.min((size.height as f64 / scale - 2.0 * BEZEL - 40.0).max(360.0));
    let w = ((PAGE_W + MARGIN_LEFT + MARGIN_RIGHT) * scale).round() as u32;
    let h = ((page_h + MARGIN_TOP + MARGIN_BOTTOM) * scale).round() as u32;
    let x = pos.x as f64 + size.width as f64 / 2.0 - (MARGIN_LEFT + PAGE_W / 2.0) * scale;
    let y = pos.y as f64 + (BEZEL - MARGIN_TOP) * scale;

    let _ = win.set_size(PhysicalSize::new(w, h));
    let _ = win.set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32));
    let _ = win.set_size(PhysicalSize::new(w, h));
}

/// Shrinks the page to a small rounded pill at the top, invisible and blurred,
/// before the window is shown.
fn prepare_js() -> String {
    format!(
        r#"(function () {{
  var e = document.documentElement, W = innerWidth, H = innerHeight;
  var L = {ml}, T = {mt}, R = {mr}, sw = 112, sh = 24;
  var sx = L + ((W - L - R) - sw) / 2;
  window.__kwSmall = 'inset(' + T + 'px ' + (W - sx - sw) + 'px ' + (H - T - sh) + 'px ' + sx + 'px round 12px)';
  window.__kwOpen = 'inset(0px 0px 0px 0px round 0px)';
  if (window.__kwAnim) {{ try {{ window.__kwAnim.cancel(); }} catch (x) {{}} }}
  e.style.opacity = '0';
  e.style.filter = 'blur(10px)';
  e.style.clipPath = window.__kwSmall;
  return 1;
}})()"#,
        ml = MARGIN_LEFT,
        mt = MARGIN_TOP,
        mr = MARGIN_RIGHT
    )
}

/// The page grows out of the top of its bezel as the notch stretches round it:
/// it sharpens and fades in while the clip opens, with no overshoot so it always
/// stays inside the black shape.
const EXPAND_JS: &str = r#"(function () {
  var e = document.documentElement;
  if (!window.__kwSmall) return;
  if (window.__kwAnim) { try { window.__kwAnim.cancel(); } catch (x) {} }
  e.style.opacity = '';
  e.style.filter = '';
  e.style.clipPath = '';
  var a = e.animate([
    { clipPath: window.__kwSmall, opacity: 0, filter: 'blur(10px)' },
    { clipPath: window.__kwSmall, opacity: 1, filter: 'blur(6px)', offset: 0.18 },
    { clipPath: window.__kwOpen, opacity: 1, filter: 'blur(0px)' }
  ], { duration: 600, easing: 'cubic-bezier(0.32, 0.92, 0.3, 1)', fill: 'forwards' });
  window.__kwAnim = a;
  a.finished.then(function () {
    e.style.clipPath = 'none'; e.style.opacity = '1'; e.style.filter = 'none';
    try { a.cancel(); } catch (x) {}
  }).catch(function () {});
})()"#;

const COLLAPSE_JS: &str = r#"(function () {
  var e = document.documentElement;
  if (!window.__kwSmall) return;
  if (window.__kwAnim) { try { window.__kwAnim.cancel(); } catch (x) {} }
  window.__kwAnim = e.animate([
    { clipPath: window.__kwOpen, opacity: 1, filter: 'blur(0px)' },
    { clipPath: window.__kwSmall, opacity: 0.6, filter: 'blur(5px)', offset: 0.8 },
    { clipPath: window.__kwSmall, opacity: 0, filter: 'blur(10px)' }
  ], { duration: 280, easing: 'cubic-bezier(0.5, 0, 0.75, 0)', fill: 'forwards' });
})()"#;

fn create_panel(app: &AppHandle, mode: Mode) -> tauri::Result<WebviewWindow> {
    let ua = user_agent(app);
    let page = app.clone();
    let blur = app.clone();

    let win = locked(
        WebviewWindowBuilder::new(app, PANEL, WebviewUrl::External(panel_url(mode))),
        app,
        true,
        &ua,
    )
    .title(APP_TITLE)
    .inner_size(PAGE_W + MARGIN_LEFT + MARGIN_RIGHT, PAGE_H + MARGIN_TOP + MARGIN_BOTTOM)
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .maximizable(false)
    .minimizable(false)
    .visible(false)
    .focused(false)
    .on_page_load(move |win, payload| {
        if payload.event() == PageLoadEvent::Finished
            && payload.url().host_str() == Some(HOST)
        {
            page_ready(&page, &win);
        }
    })
    .build()?;

    win.on_window_event(move |event| {
        if let WindowEvent::Focused(false) = event {
            let wanted = blur
                .try_state::<crate::Shared>()
                .map(|s| s.settings.lock().unwrap().close_on_click_outside)
                .unwrap_or(true);
            if !wanted {
                return;
            }
            let handle = blur.clone();
            std::thread::spawn(move || {
                // Let the new foreground window settle, then ask whose it is.
                std::thread::sleep(Duration::from_millis(160));
                // The "+" button's file picker is ours: that is not clicking away.
                if platform::foreground_is_ours() {
                    return;
                }
                let settled = {
                    let k = state(&handle);
                    let i = k.inner.lock().unwrap();
                    i.visible && i.shown_at.map(|t| t.elapsed() > BLUR_GRACE).unwrap_or(false)
                };
                if settled {
                    hide(&handle);
                }
            });
        }
    });
    Ok(win)
}

/// The page finished loading: if someone is waiting for the panel, show it.
fn page_ready(app: &AppHandle, win: &WebviewWindow) {
    let (want, loaded) = {
        let k = state(app);
        let mut i = k.inner.lock().unwrap();
        (i.pending.take(), i.loaded)
    };
    log::line(format!("knowura: page ready, waiting for it: {want:?}"));
    let Some(mode) = want else { return };
    if loaded != Some(mode) {
        let _ = win.eval(format!(
            "window.knowuraMode&&window.knowuraMode({})",
            js_string(mode.as_str())
        ));
    }
    reveal(app, win, mode);
}

/// Position, prepare the page's small shape, then show it a beat after the notch
/// has started to grow. Shown only once the page has run the prepare script, so
/// there is never a white or full-size frame.
fn reveal(app: &AppHandle, win: &WebviewWindow, mode: Mode) {
    begin_island(app);
    place(app, win);
    let app2 = app.clone();
    let win2 = win.clone();
    let queued = win.eval_with_callback(prepare_js(), move |_| {
        let win3 = win2.clone();
        let app3 = app2.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(SHOW_DELAY_MS));
            let _ = win3.show();
            let _ = win3.set_focus();
            let _ = win3.set_always_on_top(true);
            keep_out_of_taskbars(&app3, PANEL);
            let _ = win3.eval(EXPAND_JS);
            let k = state(&app3);
            let mut i = k.inner.lock().unwrap();
            i.visible = true;
            i.shown_at = Some(Instant::now());
            i.loaded = Some(mode);
        });
    });
    log::line(format!("knowura: reveal requested, eval queued: {}", queued.is_ok()));
}

/// Tells the island to spring open around Knowura (once per opening), and makes
/// its window tall enough to hold it.
fn begin_island(app: &AppHandle) {
    {
        let k = state(app);
        let mut i = k.inner.lock().unwrap();
        if i.island_open {
            return;
        }
        i.island_open = true;
    }
    island::set_tall(app, true);
    let _ = app.emit_to(island::WINDOW_LABEL, "knowura", serde_json::json!({ "open": true }));
}

// ── Show, hide, switch ────────────────────────────────────────────────────────

/// Opens the panel in `mode`, or switches it if it is already open.
pub fn open(app: &AppHandle, mode: Mode) {
    let app = app.clone();
    std::thread::spawn(move || open_now(&app, mode));
}

fn open_now(app: &AppHandle, mode: Mode) {
    let k = state(app);
    k.epoch.fetch_add(1, Ordering::SeqCst);

    if let Some(win) = app.get_webview_window(PANEL) {
        let (visible, loading) = {
            let i = k.inner.lock().unwrap();
            (i.visible, i.pending.is_some() || i.creating)
        };
        if visible {
            let _ = win.set_focus();
            let _ = win.eval(format!(
                "window.knowuraMode&&window.knowuraMode({})",
                js_string(mode.as_str())
            ));
            return;
        }
        if loading {
            k.inner.lock().unwrap().pending = Some(mode);
            return;
        }
        // Hidden but alive: tell the page it is back, then show it.
        let _ = win.eval(format!(
            "window.knowuraShown&&window.knowuraShown(true,false,{})",
            js_string(mode.as_str())
        ));
        reveal(app, &win, mode);
        return;
    }

    {
        let mut i = k.inner.lock().unwrap();
        if i.creating {
            i.pending = Some(mode);
            return;
        }
        i.creating = true;
        i.pending = Some(mode);
        i.loaded = Some(mode);
    }
    // The notch starts stretching at once; the page follows when it has loaded.
    begin_island(app);
    let created = create_panel(app, mode);
    k.inner.lock().unwrap().creating = false;
    match created {
        Ok(_) => {
            let handle = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(LOAD_TIMEOUT);
                let waiting = {
                    let k = state(&handle);
                    let i = k.inner.lock().unwrap();
                    i.pending.is_some() && !i.visible
                };
                if waiting {
                    log::line("knowura: page did not load in time, giving the notch back".to_string());
                    give_back(&handle);
                }
            });
        }
        Err(err) => {
            log::line(format!("knowura: could not create the panel: {err}"));
            {
                let mut i = k.inner.lock().unwrap();
                i.pending = None;
                i.loaded = None;
            }
            give_back(app);
        }
    }
}

/// Closes the notch again without a page ever having been shown.
fn give_back(app: &AppHandle) {
    let k = state(app);
    {
        let mut i = k.inner.lock().unwrap();
        i.pending = None;
        i.loaded = None;
        i.island_open = false;
    }
    if let Some(win) = app.get_webview_window(PANEL) {
        let _ = win.destroy();
    }
    let _ = app.emit_to(island::WINDOW_LABEL, "knowura", serde_json::json!({ "open": false }));
    std::thread::sleep(Duration::from_millis(SETTLE_MS));
    if !k.inner.lock().unwrap().island_open {
        island::set_tall(app, false);
    }
}

/// Alt+Space: hidden → open on the text box; open on text and focused → collapse;
/// open on voice (or not focused) → bring to the front on the text box.
pub fn toggle_text(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let visible = state(&app).inner.lock().unwrap().visible;
        let Some(win) = app.get_webview_window(PANEL).filter(|_| visible) else {
            open_now(&app, Mode::Text);
            return;
        };
        let (tx, rx) = mpsc::channel();
        let asked = win.eval_with_callback("window.__kw && window.__kw.view", move |s| {
            let _ = tx.send(s);
        });
        let view = asked
            .ok()
            .and_then(|_| rx.recv_timeout(Duration::from_millis(600)).ok())
            .unwrap_or_default();
        let on_text = view.contains("text");
        if on_text && win.is_focused().unwrap_or(false) {
            hide_now(&app);
        } else {
            let _ = win.set_focus();
            if !on_text {
                let _ = win.eval("window.knowuraMode&&window.knowuraMode('text')");
            }
        }
    });
}

pub fn hide(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || hide_now(&app));
}

fn hide_now(app: &AppHandle) {
    let k = state(app);
    let win = app.get_webview_window(PANEL);
    let was_visible = {
        let mut i = k.inner.lock().unwrap();
        i.pending = None;
        if !i.visible && !i.island_open {
            return;
        }
        let v = i.visible;
        i.visible = false;
        i.island_open = false;
        v
    };

    if let (true, Some(win)) = (was_visible, win.as_ref()) {
        // The microphone goes off before anything else, whatever happens next.
        let _ = win.eval("window.knowuraHidden&&window.knowuraHidden()");
        // The page leads the way back into the notch…
        let _ = win.eval(COLLAPSE_JS);
        std::thread::sleep(Duration::from_millis(COLLAPSE_LEAD_MS));
    }
    // …and the notch follows it back to its pill.
    let _ = app.emit_to(island::WINDOW_LABEL, "knowura", serde_json::json!({ "open": false }));
    if let (true, Some(win)) = (was_visible, win.as_ref()) {
        std::thread::sleep(Duration::from_millis(COLLAPSE_MS - COLLAPSE_LEAD_MS));
        let _ = win.hide();
        keep_out_of_taskbars(app, PANEL);
    }

    // Once the notch has settled, the island's window is an ordinary size again.
    std::thread::sleep(Duration::from_millis(SETTLE_MS));
    if !k.inner.lock().unwrap().island_open {
        island::set_tall(app, false);
    }

    // Hidden for two minutes: free the web view completely.
    let epoch = k.epoch.fetch_add(1, Ordering::SeqCst) + 1;
    std::thread::sleep(IDLE_DESTROY);
    if k.epoch.load(Ordering::SeqCst) == epoch && !k.inner.lock().unwrap().visible {
        if let Some(win) = app.get_webview_window(PANEL) {
            let _ = win.destroy();
            let mut i = k.inner.lock().unwrap();
            i.pending = None;
            i.loaded = None;
            log::line("knowura: panel destroyed after two idle minutes".to_string());
        }
    }
}

/// Mic off, window gone: used when switching back to Mochi mode.
pub fn shut_down(app: &AppHandle) {
    let k = state(app);
    k.epoch.fetch_add(1, Ordering::SeqCst);
    if let Some(win) = app.get_webview_window(PANEL) {
        let _ = win.eval("window.knowuraHidden&&window.knowuraHidden()");
        let _ = win.destroy();
    }
    let was_open = {
        let mut i = k.inner.lock().unwrap();
        let open = i.island_open;
        *i = Inner::default();
        open
    };
    if was_open {
        let _ = app.emit_to(island::WINDOW_LABEL, "knowura", serde_json::json!({ "open": false }));
        island::set_tall(app, false);
    }
}

// ── Handing a file over (Mochi's drop) ────────────────────────────────────────

/// What the page accepts per file, the same as its "+" button.
const ATTACH_MAX: u64 = 25 * 1024 * 1024;
/// Raw bytes per call: about 256 KB once encoded, which ExecuteScript handles well.
const ATTACH_CHUNK: usize = 192 * 1024;

fn mime_for(name: &str) -> &'static str {
    let ext = std::path::Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    match ext.as_str() {
        "pdf" => "application/pdf",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "txt" | "log" => "text/plain",
        "md" => "text/markdown",
        "json" => "application/json",
        "csv" => "text/csv",
        "html" | "htm" => "text/html",
        "css" => "text/css",
        "js" | "mjs" => "text/javascript",
        _ => "",
    }
}

/// Runs `js` in the page and reads back a boolean answer.
fn ask_bool(win: &WebviewWindow, js: String) -> bool {
    let (tx, rx) = mpsc::channel();
    let queued = win.eval_with_callback(js, move |s| {
        let _ = tx.send(s);
    });
    queued.is_ok()
        && rx
            .recv_timeout(Duration::from_secs(10))
            .map(|s| s.trim() == "true")
            .unwrap_or(false)
}

/// Mochi's file drop in Knowura mode: opens the panel on the text box and streams
/// the file into its composer through the page's own hooks, as if it had been
/// attached with the "+" button. Nothing is sent; the user asks the question.
pub fn attach_file(app: &AppHandle, path: &str) {
    let app = app.clone();
    let path = path.to_string();
    std::thread::spawn(move || {
        if let Err(err) = attach_now(&app, &path) {
            log::line(format!("knowura: could not hand the file over: {err}"));
        }
    });
}

fn attach_now(app: &AppHandle, path: &str) -> Result<(), String> {
    // Only copies Coucou itself made in its inbox: the front end never gets to name any other file.
    let file = std::path::Path::new(path).canonicalize().map_err(|e| e.to_string())?;
    let inbox = crate::files::inbox_dir().canonicalize().map_err(|e| e.to_string())?;
    if !file.starts_with(&inbox) {
        return Err("not a file from the inbox".into());
    }
    let size = std::fs::metadata(&file).map_err(|e| e.to_string())?.len();
    if size > ATTACH_MAX {
        return Err(format!("{size} bytes is over the {ATTACH_MAX} byte limit"));
    }
    let bytes = std::fs::read(&file).map_err(|e| e.to_string())?;
    let name = file
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".into());

    open_now(app, Mode::Text);

    // The page has to be on screen and have defined its hooks.
    let start = Instant::now();
    let win = loop {
        let ready = state(app).inner.lock().unwrap().visible;
        if let (true, Some(win)) = (ready, app.get_webview_window(PANEL)) {
            if ask_bool(
                &win,
                "window.knowuraReady===true&&typeof window.knowuraAttachBegin==='function'".into(),
            ) {
                break win;
            }
        }
        if start.elapsed() > Duration::from_secs(40) {
            return Err("the Knowura page was not ready in time".into());
        }
        std::thread::sleep(Duration::from_millis(200));
    };

    let id = format!(
        "coucou-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    );
    let begin = format!(
        "window.knowuraAttachBegin({{id:{},name:{},type:{},size:{}}})",
        js_string(&id),
        js_string(&name),
        js_string(mime_for(&name)),
        size
    );
    if !ask_bool(&win, begin) {
        return Err("the page refused the file (too big, or too many attached)".into());
    }
    for piece in bytes.chunks(ATTACH_CHUNK) {
        let js = format!(
            "window.knowuraAttachChunk({},\"{}\")",
            js_string(&id),
            crate::claude::base64_for(piece)
        );
        if !ask_bool(&win, js) {
            return Err("the page dropped the transfer".into());
        }
    }
    // End returns a Promise, so the answer is read from the page's own counters.
    let _ = win.eval(format!("window.knowuraAttachEnd({})", js_string(&id)));
    log::line(format!("knowura: handed over {name} ({size} bytes)"));
    Ok(())
}

// ── The full Knowura app ──────────────────────────────────────────────────────

/// The full app: a normal window called "Knowura AI", with Knowura's icon in its
/// title bar and on the taskbar.
fn build_full(app: &AppHandle, url: Url, user_agent: &str) -> tauri::Result<WebviewWindow> {
    let builder = locked(
        WebviewWindowBuilder::new(app, FULL, WebviewUrl::External(url)),
        app,
        false,
        user_agent,
    )
    .title(APP_TITLE)
    .inner_size(1100.0, 780.0)
    .min_inner_size(420.0, 500.0)
    .center();
    let builder = match tauri::image::Image::from_bytes(APP_ICON) {
        Ok(icon) => builder.icon(icon)?,
        Err(_) => builder,
    };
    builder.build()
}

/// The pull-up gesture: the same site in a normal window. The path can be ~120 KB
/// (`/#kwimport=…`), so it is loaded inside our own web view, never through a shell.
pub fn open_full(app: &AppHandle, path: &str) {
    let safe = if path.starts_with('/') && !path.starts_with("//") && path.len() <= 200_000 {
        path
    } else {
        "/"
    };
    let Ok(url) = Url::parse(&format!("https://{HOST}{safe}")) else { return };
    let app = app.clone();
    std::thread::spawn(move || {
        if let Some(win) = app.get_webview_window(FULL) {
            let _ = win.navigate(url);
            let _ = win.unminimize();
            let _ = win.show();
            let _ = win.set_focus();
        } else {
            let ua = user_agent(&app);
            let built = build_full(&app, url, &ua);
            if let Err(err) = built {
                log::line(format!("knowura: could not open the full app: {err}"));
            }
        }
        hide_now(&app);
    });
}

// ── Hotkey ────────────────────────────────────────────────────────────────────

/// Alt+Space opens the text box. Where Windows (or another app) refuses it, the
/// fallback combo is used instead. Returns the combo that is active.
pub fn register_hotkey(app: &AppHandle) -> Option<String> {
    let shortcuts = app.global_shortcut();
    let _ = shortcuts.unregister_all();
    let k = state(app);
    for combo in HOTKEYS {
        let Ok(shortcut) = combo.parse::<Shortcut>() else { continue };
        let handle = app.clone();
        let registered = shortcuts.on_shortcut(shortcut, move |_, _, event| {
            if event.state() == ShortcutState::Pressed {
                toggle_text(&handle);
            }
        });
        if registered.is_ok() {
            log::line(format!("knowura: hotkey {combo}"));
            *k.hotkey.lock().unwrap() = Some(combo.to_string());
            return Some(combo.to_string());
        }
    }
    log::line("knowura: no hotkey could be registered".to_string());
    *k.hotkey.lock().unwrap() = None;
    None
}

pub fn unregister_hotkey(app: &AppHandle) {
    let _ = app.global_shortcut().unregister_all();
    *state(app).hotkey.lock().unwrap() = None;
}

/// Turns Knowura mode on or off: hotkey and panel follow the setting.
pub fn apply_mode(app: &AppHandle, on: bool) {
    if on {
        register_hotkey(app);
    } else {
        unregister_hotkey(app);
        shut_down(app);
    }
}
