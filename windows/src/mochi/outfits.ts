// Mochi's wardrobe: the outfits, the seasons, and the drawing.
//
// A port of design/outfits/mochi-outfits.js (the Canvas 2D reference) and of the Mac's
// MochiOutfitDrawing.swift / MochiWardrobe.swift. Coordinates are those of BotEngine.draw():
// the origin is the body's centre, y points down, R = W * 0.3, rx = 1.14 R, ry = 0.88 R.
// The head is a superellipsoid, so a hat, a pair of glasses or a scarf can be pinned to it
// in 3D and turn with it.

export type Outfit =
  | "auto" | "none" | "partyHat" | "beanie" | "crown" | "sunglasses" | "roundGlasses"
  | "bow" | "scarf" | "witchHat" | "pumpkin" | "santaHat" | "bunnyEars";

/** In the order the wardrobe shows them (Auto first). */
export const OUTFIT_LIST: { id: Outfit; name: string }[] = [
  { id: "auto", name: "Auto (seasons)" },
  { id: "none", name: "None" },
  { id: "partyHat", name: "Party hat" },
  { id: "beanie", name: "Beanie" },
  { id: "crown", name: "Crown" },
  { id: "sunglasses", name: "Sunglasses" },
  { id: "roundGlasses", name: "Round glasses" },
  { id: "bow", name: "Bow" },
  { id: "scarf", name: "Scarf" },
  { id: "witchHat", name: "Witch hat" },
  { id: "pumpkin", name: "Pumpkin" },
  { id: "santaHat", name: "Santa hat" },
  { id: "bunnyEars", name: "Bunny ears" },
];

export function outfitName(o: Outfit): string {
  return OUTFIT_LIST.find((e) => e.id === o)?.name ?? "None";
}

export function isOutfit(v: unknown): v is Outfit {
  return typeof v === "string" && OUTFIT_LIST.some((o) => o.id === v);
}

// ── Seasons ───────────────────────────────────────────────────────────────────

/** Meeus/Jones/Butcher: [month, day] of Easter Sunday. */
function easterDate(year: number): [number, number] {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return [month, day];
}

/** The outfit of the day: party hat > santa hat > witch hat > bunny ears > sunglasses > none. */
export function seasonalOutfit(date: Date = new Date()): Outfit {
  const day = date.getDate();
  const month = date.getMonth() + 1;
  const year = date.getFullYear();

  if ((month === 12 && day === 31) || (month === 1 && day <= 2)) return "partyHat";
  if (month === 12 && day <= 26) return "santaHat";
  if (month === 10 || (month === 11 && day === 1)) return "witchHat";

  const [em, ed] = easterDate(year);
  const easter = Date.UTC(year, em - 1, ed);
  const today = Date.UTC(year, month - 1, day);
  const delta = Math.round((today - easter) / 86_400_000);
  if (delta >= -2 && delta <= 1) return "bunnyEars";

  if ((month === 6 && day >= 21) || month === 7 || month === 8) return "sunglasses";
  return "none";
}

export function resolveOutfit(selection: Outfit, date: Date = new Date()): Outfit {
  return selection === "auto" ? seasonalOutfit(date) : selection;
}

// ── Head geometry ─────────────────────────────────────────────────────────────

const EXP = 2.7;
/** Accessories are seen slightly from above, so rings show as ellipses. */
const VIEW_TILT = -0.3;
const ACC_PITCH = 0.4;
const EYE_W = 0.25, EYE_H = 0.27, EYE_SP = 0.37, EYE_P = -0.12;

export interface MochiH {
  R: number; rx: number; ry: number;
  yaw: number; pitch: number;
  view: number;
  /** Spring lag of floppy parts (pompoms, hat tips), -1..1. */
  physDx: number; physDy: number;
}

export function makeH(R: number, yaw = 0, pitch = 0, physDx = 0, physDy = 0): MochiH {
  return { R, rx: R * 1.14, ry: R * 0.88, yaw, pitch, view: VIEW_TILT, physDx, physDy };
}

interface P3 { x: number; y: number; z: number }
type V3 = [number, number, number];

function ringR(y: number): number {
  const a = Math.min(1, Math.abs(y));
  return Math.pow(1 - Math.pow(a, EXP), 1 / EXP);
}

/** Rotate a head-local point (x right, y up, z toward the viewer) by yaw, then pitch. */
function rot(p: V3, yaw: number, pitch: number): V3 {
  const [x, y, z] = p;
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const x1 = x * cy + z * sy;
  const z1 = -x * sy + z * cy;
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  return [x1, y * cp + z1 * sp, -y * sp + z1 * cp];
}

/** Head-local → body space. Accessories follow the pitch only partly, so hats never flip to a top view. */
function proj(H: MochiH, p: V3): P3 {
  const r = rot(p, H.yaw, H.view + H.pitch * ACC_PITCH);
  return { x: r[0] * H.rx, y: -r[1] * H.ry, z: r[2] };
}

/** A point on the head's surface at height y and longitude lon (0 faces the viewer), scaled by s. */
function surf(y: number, lon: number, s = 1): V3 {
  const r = ringR(y) * s;
  return [r * Math.sin(lon), y, r * Math.cos(lon)];
}

/** The superellipse silhouette of the body. */
export function outfitBodyPath(rx: number, ry: number): Path2D {
  const p = new Path2D();
  const n = 96, e = 2 / EXP;
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    const ca = Math.cos(a), sa = Math.sin(a);
    const x = rx * Math.sign(ca) * Math.pow(Math.abs(ca), e);
    const y = ry * Math.sign(sa) * Math.pow(Math.abs(sa), e);
    if (i) p.lineTo(x, y); else p.moveTo(x, y);
  }
  p.closePath();
  return p;
}

/** Given the projected points of a closed ring, the arc facing the viewer, left to right. */
function silhouetteArc(pts: P3[]): P3[] {
  const n = pts.length;
  if (n < 2) return pts;
  let minI = 0, maxI = 0;
  for (let i = 1; i < n; i++) {
    if (pts[i].x < pts[minI].x) minI = i;
    if (pts[i].x > pts[maxI].x) maxI = i;
  }
  if (minI === maxI) return [pts[minI]];
  const walk = (step: number) => {
    const out: P3[] = [];
    let i = minI;
    for (;;) {
      out.push(pts[i]);
      if (i === maxI || out.length > n) break;
      i = (i + step + n) % n;
    }
    return out;
  };
  const a = walk(1), b = walk(-1);
  const meanZ = (arr: P3[]) => arr.reduce((s, q) => s + q.z, 0) / Math.max(1, arr.length);
  return meanZ(a) >= meanZ(b) ? a : b;
}

/** The front arc of the ring at height y (scaled by s), left to right. */
function frontArc(H: MochiH, y: number, s: number): P3[] {
  const n = 120;
  const pts: P3[] = [];
  for (let i = 0; i < n; i++) pts.push(proj(H, surf(y, -Math.PI + (i / n) * 2 * Math.PI, s)));
  return silhouetteArc(pts);
}

/** A clip region; "evenodd" ones are the complement of a path inside a big rectangle. */
interface Clip { p: Path2D; eo: boolean }
const clipTo = (x: CanvasRenderingContext2D, c: Clip | Path2D) =>
  c instanceof Path2D ? x.clip(c) : x.clip(c.p, c.eo ? "evenodd" : "nonzero");

/** The region of the head ABOVE the front arc of ring y: what a cap covers. */
function capClip(H: MochiH, y: number, s: number, extraTop = 3): Path2D {
  const arc = frontArc(H, y, s);
  const p = new Path2D();
  if (!arc.length) return p;
  p.moveTo(arc[0].x - H.rx, arc[0].y);
  for (const q of arc) p.lineTo(q.x, q.y);
  p.lineTo(arc[arc.length - 1].x + H.rx, arc[arc.length - 1].y);
  p.lineTo(H.rx * 2, -H.ry * extraTop);
  p.lineTo(-H.rx * 2, -H.ry * extraTop);
  p.closePath();
  return p;
}

function invert(p: Path2D, H: MochiH): Clip {
  const q = new Path2D();
  q.rect(-H.rx * 4, -H.ry * 4, H.rx * 8, H.ry * 8);
  q.addPath(p);
  return { p: q, eo: true };
}

// ── Little helpers ────────────────────────────────────────────────────────────

type Ctx = CanvasRenderingContext2D;

function lin(x: Ctx, x0: number, y0: number, x1: number, y1: number, stops: [number, string][]) {
  const g = x.createLinearGradient(x0, y0, x1, y1);
  for (const [o, c] of stops) g.addColorStop(o, c);
  return g;
}

function rad(x: Ctx, cx: number, cy: number, r0: number, r1: number, stops: [number, string][]) {
  const g = x.createRadialGradient(cx, cy, r0, cx, cy, Math.max(r1, r0 + 0.001));
  for (const [o, c] of stops) g.addColorStop(o, c);
  return g;
}

function roundRect(x: Ctx, px: number, py: number, w: number, h: number, r: number) {
  x.beginPath();
  x.moveTo(px + r, py);
  x.arcTo(px + w, py, px + w, py + h, r);
  x.arcTo(px + w, py + h, px, py + h, r);
  x.arcTo(px, py + h, px, py, r);
  x.arcTo(px, py, px + w, py, r);
  x.closePath();
}

function polyline(x: Ctx, arc: P3[]) {
  x.beginPath();
  arc.forEach((q, i) => (i ? x.lineTo(q.x, q.y) : x.moveTo(q.x, q.y)));
}

/** A soft round pompom made of overlapping puffs. */
function pompom(x: Ctx, px: number, py: number, r: number, base = "#FFFFFF", shade = "#D5D9E2") {
  x.save();
  x.translate(px, py);
  const n = 11;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const br = r * (0.34 + 0.06 * Math.sin(i * 2.3));
    const bx = Math.cos(a) * r * 0.78, by = Math.sin(a) * r * 0.78;
    x.fillStyle = rad(x, bx - br * 0.4, by - br * 0.5, 0, br * 1.3, [[0, base], [1, shade]]);
    x.beginPath();
    x.arc(bx, by, br, 0, Math.PI * 2);
    x.fill();
  }
  x.fillStyle = rad(x, -r * 0.3, -r * 0.35, 0, r * 1.05, [[0, base], [0.7, base], [1, shade]]);
  x.beginPath();
  x.arc(0, 0, r * 0.86, 0, Math.PI * 2);
  x.fill();
  x.restore();
}

/** A fuzzy band along a polyline (the Santa hat's trim). */
function fuzzyBand(x: Ctx, arc: P3[], thick: number, base = "#FFFFFF", shade = "#DADDE4") {
  if (arc.length < 2) return;
  x.save();
  x.lineJoin = "round";
  x.lineCap = "round";
  polyline(x, arc);
  x.strokeStyle = shade;
  x.lineWidth = thick;
  x.stroke();
  polyline(x, arc);
  x.strokeStyle = base;
  x.lineWidth = thick * 0.78;
  x.stroke();
  const step = Math.max(2, Math.floor(arc.length / 16));
  for (let i = 0; i < arc.length; i += step) {
    const q = arc[i];
    const r = thick * (0.32 + 0.1 * Math.sin(i * 1.7));
    x.fillStyle = rad(x, q.x - r * 0.3, q.y - thick * 0.35 - r * 0.3, 0, r * 1.2, [[0, base], [1, shade]]);
    x.beginPath();
    x.arc(q.x, q.y - thick * 0.32, r, 0, Math.PI * 2);
    x.fill();
  }
  x.restore();
}

// ── Eyes (for the glasses to sit on) ──────────────────────────────────────────

interface EyeFrame { sd: number; x: number; y: number; fx: number; fy: number; visible: boolean; w: number; h: number }

function eyeFrames(H: MochiH): EyeFrame[] {
  const out: EyeFrame[] = [];
  for (const sd of [-1, 1]) {
    const eyeYaw = sd * EYE_SP + H.yaw;
    const eyePitch = EYE_P + H.pitch;
    const cp = Math.cos(eyePitch);
    out.push({
      sd,
      visible: Math.cos(eyeYaw) * cp > 0.04,
      x: Math.sin(eyeYaw) * cp * H.rx,
      y: -Math.sin(eyePitch) * H.ry,
      fx: Math.max(0.18, Math.cos(eyeYaw)),
      fy: Math.max(0.18, cp),
      w: H.R * EYE_W,
      h: H.R * EYE_H,
    });
  }
  return out;
}

// ── The outfits ───────────────────────────────────────────────────────────────

/** The body's colours under an outfit (the pumpkin recolours the whole body). */
export const PUMPKIN_COLORS: readonly [string, string] = ["#FFA94D", "#E8590C"];

function beanieFront(x: Ctx, H: MochiH, body: Path2D) {
  const s = 1.035, yEdge = 0.42, yCuff = 0.58;
  const head = outfitBodyPath(H.rx * s, H.ry * s);
  x.save(); x.clip(body); x.clip(capClip(H, yEdge - 0.12, 1));
  x.fillStyle = "rgba(30,40,70,0.10)"; x.fill(body); x.restore();

  x.save(); x.clip(capClip(H, yCuff, s));
  x.fillStyle = lin(x, H.rx * 0.5, -H.ry * 1.1, -H.rx * 0.6, H.ry * 0.2, [[0, "#7DB6FF"], [1, "#2F6FE0"]]);
  x.fill(head);
  x.clip(head);
  for (let k = -6; k <= 6; k++) {
    const lon = k * 0.24;
    const pts: P3[] = [];
    for (let i = 0; i <= 16; i++) {
      const y = yCuff + ((1.05 - yCuff) * i) / 16;
      const q = proj(H, surf(y, lon, s));
      if (q.z > 0) pts.push(q);
    }
    if (pts.length < 2) continue;
    polyline(x, pts);
    x.strokeStyle = "rgba(20,50,140,0.16)"; x.lineWidth = H.R * 0.045; x.stroke();
  }
  x.restore();

  x.save(); x.clip(capClip(H, yEdge, s * 1.04)); clipTo(x, invert(capClip(H, yCuff, s * 1.04), H));
  const cuffHead = outfitBodyPath(H.rx * s * 1.04, H.ry * s * 1.04);
  x.fillStyle = lin(x, 0, -H.ry * 0.6, 0, -H.ry * 0.2, [[0, "#3C7BEA"], [1, "#2257C4"]]);
  x.fill(cuffHead);
  x.clip(cuffHead);
  for (let k = -14; k <= 14; k++) {
    const lon = k * 0.115;
    const a = proj(H, surf(yEdge, lon, s * 1.04)), b = proj(H, surf(yCuff, lon, s * 1.04));
    if (a.z < 0) continue;
    x.beginPath(); x.moveTo(a.x, a.y); x.lineTo(b.x, b.y);
    x.strokeStyle = "rgba(10,30,100,0.22)"; x.lineWidth = H.R * 0.035; x.stroke();
  }
  x.restore();

  x.save(); x.clip(capClip(H, yCuff, s)); x.clip(head);
  x.fillStyle = rad(x, H.rx * 0.3, -H.ry * 0.85, 0, H.R * 0.45, [[0, "rgba(255,255,255,0.35)"], [1, "rgba(255,255,255,0)"]]);
  x.fill(head); x.restore();

  const top = proj(H, [0, 1.08 * s, 0]);
  pompom(x, top.x + H.physDx * H.rx * 0.25, top.y - H.R * 0.12 + H.physDy * H.ry * 0.15, H.R * 0.24);
}

function santaHatFront(x: Ctx, H: MochiH, body: Path2D) {
  const s = 1.05, yEdge = 0.52;
  const arc = frontArc(H, yEdge, s);
  if (arc.length < 2) return;
  const L = arc[0], Rt = arc[arc.length - 1];
  const crown = proj(H, [0, 1.05, 0]);
  const side = 1;
  const tip = { x: crown.x + side * H.rx * (0.95 + H.physDx * 0.35), y: crown.y + H.ry * (0.05 + H.physDy * 0.2) };
  const peak = { x: crown.x + side * H.rx * 0.25, y: crown.y - H.ry * 0.62 };
  const bag = new Path2D();
  bag.moveTo(L.x, L.y);
  bag.bezierCurveTo(L.x - H.rx * 0.05, L.y - H.ry * 0.7, peak.x - H.rx * 0.55, peak.y - H.ry * 0.05, peak.x, peak.y);
  bag.quadraticCurveTo(tip.x - H.rx * 0.05, peak.y - H.ry * 0.02, tip.x, tip.y);
  bag.quadraticCurveTo(tip.x - H.rx * 0.12, tip.y - H.ry * 0.22, peak.x + H.rx * 0.18, peak.y + H.ry * 0.32);
  bag.bezierCurveTo(Rt.x + H.rx * 0.05, peak.y + H.ry * 0.45, Rt.x + H.rx * 0.08, Rt.y - H.ry * 0.35, Rt.x, Rt.y);
  for (let i = arc.length - 1; i >= 0; i--) bag.lineTo(arc[i].x, arc[i].y);
  bag.closePath();

  x.save(); x.clip(body); x.clip(capClip(H, yEdge - 0.14, 1)); x.fillStyle = "rgba(120,10,10,0.10)"; x.fill(body); x.restore();
  x.fillStyle = lin(x, -H.rx * 0.6, -H.ry * 1.6, H.rx * 0.7, -H.ry * 0.3, [[0, "#FF6B6B"], [0.55, "#E53935"], [1, "#B71C1C"]]);
  x.fill(bag);

  x.save(); x.clip(bag); x.lineCap = "round";
  for (const [a, b, w] of [[0.15, 0.55, 0.10], [0.45, 0.85, 0.08]]) {
    x.beginPath();
    x.moveTo(peak.x - H.rx * 0.1 + (Rt.x - L.x) * a * 0.3, peak.y + H.ry * 0.15);
    x.quadraticCurveTo(peak.x + H.rx * 0.35, peak.y + H.ry * (0.05 + a * 0.3), tip.x - H.rx * (0.45 - b * 0.3), tip.y - H.ry * 0.12);
    x.strokeStyle = "rgba(90,0,0,0.20)"; x.lineWidth = H.R * w; x.stroke();
  }
  x.fillStyle = rad(x, peak.x - H.rx * 0.25, peak.y + H.ry * 0.05, 0, H.R * 0.5, [[0, "rgba(255,255,255,0.32)"], [1, "rgba(255,255,255,0)"]]);
  x.fill(bag);
  x.restore();

  fuzzyBand(x, arc, H.R * 0.3);
  pompom(x, tip.x, tip.y + H.R * 0.04, H.R * 0.22);
}

function partyHatFront(x: Ctx, H: MochiH) {
  const baseY = 0.82, baseR = 0.42, lean = -0.24 + H.physDx * 0.12;
  const c = proj(H, [0.16, baseY + 0.06, 0]);
  const ring: P3[] = [];
  for (let i = 0; i <= 48; i++) {
    const a = (i / 48) * Math.PI * 2;
    ring.push(proj(H, [0.16 + baseR * Math.sin(a), baseY + 0.06, baseR * Math.cos(a)]));
  }
  const left = ring.reduce((m, q) => (q.x < m.x ? q : m));
  const right = ring.reduce((m, q) => (q.x > m.x ? q : m));
  const h = H.ry * 1.6;
  const apex = { x: c.x + Math.sin(lean) * h, y: c.y - Math.cos(lean) * h };
  const front = silhouetteArc(ring.slice(0, -1));
  const cone = new Path2D();
  cone.moveTo(left.x, left.y);
  cone.quadraticCurveTo((left.x + apex.x) / 2 - H.rx * 0.06, (left.y + apex.y) / 2, apex.x - H.R * 0.05, apex.y + H.R * 0.06);
  cone.quadraticCurveTo(apex.x, apex.y - H.R * 0.03, apex.x + H.R * 0.05, apex.y + H.R * 0.06);
  cone.quadraticCurveTo((right.x + apex.x) / 2 + H.rx * 0.06, (right.y + apex.y) / 2, right.x, right.y);
  for (let i = front.length - 1; i >= 0; i--) cone.lineTo(front[i].x, front[i].y);
  cone.closePath();
  x.fillStyle = lin(x, left.x, apex.y, right.x, left.y, [[0, "#FF9BD0"], [0.5, "#F15BAE"], [1, "#C2187A"]]);
  x.fill(cone);

  x.save(); x.clip(cone);
  const dots: [number, number][] = [[0.25, -0.35], [0.3, 0.3], [0.55, -0.05], [0.72, 0.28], [0.8, -0.3], [0.45, 0.6], [0.48, -0.65]];
  for (const [t, u] of dots) {
    const bx = left.x + (right.x - left.x) * (0.5 + u * 0.5);
    const by = left.y + (right.y - left.y) * (0.5 + u * 0.5);
    const px = bx + (apex.x - bx) * (1 - t);
    const py = by + (apex.y - by) * (1 - t);
    const r = H.R * 0.075 * (0.6 + t * 0.5);
    x.beginPath(); x.ellipse(px, py, r, r * 0.9, 0, 0, Math.PI * 2);
    x.fillStyle = "rgba(255,255,255,0.92)"; x.fill();
  }
  x.fillStyle = lin(x, left.x, 0, right.x, 0, [[0, "rgba(255,255,255,0.28)"], [0.35, "rgba(255,255,255,0)"], [1, "rgba(80,0,40,0.18)"]]);
  x.fill(cone);
  x.restore();

  polyline(x, front);
  x.strokeStyle = "#FFD84D"; x.lineWidth = H.R * 0.07; x.lineCap = "round"; x.stroke();
  pompom(x, apex.x, apex.y - H.R * 0.04, H.R * 0.16, "#FFE27A", "#F2B705");
}

// Crown: a golden band AROUND the head with spikes all round; the back ones sit behind it.
const CROWN = { s: 1.06, yb: 0.46, yt: 0.66, n: 8, spikeH: 0.42 };

function crownPart(x: Ctx, H: MochiH, side: -1 | 1) {
  const { s, yb, yt, n, spikeH } = CROWN;
  const N = 120;
  const seg: { b: P3; tt: P3; z: number }[] = [];
  for (let i = 0; i <= N; i++) {
    const lon = -Math.PI + (i / N) * 2 * Math.PI;
    const b = proj(H, surf(yb, lon, s));
    const phase = ((lon + Math.PI) / (2 * Math.PI)) * n;
    const f = phase - Math.floor(phase);
    const spike = Math.pow(Math.max(0, 1 - Math.abs(f - 0.5) * 2), 1.6);
    const topY = yt + spikeH * spike;
    const sp = surf(yt, lon, s);
    const tt = proj(H, [sp[0] * (1 - 0.08 * spike), topY, sp[2] * (1 - 0.08 * spike)]);
    seg.push({ b, tt, z: b.z });
  }
  const keep = seg.filter((q) => (side > 0 ? q.z >= 0 : q.z < 0.02));
  if (keep.length < 2) return;
  keep.sort((a, b) => a.b.x - b.b.x);
  const shape = new Path2D();
  keep.forEach((q, i) => (i ? shape.lineTo(q.tt.x, q.tt.y) : shape.moveTo(q.tt.x, q.tt.y)));
  for (let i = keep.length - 1; i >= 0; i--) shape.lineTo(keep[i].b.x, keep[i].b.y);
  shape.closePath();
  const dark = side < 0;
  x.fillStyle = lin(x, 0, -H.ry * 1.05, 0, -H.ry * 0.45,
    dark ? [[0, "#C98A12"], [1, "#8A5A06"]] : [[0, "#FFE58A"], [0.5, "#FBBF24"], [1, "#D08A0B"]]);
  x.fill(shape);
  if (dark) return;

  x.save(); x.clip(shape);
  x.fillStyle = lin(x, -H.rx, 0, H.rx, 0, [[0, "rgba(120,70,0,0.25)"], [0.45, "rgba(255,255,255,0.0)"], [0.62, "rgba(255,255,255,0.35)"], [1, "rgba(120,70,0,0.25)"]]);
  x.fill(shape); x.restore();
  const gems = ["#EF4444", "#3B82F6", "#22C55E", "#A855F7"];
  for (let k = 0; k < n; k++) {
    const lon = -Math.PI + ((k + 0.5) / n) * 2 * Math.PI;
    const sp = surf(yt, lon, s);
    const tipP = proj(H, [sp[0] * 0.92, yt + spikeH, sp[2] * 0.92]);
    const mid = proj(H, surf((yb + yt) / 2, lon, s * 1.01));
    if (mid.z <= 0.12) continue;
    const r = H.R * 0.055;
    x.beginPath(); x.arc(tipP.x, tipP.y - r * 0.5, r, 0, Math.PI * 2);
    x.fillStyle = rad(x, tipP.x - r * 0.3, tipP.y - r, 0, r * 1.2, [[0, "#FFF6CC"], [1, "#E0A21A"]]); x.fill();
    const gr = H.R * 0.075;
    x.beginPath(); x.ellipse(mid.x, mid.y, gr * Math.max(0.35, mid.z), gr, 0, 0, Math.PI * 2);
    x.fillStyle = gems[k % gems.length]; x.fill();
    x.beginPath(); x.arc(mid.x - gr * 0.25 * mid.z, mid.y - gr * 0.35, gr * 0.28, 0, Math.PI * 2);
    x.fillStyle = "rgba(255,255,255,0.75)"; x.fill();
  }
}

function crownFront(x: Ctx, H: MochiH, body: Path2D) {
  x.save(); x.clip(body); x.clip(capClip(H, CROWN.yb - 0.1, 1)); clipTo(x, invert(capClip(H, CROWN.yb, 1), H));
  x.fillStyle = "rgba(80,50,0,0.12)"; x.fill(body); x.restore();
  crownPart(x, H, 1);
}

// Witch hat: a wide floppy brim, a tall cone with a bent tip, an orange band and a gold buckle.
function witchBrimPts(H: MochiH): P3[] {
  const y = 0.7, rr = 1.42;
  const pts: P3[] = [];
  for (let i = 0; i <= 120; i++) {
    const a = -Math.PI + (i / 120) * 2 * Math.PI;
    const wob = 1 + 0.035 * Math.sin(a * 3 + 0.6);
    const droop = -0.1 * Math.pow(Math.abs(Math.sin(a)), 2);
    pts.push(proj(H, [rr * wob * Math.sin(a), y + droop, rr * wob * Math.cos(a)]));
  }
  return pts;
}

function witchBack(x: Ctx, H: MochiH) {
  const ell = new Path2D();
  witchBrimPts(H).forEach((q, i) => (i ? ell.lineTo(q.x, q.y) : ell.moveTo(q.x, q.y)));
  ell.closePath();
  x.fillStyle = lin(x, 0, -H.ry * 1.0, 0, -H.ry * 0.4, [[0, "#2A0A4F"], [1, "#3B0F6B"]]);
  x.fill(ell);
}

function witchFront(x: Ctx, H: MochiH, body: Path2D) {
  const all = witchBrimPts(H);
  const brim = new Path2D();
  all.forEach((q, i) => (i ? brim.lineTo(q.x, q.y) : brim.moveTo(q.x, q.y)));
  brim.closePath();
  const fr = all.filter((p) => p.z >= 0).sort((a, b) => a.x - b.x);
  x.save(); x.clip(body); x.clip(capClip(H, 0.5, 1)); x.fillStyle = "rgba(40,0,70,0.10)"; x.fill(body); x.restore();
  x.fillStyle = lin(x, 0, -H.ry * 0.9, 0, -H.ry * 0.3, [[0, "#5B21B6"], [1, "#3B0764"]]);
  x.fill(brim);
  polyline(x, fr);
  x.strokeStyle = "rgba(190,150,255,0.35)"; x.lineWidth = H.R * 0.035; x.stroke();

  const baseR = 0.62, by = 0.74;
  const bl = proj(H, [-baseR, by, 0]), br = proj(H, [baseR, by, 0]);
  const c = proj(H, [0, by, 0]);
  const lean = 0.1 + H.physDx * 0.15;
  const top = { x: c.x + H.rx * 0.18 + Math.sin(lean) * H.ry * 0.3, y: c.y - H.ry * 1.25 };
  const tip = { x: top.x + H.rx * (0.45 + H.physDx * 0.25), y: top.y + H.ry * (0.22 + H.physDy * 0.1) };
  const cone = new Path2D();
  cone.moveTo(bl.x, bl.y);
  cone.bezierCurveTo(bl.x + H.rx * 0.12, bl.y - H.ry * 0.5, top.x - H.rx * 0.28, top.y + H.ry * 0.25, top.x - H.rx * 0.02, top.y - H.ry * 0.02);
  cone.quadraticCurveTo(top.x + H.rx * 0.25, top.y - H.ry * 0.08, tip.x, tip.y);
  cone.quadraticCurveTo(top.x + H.rx * 0.22, top.y + H.ry * 0.08, top.x + H.rx * 0.14, top.y + H.ry * 0.22);
  cone.bezierCurveTo(br.x - H.rx * 0.18, c.y - H.ry * 0.45, br.x - H.rx * 0.02, br.y - H.ry * 0.2, br.x, br.y);
  const capFront = frontArc(H, by, baseR / ringR(by)).filter((q) => q.x >= bl.x - 1 && q.x <= br.x + 1);
  for (let i = capFront.length - 1; i >= 0; i--) cone.lineTo(capFront[i].x, capFront[i].y);
  cone.closePath();
  x.fillStyle = lin(x, bl.x, top.y, br.x, bl.y, [[0, "#7C3AED"], [0.55, "#4C1D95"], [1, "#2E1065"]]);
  x.fill(cone);

  x.save(); x.clip(cone);
  x.fillStyle = lin(x, bl.x, 0, br.x, 0, [[0, "rgba(255,255,255,0.22)"], [0.4, "rgba(255,255,255,0)"], [1, "rgba(0,0,0,0.15)"]]);
  x.fill(cone);
  x.beginPath(); x.moveTo(top.x - H.rx * 0.05, top.y + H.ry * 0.05);
  x.quadraticCurveTo(top.x + H.rx * 0.1, top.y + H.ry * 0.12, top.x + H.rx * 0.2, top.y + H.ry * 0.06);
  x.strokeStyle = "rgba(20,0,40,0.35)"; x.lineWidth = H.R * 0.05; x.lineCap = "round"; x.stroke();
  const fc = proj(H, [0, by, baseR]);
  const lift = H.ry * 0.11;
  x.beginPath();
  x.moveTo(bl.x - 2, bl.y - lift);
  x.quadraticCurveTo(fc.x, 2 * (fc.y - lift) - (bl.y + br.y) / 2 + lift * 0.0, br.x + 2, br.y - lift);
  x.strokeStyle = "#F97316"; x.lineWidth = H.ry * 0.17; x.lineCap = "butt"; x.stroke();
  x.restore();

  const bk0 = proj(H, [0, by, baseR]);
  const bw = H.R * 0.2, bh = H.R * 0.16;
  x.save(); x.translate(bk0.x, bk0.y - H.ry * 0.11);
  roundRect(x, -bw / 2, -bh / 2, bw, bh, bh * 0.25); x.fillStyle = "#FCD34D"; x.fill();
  roundRect(x, -bw / 2 + bw * 0.24, -bh / 2 + bh * 0.28, bw * 0.52, bh * 0.44, bh * 0.1); x.fillStyle = "#C2410C"; x.fill();
  x.restore();
}

// Glasses are pinned to the real eye positions.
function lensPath(x: Ctx, e: EyeFrame, w: number, h: number, r: number) {
  x.save(); x.translate(e.x, e.y); x.scale(e.fx, e.fy);
  roundRect(x, -w / 2, -h / 2, w, h, r);
  x.restore();
}

function sunglassesFront(x: Ctx, H: MochiH, body: Path2D) {
  const eyes = eyeFrames(H);
  const w = H.R * 0.62, h = H.R * 0.46;
  x.save(); x.clip(body);
  const [l, r] = eyes;
  if (l.visible && r.visible) {
    x.beginPath(); x.moveTo(l.x + (w / 2) * l.fx * 0.9, l.y - h * 0.18);
    x.quadraticCurveTo((l.x + r.x) / 2, (l.y + r.y) / 2 - h * 0.42, r.x - (w / 2) * r.fx * 0.9, r.y - h * 0.18);
    x.strokeStyle = "#111317"; x.lineWidth = H.R * 0.07; x.stroke();
  }
  for (const e of eyes) {
    if (!e.visible) continue;
    const ox = e.x + ((e.sd * w) / 2) * e.fx;
    x.beginPath(); x.moveTo(ox, e.y - h * 0.2); x.lineTo(e.sd * H.rx * 1.05, e.y - h * 0.35);
    x.strokeStyle = "#111317"; x.lineWidth = H.R * 0.06; x.stroke();
  }
  for (const e of eyes) {
    if (!e.visible) continue;
    lensPath(x, e, w, h, h * 0.42); x.fillStyle = "rgba(17,19,23,0.82)"; x.fill();
    x.lineWidth = H.R * 0.05; x.strokeStyle = "#0B0C0F"; x.stroke();
    x.save(); x.translate(e.x, e.y); x.scale(e.fx, e.fy);
    x.beginPath(); x.moveTo(-w * 0.28, -h * 0.05); x.lineTo(-w * 0.05, -h * 0.3);
    x.strokeStyle = "rgba(255,255,255,0.45)"; x.lineWidth = H.R * 0.05; x.lineCap = "round"; x.stroke();
    x.restore();
  }
  x.restore();
}

function roundGlassesFront(x: Ctx, H: MochiH, body: Path2D) {
  const eyes = eyeFrames(H);
  const d = H.R * 0.56;
  x.save(); x.clip(body);
  const [l, r] = eyes;
  if (l.visible && r.visible) {
    x.beginPath(); x.moveTo(l.x + (d / 2) * l.fx, l.y - d * 0.08);
    x.quadraticCurveTo((l.x + r.x) / 2, (l.y + r.y) / 2 - d * 0.3, r.x - (d / 2) * r.fx, r.y - d * 0.08);
    x.strokeStyle = "#8A4B12"; x.lineWidth = H.R * 0.055; x.stroke();
  }
  for (const e of eyes) {
    if (!e.visible) continue;
    x.beginPath(); x.moveTo(e.x + ((e.sd * d) / 2) * e.fx, e.y - d * 0.1); x.lineTo(e.sd * H.rx * 1.05, e.y - d * 0.25);
    x.strokeStyle = "#8A4B12"; x.lineWidth = H.R * 0.05; x.stroke();
  }
  for (const e of eyes) {
    if (!e.visible) continue;
    x.save(); x.translate(e.x, e.y); x.scale(e.fx, e.fy);
    x.beginPath(); x.arc(0, 0, d / 2, 0, Math.PI * 2);
    x.fillStyle = "rgba(190,225,255,0.18)"; x.fill();
    x.lineWidth = H.R * 0.065; x.strokeStyle = "#9A5A1A"; x.stroke();
    x.beginPath(); x.arc(0, 0, d / 2 - H.R * 0.03, Math.PI * 1.1, Math.PI * 1.45);
    x.strokeStyle = "rgba(255,255,255,0.55)"; x.lineWidth = H.R * 0.03; x.stroke();
    x.restore();
  }
  x.restore();
}

// Scarf: a knitted band wrapped low round the body, with a knot and a hanging end.
function scarfFront(x: Ctx, H: MochiH) {
  const s = 1.05, y0 = -0.34, y1 = -0.66;
  const top = frontArc(H, y0, s), bot = frontArc(H, y1, s);
  if (top.length < 2 || bot.length < 2) return;
  const band = new Path2D();
  top.forEach((q, i) => (i ? band.lineTo(q.x, q.y) : band.moveTo(q.x, q.y)));
  for (let i = bot.length - 1; i >= 0; i--) band.lineTo(bot[i].x, bot[i].y);
  band.closePath();

  x.save(); x.clip(outfitBodyPath(H.rx * s, H.ry * s));
  x.fillStyle = lin(x, 0, -H.ry * 0.2, 0, H.ry * 0.7, [[0, "#F87171"], [1, "#B91C1C"]]); x.fill(band);
  x.clip(band);
  for (const lon of [-1.0, -0.45, 0.1, 0.65, 1.2]) {
    const a = proj(H, surf(y0, lon, s)), b = proj(H, surf(y1, lon, s));
    if (a.z < 0) continue;
    x.beginPath(); x.moveTo(a.x, a.y - 4); x.lineTo(b.x, b.y + 4);
    x.strokeStyle = "rgba(255,255,255,0.85)"; x.lineWidth = H.R * 0.09 * Math.max(0.3, a.z); x.stroke();
  }
  x.fillStyle = lin(x, 0, -H.ry * 0.5, 0, H.ry * 0.3, [[0, "rgba(255,255,255,0.18)"], [1, "rgba(0,0,0,0.1)"]]); x.fill(band);
  x.restore();

  const k = proj(H, surf((y0 + y1) / 2, -0.55, s * 1.03));
  if (k.z <= 0) return;
  const sw = H.physDx * H.rx * 0.12;
  const end = new Path2D();
  end.moveTo(k.x - H.R * 0.16, k.y);
  end.quadraticCurveTo(k.x - H.R * 0.24 + sw, k.y + H.ry * 0.35, k.x - H.R * 0.2 + sw * 1.4, k.y + H.ry * 0.62);
  end.lineTo(k.x + H.R * 0.06 + sw * 1.4, k.y + H.ry * 0.6);
  end.quadraticCurveTo(k.x + H.R * 0.02 + sw, k.y + H.ry * 0.3, k.x + H.R * 0.12, k.y);
  end.closePath();
  x.fillStyle = lin(x, 0, k.y, 0, k.y + H.ry * 0.6, [[0, "#EF4444"], [1, "#B91C1C"]]); x.fill(end);
  x.save(); x.clip(end);
  x.fillStyle = "rgba(255,255,255,0.85)";
  for (const t of [0.35, 0.7]) x.fillRect(k.x - H.R * 0.4 + sw, k.y + H.ry * 0.62 * t, H.R * 0.8, H.R * 0.07);
  x.restore();
  for (let i = 0; i < 4; i++) {
    const fx = k.x - H.R * 0.17 + sw * 1.4 + i * H.R * 0.075;
    x.beginPath(); x.moveTo(fx, k.y + H.ry * 0.6); x.lineTo(fx, k.y + H.ry * 0.72);
    x.strokeStyle = "#DC2626"; x.lineWidth = H.R * 0.035; x.lineCap = "round"; x.stroke();
  }
  x.beginPath(); x.ellipse(k.x, k.y, H.R * 0.17, H.R * 0.14, 0.2, 0, Math.PI * 2);
  x.fillStyle = rad(x, k.x - H.R * 0.05, k.y - H.R * 0.05, 0, H.R * 0.2, [[0, "#F87171"], [1, "#B91C1C"]]); x.fill();
}

// Pumpkin: the body recolours (see PUMPKIN_COLORS); soft ribs follow the meridians, then a stem and a leaf.
function pumpkinFront(x: Ctx, H: MochiH, body: Path2D) {
  x.save(); x.clip(body);
  for (const lon of [-1.15, -0.55, 0.0, 0.55, 1.15]) {
    const pts: P3[] = [];
    for (let i = 0; i <= 30; i++) {
      const y = -0.98 + (1.96 * i) / 30;
      const q = proj(H, surf(y, lon, 1));
      if (q.z > 0) pts.push(q);
    }
    if (pts.length < 2) continue;
    polyline(x, pts);
    const zz = pts[Math.floor(pts.length / 2)].z;
    x.strokeStyle = `rgba(150,50,0,${0.22 * zz})`; x.lineWidth = H.R * 0.12; x.lineCap = "round"; x.stroke();
    x.strokeStyle = `rgba(255,220,170,${0.18 * zz})`; x.lineWidth = H.R * 0.04;
    x.save(); x.translate(H.R * 0.07, 0); x.stroke(); x.restore();
  }
  x.restore();

  const t = proj(H, [0.02, 1.0, 0]);
  x.beginPath(); x.moveTo(t.x - H.R * 0.09, t.y + H.R * 0.04);
  x.quadraticCurveTo(t.x - H.R * 0.08, t.y - H.R * 0.22, t.x + H.R * 0.08, t.y - H.R * 0.3);
  x.lineTo(t.x + H.R * 0.13, t.y - H.R * 0.22);
  x.quadraticCurveTo(t.x + H.R * 0.04, t.y - H.R * 0.15, t.x + H.R * 0.08, t.y + H.R * 0.04); x.closePath();
  x.fillStyle = lin(x, t.x - H.R * 0.1, 0, t.x + H.R * 0.1, 0, [[0, "#65A30D"], [1, "#3F6212"]]); x.fill();

  x.save(); x.translate(t.x - H.R * 0.06, t.y - H.R * 0.02); x.rotate(-0.5);
  x.beginPath(); x.moveTo(0, 0);
  x.quadraticCurveTo(-H.R * 0.18, -H.R * 0.2, -H.R * 0.38, -H.R * 0.02);
  x.quadraticCurveTo(-H.R * 0.18, H.R * 0.1, 0, 0);
  x.fillStyle = lin(x, 0, -H.R * 0.15, -H.R * 0.3, 0, [[0, "#84CC16"], [1, "#4D7C0F"]]); x.fill();
  x.beginPath(); x.moveTo(-H.R * 0.02, -H.R * 0.01);
  x.quadraticCurveTo(-H.R * 0.18, -H.R * 0.08, -H.R * 0.32, -H.R * 0.03);
  x.strokeStyle = "rgba(30,60,0,0.4)"; x.lineWidth = H.R * 0.02; x.stroke();
  x.restore();

  x.beginPath(); x.moveTo(t.x + H.R * 0.1, t.y - H.R * 0.12);
  x.bezierCurveTo(t.x + H.R * 0.3, t.y - H.R * 0.25, t.x + H.R * 0.35, t.y - H.R * 0.02, t.x + H.R * 0.22, t.y - H.R * 0.06);
  x.strokeStyle = "#4D7C0F"; x.lineWidth = H.R * 0.03; x.lineCap = "round"; x.stroke();
}

// Bow: anchored in 3D so it turns with the head.
function bowFront(x: Ctx, H: MochiH) {
  const a = proj(H, surf(0.86, 0.55, 1.02));
  if (a.z < -0.2) return;
  const s = H.R * 0.26, sq = Math.max(0.45, Math.cos(0.55 + H.yaw));
  x.save(); x.translate(a.x, a.y); x.rotate(0.35 + H.yaw * 0.3); x.scale(sq, 1);
  for (const sd of [-1, 1]) {
    x.beginPath(); x.moveTo(0, 0);
    x.bezierCurveTo(sd * s * 0.6, -s * 0.85, sd * s * 1.35, -s * 0.55, sd * s * 1.15, 0);
    x.bezierCurveTo(sd * s * 1.35, s * 0.55, sd * s * 0.6, s * 0.85, 0, 0);
    x.fillStyle = lin(x, 0, -s, 0, s, [[0, "#FF8CC6"], [1, "#DB2777"]]); x.fill();
    x.beginPath(); x.moveTo(sd * s * 0.25, -s * 0.05);
    x.quadraticCurveTo(sd * s * 0.7, -s * 0.15, sd * s * 0.95, -s * 0.05);
    x.strokeStyle = "rgba(140,10,70,0.35)"; x.lineWidth = s * 0.08; x.lineCap = "round"; x.stroke();
  }
  x.beginPath(); x.ellipse(0, 0, s * 0.24, s * 0.3, 0, 0, Math.PI * 2);
  x.fillStyle = rad(x, -s * 0.06, -s * 0.1, 0, s * 0.35, [[0, "#FFB3D9"], [1, "#C2185B"]]); x.fill();
  x.restore();
}

// Bunny ears: behind the head, so only the tips show.
function bunnyEarsBack(x: Ctx, H: MochiH) {
  const R = H.R;
  const earH = R * 0.85;
  for (const sd of [-1, 1]) {
    const root = proj(H, [sd * 0.45, 0.92, 0]);
    const rootL = proj(H, [sd * 0.45 - 0.22, 0.92, 0]);
    const rootR = proj(H, [sd * 0.45 + 0.22, 0.92, 0]);
    const visHW = Math.max(R * 0.04, Math.abs(rootR.x - rootL.x) / 2);
    const cx = root.x;
    const cy = root.y - earH * 0.65 + earH * 0.5;
    x.save();
    x.translate(cx, cy);
    x.beginPath(); x.ellipse(0, 0, visHW, earH / 2, 0, 0, Math.PI * 2);
    x.fillStyle = "#F9F0F0"; x.fill();
    x.strokeStyle = "rgba(0,0,0,0.06)"; x.lineWidth = 0.8; x.stroke();
    x.beginPath(); x.ellipse(0, -earH / 2 + R * 0.1 + (earH * 0.65) / 2, visHW * 0.5, (earH * 0.65) / 2, 0, 0, Math.PI * 2);
    x.fillStyle = "rgba(252,165,165,0.70)"; x.fill();
    x.restore();
  }
}

// ── Dispatchers ───────────────────────────────────────────────────────────────

const easeBack = (t: number) => {
  const c1 = 1.70158, c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};

/**
 * Draws one outfit piece on a layer of its own, so overlapping shapes do not show through
 * each other while it fades in. A steady (fully opaque) piece is drawn straight onto the canvas.
 */
function layer(x: Ctx, alpha: number, move: (x: Ctx) => void, draw: (x: Ctx) => void) {
  if (alpha >= 0.995) {
    x.save(); move(x); draw(x); x.restore();
    return;
  }
  if (alpha <= 0.005) return;
  const cv = x.canvas;
  const off = document.createElement("canvas");
  off.width = cv.width;
  off.height = cv.height;
  const o = off.getContext("2d");
  if (!o) return;
  o.setTransform(x.getTransform());
  move(o); draw(o);
  x.save();
  x.setTransform(1, 0, 0, 1, 0, 0);
  x.globalAlpha *= alpha;
  x.drawImage(off, 0, 0);
  x.restore();
}

const HATS: ReadonlySet<Outfit> = new Set<Outfit>(["beanie", "santaHat", "partyHat", "crown", "witchHat"]);

/** What goes behind the body: the bunny ears, the back half of the crown and the witch hat's brim. */
export function drawOutfitBack(x: Ctx, outfit: Outfit, H: MochiH, presence: number, morph: number) {
  if (outfit === "none" || outfit === "auto") return;
  const morphFade = 1 - Math.min(1, Math.max(0, (morph - 0.3) / 0.2));
  const alpha = morphFade * Math.min(1, presence * 2.5);
  if (alpha < 0.005) return;
  const posP = easeBack(Math.min(1, Math.max(0, presence)));
  const hatScale = 0.85 + 0.15 * posP;
  const drop = (c: Ctx) => { c.translate(0, -(1 - posP) * H.ry); c.scale(hatScale, hatScale); };
  switch (outfit) {
    case "bunnyEars": layer(x, alpha, drop, (c) => bunnyEarsBack(c, H)); break;
    case "crown": layer(x, alpha, drop, (c) => crownPart(c, H, -1)); break;
    case "witchHat": layer(x, alpha, drop, (c) => witchBack(c, H)); break;
  }
}

/** What goes in front of the body and the eyes. */
export function drawOutfitFront(x: Ctx, outfit: Outfit, H: MochiH, presence: number, morph: number) {
  if (outfit === "none" || outfit === "auto" || outfit === "bunnyEars") return;
  const morphFade = 1 - Math.min(1, Math.max(0, (morph - 0.3) / 0.2));
  const alpha = morphFade * Math.min(1, presence * 2.5);
  if (alpha < 0.005) return;
  const body = outfitBodyPath(H.rx, H.ry);
  const posP = easeBack(Math.min(1, Math.max(0, presence)));
  const hatScale = 0.85 + 0.15 * posP;
  const p = Math.min(1, Math.max(0, presence));

  let move: (c: Ctx) => void = () => {};
  if (HATS.has(outfit)) {
    move = (c) => { c.translate(0, -(1 - posP) * H.ry); c.scale(hatScale, hatScale); };
  } else if (outfit === "sunglasses" || outfit === "roundGlasses") {
    move = (c) => c.translate(0, (1 - p) * 0.25 * H.ry);
  } else if (outfit === "scarf") {
    move = (c) => c.translate(0, (1 - p) * 0.3 * H.ry);
  } else if (outfit === "bow") {
    move = (c) => c.scale(Math.max(0.001, posP), Math.max(0.001, posP));
  }

  layer(x, alpha, move, (c) => {
    switch (outfit) {
      case "beanie": beanieFront(c, H, body); break;
      case "santaHat": santaHatFront(c, H, body); break;
      case "partyHat": partyHatFront(c, H); break;
      case "crown": crownFront(c, H, body); break;
      case "witchHat": witchFront(c, H, body); break;
      case "sunglasses": sunglassesFront(c, H, body); break;
      case "roundGlasses": roundGlassesFront(c, H, body); break;
      case "scarf": scarfFront(c, H); break;
      case "pumpkin": pumpkinFront(c, H, body); break;
      case "bow": bowFront(c, H); break;
    }
  });
}

/**
 * A small still of Mochi in an outfit, for the wardrobe's tiles. `outfit` may be "none" (a bare Mochi).
 * The canvas is `size` CSS pixels square; the caller applies the device pixel ratio.
 */
export function drawOutfitIcon(x: Ctx, size: number, outfit: Outfit) {
  const R = size * 0.3;
  const H = makeH(R);
  x.save();
  x.translate(size / 2, size / 2 + R * 0.4);
  const body = outfitBodyPath(H.rx, H.ry);
  drawOutfitBack(x, outfit, H, 1, 0);
  const colors = outfit === "pumpkin" ? PUMPKIN_COLORS : (["#EDEDEF", "#C4C5CA"] as const);
  x.fillStyle = lin(x, H.rx * 0.7, -H.ry * 0.85, -H.rx * 0.8, H.ry * 0.9, [[0, colors[0]], [1, colors[1]]]);
  x.fill(body);
  x.fillStyle = rad(x, H.rx * 0.34, -H.ry * 0.46, 0, R * 0.42, [[0, "rgba(255,255,255,0.55)"], [1, "rgba(255,255,255,0)"]]);
  x.fill(body);
  x.save(); x.clip(body);
  for (const e of eyeFrames(H)) {
    if (!e.visible) continue;
    x.save(); x.translate(e.x, e.y); x.scale(e.fx, e.fy);
    x.fillStyle = "rgb(26,20,18)";
    roundRect(x, -e.w / 2, -e.h / 2, e.w, e.h, Math.min(e.w, e.h) / 2); x.fill();
    x.restore();
  }
  x.restore();
  drawOutfitFront(x, outfit, H, 1, 0);
  x.restore();
}
