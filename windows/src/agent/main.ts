// Mochi's blue pointer: a full-screen, click-through overlay shown while he does a task for you.
// src-tauri/src/computer.rs owns the window and tells this page what is happening:
//   agent-start   { x, y }                       where the real pointer is when he begins
//   agent-cursor  { x, y, kind, label }          where he is going (physical pixels)
//   agent-status  { text }                       what he is thinking
//   agent-done    { ok, text }                   the task ended

import { onEvent } from "../core/bridge";
import { BotEngine, hexToRGB } from "../mochi/engine";

const canvas = document.getElementById("stage") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
const dpr = Math.max(1, window.devicePixelRatio || 1);
function resize() {
  canvas.width = Math.round(window.innerWidth * dpr);
  canvas.height = Math.round(window.innerHeight * dpr);
}
resize();
window.addEventListener("resize", resize);

const BLUE = "#3B82F6";
// The mini Mochi under the pointer: the same little Mochi as the "VS Code" pill (white body).
const engine = new BotEngine();
engine.isMini = true;
engine.bodyColor = hexToRGB("#F5F6F8");
engine.setState("working", true);
const MINI_BODY = 24;
const MINI_SIZE = MINI_BODY / 0.6;

let shown = false;
const pos = { x: 0, y: 0 };
const vel = { x: 0, y: 0 };
const target = { x: 0, y: 0 };
let label = "";
let bubble = "";
let bubbleUntil = 0;
let done: { ok: boolean } | null = null;
const ripples: { x: number; y: number; t: number }[] = [];

function logical(v: number) {
  return v / dpr;
}

void onEvent<{ x: number; y: number }>("agent-start", (p) => {
  pos.x = target.x = logical(p.x);
  pos.y = target.y = logical(p.y);
  shown = true;
  bubble = "On it!";
  bubbleUntil = performance.now() + 2500;
});
void onEvent<{ x: number; y: number; kind: string; label: string }>("agent-cursor", (p) => {
  target.x = logical(p.x);
  target.y = logical(p.y);
  label = p.label;
  if (p.kind === "click" || p.kind === "drag") ripples.push({ x: target.x, y: target.y, t: performance.now() });
});
void onEvent<{ text: string }>("agent-status", (p) => {
  bubble = p.text;
  bubbleUntil = performance.now() + 9000;
});
void onEvent<{ ok: boolean; text: string }>("agent-done", (p) => {
  done = { ok: p.ok };
  bubble = p.text;
  bubbleUntil = performance.now() + 6000;
  engine.setState(p.ok ? "finished" : "error");
});

function arrow() {
  // The classic pointer, in Mochi's blue, with a white edge and a glow.
  ctx.save();
  ctx.translate(pos.x, pos.y);
  ctx.shadowColor = BLUE;
  ctx.shadowBlur = 14;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, 22);
  ctx.lineTo(5.5, 17);
  ctx.lineTo(9.5, 26);
  ctx.lineTo(13, 24.5);
  ctx.lineTo(9, 15.5);
  ctx.lineTo(16, 15.5);
  ctx.closePath();
  ctx.fillStyle = BLUE;
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.lineWidth = 2;
  ctx.strokeStyle = "#fff";
  ctx.stroke();
  ctx.restore();
}

function wrap(text: string, max: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if (ctx.measureText(line + " " + w).width > max && line) {
      lines.push(line);
      line = w;
    } else line = line ? line + " " + w : w;
  }
  if (line) lines.push(line);
  return lines.slice(0, 4);
}

// The window covers the whole screen, so clearing and repainting all of it every frame would be
// heavy: only the two patches that are ever drawn on (around the pointer, and the banner at the
// top) are cleared, and the page runs at 30 frames a second.
let last = performance.now();
let patches: { x: number; y: number; w: number; h: number }[] = [];
function frame(now: number) {
  requestAnimationFrame(frame);
  if (now - last < 32) return;
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  for (const q of patches) ctx.clearRect(q.x, q.y, q.w, q.h);
  patches = [];
  if (shown) {
    patches = [
      { x: pos.x - 360, y: pos.y - 60, w: 740, h: 260 },
      { x: window.innerWidth / 2 - 260, y: 0, w: 520, h: 50 },
    ];
    // A spring: his pointer runs ahead of the real one and settles on the target.
    const k = 180;
    const c = 22;
    vel.x += ((target.x - pos.x) * k - vel.x * c) * dt;
    vel.y += ((target.y - pos.y) * k - vel.y * c) * dt;
    pos.x += vel.x * dt;
    pos.y += vel.y * dt;

    for (let i = ripples.length - 1; i >= 0; i--) {
      const age = (now - ripples[i].t) / 600;
      if (age > 1) {
        ripples.splice(i, 1);
        continue;
      }
      ctx.beginPath();
      ctx.arc(ripples[i].x, ripples[i].y, 6 + age * 34, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(59,130,246,${0.8 * (1 - age)})`;
      ctx.lineWidth = 3;
      ctx.stroke();
    }

    arrow();

    // Mini Mochi rides along, right under the pointer.
    engine.update(dt);
    ctx.save();
    ctx.translate(pos.x - 2, pos.y + 22);
    engine.draw(ctx, MINI_SIZE, MINI_SIZE);
    ctx.restore();

    if (bubble && now < bubbleUntil) {
      ctx.font = "600 13px system-ui, 'Segoe UI', sans-serif";
      const lines = wrap(bubble, 260);
      const w = Math.min(280, Math.max(...lines.map((l) => ctx.measureText(l).width)) + 20);
      const h = lines.length * 17 + 14;
      let bx = pos.x + 40;
      let by = pos.y + 30;
      if (bx + w > window.innerWidth - 8) bx = pos.x - w - 24;
      if (by + h > window.innerHeight - 8) by = window.innerHeight - h - 8;
      ctx.fillStyle = "rgba(20,21,24,0.94)";
      ctx.strokeStyle = BLUE;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.roundRect(bx, by, w, h, 12);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = done && !done.ok ? "#F4505E" : "#F5F6F8";
      ctx.textBaseline = "top";
      lines.forEach((l, i) => ctx.fillText(l, bx + 10, by + 8 + i * 17));
    } else if (label && !done) {
      ctx.font = "600 11px system-ui, 'Segoe UI', sans-serif";
      const w = ctx.measureText(label).width + 14;
      ctx.fillStyle = BLUE;
      ctx.beginPath();
      ctx.roundRect(pos.x + 40, pos.y + 30, w, 20, 10);
      ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.textBaseline = "middle";
      ctx.fillText(label, pos.x + 47, pos.y + 40.5);
    }

    // A reminder that he can be stopped.
    if (!done) {
      ctx.font = "600 12px system-ui, 'Segoe UI', sans-serif";
      const t = "Mochi is using your PC — press Esc to stop";
      const w = ctx.measureText(t).width + 24;
      const x = (window.innerWidth - w) / 2;
      ctx.fillStyle = "rgba(20,21,24,0.85)";
      ctx.beginPath();
      ctx.roundRect(x, 10, w, 26, 13);
      ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.textBaseline = "middle";
      ctx.fillText(t, x + 12, 23.5);
    }
  }
}
requestAnimationFrame(frame);
