// Entry point: boot the bridge, wire the island, start the greeting.

import "./style.css";
import { Bridge, IS_TAURI, onEvent } from "./core/bridge";
import { Sound } from "./core/sound";
import { State, type MusicInfo, type Settings } from "./core/state";
import { Island } from "./island/island";
import { registerHookHandlers } from "./island/hooks";
import { refreshWeather, startWeather } from "./views/weather";
import { registerIntegrationHandlers, refreshConfigured } from "./island/integrations";

async function main() {
  const root = document.getElementById("root");
  if (!root) return;

  void Sound.preload();

  const island = new Island(root);

  const boot = await Bridge.boot();
  if (boot) {
    State.settings = { ...State.settings, ...boot.settings };
  }
  island.applySettings();
  State.loadIntegrationTasks();
  State.applyMainAvatar();
  startWeather();
  if (boot && !boot.cursorPoll) island.followPageCursor();

  await onEvent<{ x: number; y: number }>("cursor", ({ x, y }) => island.onCursor(x, y));

  /** Pause has to reach Rust too, or the pollers keep calling out. */
  const setPaused = (on: boolean) => {
    if (State.paused === on) return;
    State.paused = on;
    void Bridge.setPaused(on);
  };

  // Camera / microphone in use: a green or orange dot on the island.
  await onEvent<{ camera: boolean; mic: boolean }>("privacy", (p) => island.privacyChanged(p));
  void Bridge.privacyState().then((p) => p && island.privacyChanged(p));

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
      case "pause":
        setPaused(!State.paused);
        if (State.paused) island.fsm.forceHidden();
        else island.reveal();
        break;
    }
  });

  await onEvent<null>("screen-changed", () => void Bridge.reposition());

  // The settings window writes preferences; apply them here without a restart.
  await onEvent<Settings>("settings-changed", (s) => {
    const mainBefore = State.settings.mainAvatar;
    const weatherFor = (x: Settings) => [x.weatherPlace, x.weatherLat, x.weatherLon, x.weatherFahrenheit, x.showWeather].join("|");
    const weatherBefore = weatherFor(State.settings);
    State.settings = { ...State.settings, ...s };
    island.applySettings();
    State.loadIntegrationTasks();
    if (State.settings.mainAvatar !== mainBefore) State.applyMainAvatar();
    if (weatherFor(State.settings) !== weatherBefore) void refreshWeather(true);
    void refreshConfigured();
  });

  registerHookHandlers(island);
  registerIntegrationHandlers(island);

  island.launch();

  // In a plain browser there is no wake strip behind the cursor: make the whole
  // page wake the island so the visuals can be checked with `npm run dev`.
  if (!IS_TAURI) {
    document.addEventListener("click", () => Sound.resume(), { once: true });
  }
}

void main();
