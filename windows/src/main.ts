// Entry point: boot the bridge, wire the island, start the greeting.

import "./style.css";
import { Bridge, IS_TAURI, onEvent } from "./core/bridge";
import { Sound } from "./core/sound";
import { State, type MusicInfo, type Settings } from "./core/state";
import type { MochiMood } from "./mochi/engine";
import { Island } from "./island/island";
import { registerHookHandlers } from "./island/hooks";
import { refreshWeather, startWeather } from "./views/weather";
import { registerPhoneLink } from "./island/phone-link";
import { registerIntegrationHandlers, refreshConfigured } from "./island/integrations";
import { registerShortcutHandlers } from "./island/shortcuts";
import { applySpotify, registerSpotifyHandlers } from "./island/spotify";
import { SPOTIFY_ID } from "./core/spotify";
import { Recap } from "./recap/recap";
import { Updates } from "./island/update";
import { onLanguageChange, resolveLanguage, setLanguage, systemLanguages } from "./i18n/i18n";

/** Shows the language Settings asks for ("" = the system's, when Coucou has it). */
function applyLanguage() {
  setLanguage(resolveLanguage(State.settings.language, systemLanguages()));
}

// Anything that goes wrong in the page is written to the log, where a bug report can find it.
window.addEventListener("error", (e) => void Bridge.log(`js error: ${e.message} at ${e.filename}:${e.lineno}`));
window.addEventListener("unhandledrejection", (e) => void Bridge.log(`js rejection: ${String(e.reason).slice(0, 300)}`));

async function main() {
  const root = document.getElementById("root");
  if (!root) return;

  void Sound.preload();

  // Before the island exists: its canvases size their bitmaps from the pixel
  // ratio once, so the zoom correction has to land first. If zoom was adjusted,
  // wait until the ratio updates (or up to 500ms) so nothing is sized against
  // the stale value.
  const dprBefore = window.devicePixelRatio || 1;
  const zoomChanged = await Bridge.fitZoom(dprBefore);
  if (zoomChanged) {
    for (let i = 0; i < 20 && window.devicePixelRatio === dprBefore; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  const island = new Island(root);

  const boot = await Bridge.boot();
  if (boot) {
    State.settings = { ...State.settings, ...boot.settings };
  }
  // A language change redraws the island in place: the texts given as tl(…)
  // relabel themselves (views/dom.ts) and the views redraw the rest on this
  // sync. Nothing is rebuilt, so tasks, steps and the chat stay as they are.
  onLanguageChange(() => State.notify());
  applyLanguage();
  // Rust shows the tray and its errors in the same language as the webview.
  void Bridge.setSystemLanguages(systemLanguages());
  island.applySettings();
  State.loadIntegrationTasks();
  startWeather();
  if (boot && !boot.cursorPoll) island.followPageCursor();
  await island.desktop.init();

  await onEvent<{ x: number; y: number }>("cursor", ({ x, y }) => island.onCursor(x, y));
  await onEvent<boolean>("pointer-inside", (inside) => island.setPointerInside(inside));

  /** Pause has to reach Rust too, or the pollers keep calling out. */
  const setPaused = (on: boolean) => {
    if (State.paused === on) return;
    State.paused = on;
    void Bridge.setPaused(on);
  };

  // Camera / microphone in use: a green or orange dot on the island.
  await onEvent<{ camera: boolean; mic: boolean }>("privacy", (p) => island.privacyChanged(p));
  void Bridge.privacyState().then((p) => p && island.privacyChanged(p));

  // How the PC feels (vitals.rs): he sweats, puffs up or tires by it.
  await onEvent<MochiMood & { summary: string | null }>("vitals", (v) => {
    State.vitals = { busy: v.busy, hot: v.hot, full: v.full, tired: v.tired, asleep: v.asleep };
    State.vitalsSummary = v.summary ?? null;
    State.notify();
  });
  // Plugged in while tired: he wakes up.
  await onEvent<boolean>("vitals-woke", () => island.vitalsWoke());

  // What is playing on the PC: the closed island shows the album art, the overview the player.
  await onEvent<MusicInfo>("music", (m) => island.musicChanged(m));
  void Bridge.musicState().then((m) => m && island.musicChanged(m));

  // A mouse press outside the island (Rust sees it even though the island is click-through).
  await onEvent<null>("outside-press", () => island.outsidePress());

  // Rust opens and closes the Knowura panel: the notch grows to hold it, or shrinks back.
  await onEvent<{ open: boolean }>("knowura", ({ open }) => {
    if (open) island.knowuraShow();
    else island.knowuraHide();
  });

  // Mochi is driving the PC (computer.rs): his island self looks busy until he is done.
  await onEvent<boolean>("computer-busy", (busy) => {
    State.computerBusy = busy;
    State.notify();
  });

  await onEvent<string>("tray", (what) => {
    switch (what) {
      case "settings":
        setPaused(false);
        island.alert("settings");
        break;
      case "open":
        setPaused(false);
        island.alert(State.defaultView());
        break;
      case "recap":
        setPaused(false);
        void Recap.open(island);
        break;
      case "wardrobe":
        setPaused(false);
        island.alert("wardrobe");
        break;
      // "Mochi: do something on my PC…": the island stretches into the task box.
      case "computer":
        setPaused(false);
        island.alert("agent");
        break;
      // "Update Coucou to X…", only in the menu while a new version is out.
      case "update":
        setPaused(false);
        Updates.show();
        break;
      case "pause":
        setPaused(!State.paused);
        if (State.paused) island.fsm.forceHidden();
        else island.reveal();
        break;
    }
  });

  const checkZoom = async () => {
    const dpr = window.devicePixelRatio || 1;
    await Bridge.fitZoom(dpr);
  };

  await onEvent<null>("screen-changed", async () => {
    await checkZoom();
    void Bridge.reposition();
  });

  const mediaQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
  mediaQuery.addEventListener?.("change", () => void checkZoom());

  window.addEventListener(
    "wheel",
    (e) => {
      if (e.ctrlKey) e.preventDefault();
    },
    { passive: false }
  );
  window.addEventListener("keydown", (e) => {
    if (e.ctrlKey && (e.key === "+" || e.key === "-" || e.key === "=" || e.key === "0")) {
      e.preventDefault();
    }
  });

  // Settings → Reload sounds: read the sounds folder again, and let them hear it.
  await onEvent<null>("sounds-changed", () => {
    void Sound.reload().then(() => Sound.play("pop"));
  });

  // The settings window writes preferences; apply them here without a restart.
  await onEvent<Settings>("settings-changed", (s) => {
    const previousMain = State.mainPillId;
    const weatherFor = (x: Settings) => [x.weatherPlace, x.weatherLat, x.weatherLon, x.weatherFahrenheit, x.showWeather].join("|");
    const weatherBefore = weatherFor(State.settings);
    State.settings = { ...State.settings, ...s };
    applyLanguage();
    island.applySettings();
    State.loadIntegrationTasks();
    // A new main tool comes to the front, as on macOS.
    if (State.mainPillId !== previousMain) State.setFocus(State.mainPillId);
    if (weatherFor(State.settings) !== weatherBefore) void refreshWeather(true);
    void refreshConfigured();
  });

  registerHookHandlers(island);
  registerPhoneLink(island);
  registerIntegrationHandlers(island);
  registerShortcutHandlers(island, () => setPaused(false));
  registerSpotifyHandlers(island);
  // New versions: Rust offers the card, the island opens it when nothing else waits.
  await Updates.register(island);
  // Rust may have read Spotify before this page listened: ask once.
  if (State.settings.activeIntegrations.includes(SPOTIFY_ID)) {
    void Bridge.spotifyRefresh().then((s) => s && applySpotify(island, s));
  }

  // Monday recap: app start (greeting over), an agent starting work, waking up.
  const checkRecap = () => void Recap.check(island);
  island.onGreetingDone = checkRecap;
  island.onWake = checkRecap;
  await onEvent<null>("recap-check", checkRecap);

  island.launch();

  // In a plain browser there is no wake strip behind the cursor: make the whole
  // page wake the island so the visuals can be checked with `npm run dev`.
  if (!IS_TAURI) {
    document.addEventListener("click", () => Sound.resume(), { once: true });
  }
}

void main();
