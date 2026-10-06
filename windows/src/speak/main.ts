// Knowura Speak's overlay: a small Mochi in headphones above the text caret while you hold
// Ctrl+Win and talk. He wears what he wears everywhere else (same outfit setting as the notch's
// Mochi), his eyes follow how loud you are, and he squints while Whisper works.
//
// src-tauri/src/speak.rs owns the window and tells this page what is happening:
//   speak-phase  "listening" | "thinking" | "done" | "silent" | "error"  (+ a message)
//   speak-level  how loud the microphone is, 0..1 (an RMS)

import { Bridge, onEvent } from "../core/bridge";
import { Sound } from "../core/sound";
import { BotEngine } from "../mochi/engine";
import { resolveOutfit, type Outfit } from "../mochi/outfits";
import type { Settings } from "../core/state";

const W = 132;
const H = 88;
/** Mochi's own square, at the left; the level bars are to its right. */
const MOCHI = 72;

const canvas = document.getElementById("speak") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
const dpr = Math.max(1, window.devicePixelRatio || 1);
canvas.width = Math.round(W * dpr);
canvas.height = Math.round(H * dpr);

const engine = new BotEngine();
engine.headphones = true;
// Mochi's own look: a white body, unless the user picked a colour for him in the settings.
engine.setOutfit("none", false);

type Phase = "listening" | "thinking" | "done" | "silent" | "error";
let phase: Phase = "listening";
let message = "";
let level = 0;
let smoothed = 0;
let bars: number[] = [0, 0, 0, 0, 0];

function setPhase(p: Phase, text: string | null) {
  phase = p;
  message = text ?? "";
  switch (p) {
    case "listening":
      engine.headphones = true;
      engine.setState("idle");
      engine.blink();
      Sound.play("tick");
      break;
    case "thinking":
      engine.setState("thinking");
      break;
    case "done":
      engine.setState("finished");
      engine.triggerEmote("happy", 0.6);
      Sound.play("approve");
      break;
    case "silent":
      engine.setState("idle");
      break;
    case "error":
      engine.setState("error");
      Sound.play("error");
      break;
  }
}

// ── Settings: the outfit and the sound, like the rest of Mochi ────────────────

function applySettings(s: Settings) {
  Sound.setEnabled(s.soundEnabled);
  Sound.setVolume(s.soundVolume);
  const outfit = resolveOutfit((s.mochiOutfit || "auto") as Outfit);
  engine.setOutfit(outfit, true);
}

void Bridge.boot().then((boot) => boot && applySettings(boot.settings));
void onEvent<Settings>("settings-changed", applySettings);
void Sound.preload();

void onEvent<{ phase: Phase; message: string | null }>("speak-phase", (p) => setPhase(p.phase, p.message));
void onEvent<number>("speak-level", (v) => { level = v; });

// ── Drawing ───────────────────────────────────────────────────────────────────

let last = performance.now();
let t = 0;
function frame(nowMs: number) {
  if (nowMs - last >= 33) {
    const dt = Math.min(0.05, (nowMs - last) / 1000);
    last = nowMs;
    t += dt;

    // How loud he hears you: a quick rise and a slower fall.
    const target = Math.min(1, Math.sqrt(level) * 3.2);
    smoothed += (target - smoothed) * (target > smoothed ? 0.6 : 0.18);
    // He looks up and to the side while you talk, and opens his eyes wider with the volume.
    engine.lookX = phase === "listening" ? 0.35 : 0;
    engine.lookY = phase === "listening" ? 0.25 : 0;
    engine.tgEs = 1 + (phase === "listening" ? smoothed * 0.35 : 0);

    engine.update(dt);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    // Mochi, in a square of his own so the bars have room.
    ctx.save();
    ctx.translate(0, 8);
    engine.particleOverhang = 0;
    engine.draw(ctx, MOCHI, MOCHI);
    ctx.restore();

    drawBars();
    drawLabel();
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

function drawBars() {
  const x0 = MOCHI + 8;
  const base = 56;
  const w = 6;
  for (let i = 0; i < bars.length; i++) {
    let target = 0.12;
    if (phase === "listening") {
      // Each bar has its own wobble, the volume decides how tall they all get.
      const wobble = 0.5 + 0.5 * Math.sin(t * (7 + i * 1.7) + i * 1.3);
      target = 0.12 + smoothed * (0.45 + 0.55 * wobble);
    } else if (phase === "thinking") {
      // A wave rolling through the bars while Whisper works.
      target = 0.2 + 0.35 * (0.5 + 0.5 * Math.sin(t * 6 - i * 0.9));
    } else if (phase === "done") {
      target = 0.12;
    }
    bars[i] += (target - bars[i]) * 0.35;
    const h = 8 + bars[i] * 34;
    const x = x0 + i * (w + 4);
    const color =
      phase === "error" ? "#F4505E" : phase === "done" ? "#22C55E" : phase === "silent" ? "#8E939C" : "#8AB4F8";
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(x, base - h, w, h, 3);
    ctx.fill();
  }
}

function drawLabel() {
  const text =
    message ||
    (phase === "thinking" ? "Writing…" : phase === "done" ? "Done" : "");
  if (!text) return;
  ctx.font = "600 11px system-ui, 'Segoe UI', sans-serif";
  const pad = 7;
  const w = Math.min(W - 4, ctx.measureText(text).width + pad * 2);
  const x = MOCHI + 8;
  const y = 62;
  ctx.fillStyle = "rgba(20,21,24,0.92)";
  ctx.beginPath();
  ctx.roundRect(x, y, w, 20, 10);
  ctx.fill();
  ctx.fillStyle = "#F5F6F8";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x + pad, y + 10.5, W - x - pad * 2);
}
