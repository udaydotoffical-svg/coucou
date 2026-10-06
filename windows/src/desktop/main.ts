// Mochi on the desktop: the page inside the small floating window (src-tauri/src/desktop.rs).
//
// It only draws him. The island tells it what he should look like (`mochi-sync`), Rust tells it
// where the cursor is (`mochi-cursor`) and when to fade or react (`mochi-fade`, `mochi-emote`),
// and what he does with a click goes back out as a command or an event.

import { emit } from "@tauri-apps/api/event";
import { Bridge, onEvent } from "../core/bridge";
import { Sound } from "../core/sound";
import { BotEngine } from "../mochi/engine";
import type { BotStateName } from "../core/layout";
import type { BotEmoteName } from "../core/layout";
import type { Outfit } from "../mochi/outfits";

/** What the island sends whenever Mochi's look changes. */
export interface MochiSync {
  state: BotStateName;
  outfit: Outfit;
  headphones: boolean;
  accent: [number, number, number] | null;
  soundEnabled: boolean;
  volume: number;
}

const SIZE = 120;
/** A Mochi with no agent at work for this long, and the pointer away, falls asleep. */
const SLEEP_AFTER_S = 120;
const SLEEP_DISTANCE = 150;
const DOUBLE_CLICK_MS = 500;
const DRAG_THRESHOLD = 3;

const canvas = document.getElementById("mochi") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
const dpr = Math.max(1, window.devicePixelRatio || 1);
canvas.width = Math.round(SIZE * dpr);
canvas.height = Math.round(SIZE * dpr);

const engine = new BotEngine();
let sync: MochiSync | null = null;
let lastAgentActive = performance.now();
let cursor = { dx: 1000, dy: 1000 };
let sleeping = false;
let lastState: BotStateName = "idle";

function applySleep() {
  const agentActive = !!sync && sync.state !== "idle" && sync.state !== "sleeping";
  if (agentActive) lastAgentActive = performance.now();
  const dist = Math.hypot(cursor.dx, cursor.dy);
  const shouldSleep = (performance.now() - lastAgentActive) / 1000 > SLEEP_AFTER_S && dist >= SLEEP_DISTANCE;
  if (shouldSleep !== sleeping) {
    sleeping = shouldSleep;
    engine.setState(sleeping ? "sleeping" : sync?.state ?? "idle");
  }
}

function apply(s: MochiSync) {
  const first = sync == null;
  sync = s;
  Sound.setEnabled(s.soundEnabled);
  Sound.setVolume(s.volume);
  engine.headphones = s.headphones;
  engine.phoneAccent = s.accent;
  engine.setOutfit(s.outfit, !first);
  if (!sleeping) engine.setState(s.state, first);
  // A finished session: a joy jump.
  if (s.state === "finished" && lastState !== "finished" && !first) engine.triggerEmote("happy", 1.2);
  lastState = s.state;
}

// ── Frame loop (30 fps, 10 while asleep) ──────────────────────────────────────

let last = performance.now();
function frame(nowMs: number) {
  const interval = sleeping ? 100 : 33;
  if (nowMs - last >= interval) {
    const dt = Math.min(0.05, (nowMs - last) / 1000);
    last = nowMs;
    applySleep();
    engine.lookX = Math.tanh(cursor.dx / 260);
    engine.lookY = -Math.tanh(cursor.dy / 200);
    engine.update(dt);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, SIZE, SIZE);
    engine.draw(ctx, SIZE, SIZE);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ── Events from the island and from Rust ──────────────────────────────────────

void onEvent<MochiSync>("mochi-sync", apply);
void onEvent<[number, number]>("mochi-cursor", ([dx, dy]) => { cursor = { dx, dy }; });
void onEvent<{ to: number; ms: number }>("mochi-fade", ({ to, ms }) => {
  canvas.style.transition = `opacity ${ms}ms ease-in-out`;
  canvas.style.opacity = String(to);
  // He lands with a squash and a pop when he appears.
  if (to > 0.5) {
    window.setTimeout(() => {
      engine.triggerEmote("happy", 0.6);
      Sound.play("pop");
    }, ms);
  } else {
    Sound.play("peek");
  }
});
void onEvent<string>("mochi-emote", (name) => engine.triggerEmote(name as BotEmoteName));

// Ask the island for the current look (it may have been sent before this page was listening).
void emit("mochi-ready", null);
void Sound.preload();

// ── The mouse ─────────────────────────────────────────────────────────────────

let pressed: { x: number; y: number } | null = null;
let dragged = false;
let slapTimer: number | null = null;
let lastClickAt = 0;

canvas.addEventListener("mousedown", (e) => {
  Sound.resume();
  if (e.button !== 0) return;
  pressed = { x: e.screenX, y: e.screenY };
  dragged = false;
});

window.addEventListener("mousemove", (e) => {
  if (!pressed || dragged) return;
  if (Math.hypot(e.screenX - pressed.x, e.screenY - pressed.y) > DRAG_THRESHOLD) {
    dragged = true;
    // From here Rust carries him: it follows the cursor until the button is released.
    void Bridge.desktopMochiDrag();
  }
});

window.addEventListener("mouseup", (e) => {
  if (e.button !== 0 || !pressed) return;
  pressed = null;
  if (dragged) return;
  const nowMs = performance.now();
  if (nowMs - lastClickAt < DOUBLE_CLICK_MS) {
    // Double click: he flies home.
    if (slapTimer != null) window.clearTimeout(slapTimer);
    slapTimer = null;
    lastClickAt = 0;
    void Bridge.desktopMochiHome();
    return;
  }
  lastClickAt = nowMs;
  // A single click slaps him, unless a second one follows.
  slapTimer = window.setTimeout(() => {
    slapTimer = null;
    engine.slap();
  }, DOUBLE_CLICK_MS);
});

// Right click opens the wardrobe on the island.
window.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  void emit("mochi-wardrobe", null);
});
