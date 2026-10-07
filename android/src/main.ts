// Coucou for Android: Mochi, a chat with any AI provider, the weather and a wardrobe.
// Mochi himself is the very same engine as on the PC (../windows/src/mochi).

import "./style.css";
import { Bridge, DEFAULT_SETTINGS, type Place, type Settings, type Weather } from "./bridge";
import { BotEngine } from "../../windows/src/mochi/engine";
import { drawOutfitIcon, OUTFIT_LIST, outfitName, resolveOutfit, seasonalOutfit, type Outfit } from "../../windows/src/mochi/outfits";
import { Sound } from "../../windows/src/core/sound";

type Tab = "home" | "chat" | "settings";

let settings: Settings = { ...DEFAULT_SETTINGS };
let tab: Tab = "home";
let weather: Weather | null = null;
let weatherAt = 0;
let weatherError = "";
const messages: { who: "me" | "mochi" | "note"; text: string }[] = [];
let sending = false;

const engine = new BotEngine();
const mochiCanvas = document.createElement("canvas");
const MOCHI = 220;
let mochiBox: HTMLElement | null = null;

const app = document.getElementById("app")!;

// ── helpers ───────────────────────────────────────────────────────────────────

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...kids: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "text") e.textContent = v;
    else e.setAttribute(k, v);
  }
  e.append(...kids);
  return e;
}

function save() {
  void Bridge.saveSettings(settings).catch(() => undefined);
}

function applyLook() {
  Sound.setEnabled(settings.soundEnabled);
  Sound.setVolume(settings.soundVolume);
  engine.setOutfit(resolveOutfit(settings.mochiOutfit as Outfit), true);
}

const WMO: Record<number, string> = {
  0: "Clear", 1: "Mostly clear", 2: "Partly cloudy", 3: "Overcast", 45: "Fog", 48: "Rime fog",
  51: "Light drizzle", 53: "Drizzle", 55: "Heavy drizzle", 61: "Light rain", 63: "Rain", 65: "Heavy rain",
  71: "Light snow", 73: "Snow", 75: "Heavy snow", 77: "Snow grains", 80: "Showers", 81: "Showers",
  82: "Violent showers", 85: "Snow showers", 86: "Snow showers", 95: "Thunderstorm", 96: "Thunderstorm", 99: "Thunderstorm",
};
const weatherLabel = (c: number) => WMO[c] ?? "—";
const deg = (v: number) => `${Math.round(v)}°`;
const weekday = (iso: string) => new Date(iso + "T12:00:00").toLocaleDateString(undefined, { weekday: "short" });

async function loadWeather(force = false) {
  if (!settings.showWeather || !settings.weatherPlace) { weather = null; return; }
  if (!force && weather && Date.now() - weatherAt < 15 * 60_000) return;
  try {
    weather = await Bridge.weatherGet(settings.weatherLat, settings.weatherLon, settings.weatherFahrenheit);
    weatherAt = Date.now();
    weatherError = "";
  } catch (e) {
    weatherError = (e as Error).message;
  }
  if (tab === "home") render();
}

// ── screens ───────────────────────────────────────────────────────────────────

function homeScreen(): HTMLElement {
  const hour = new Date().getHours();
  const greet = hour < 5 ? "Still up?" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  mochiBox = el("div", { class: "mochi-box" }, mochiCanvas);
  const wrap = el("div", { class: "screen" }, mochiBox, el("h1", { text: greet }), el("p", { class: "sub", text: "Tap Mochi. Go on." }));

  if (settings.showWeather) {
    const card = el("section", { class: "card" });
    if (!settings.weatherPlace) {
      card.append(el("p", { class: "sub", text: "Pick a city in Settings to see the weather." }));
    } else if (weather) {
      card.append(
        el("div", { class: "wx-top" },
          el("div", {},
            el("div", { class: "wx-temp", text: deg(weather.temp) }),
            el("div", { class: "sub", text: `${weatherLabel(weather.code)} · ${settings.weatherPlace}` })),
          el("div", { class: "wx-meta", text: `Feels ${deg(weather.feels)}\nH ${deg(weather.high)}  L ${deg(weather.low)}\nWind ${Math.round(weather.wind)} ${weather.windUnit}` })),
        el("div", { class: "wx-days" }, ...weather.days.slice(0, 5).map((d) =>
          el("div", { class: "wx-day" },
            el("span", { text: weekday(d.date) }),
            el("span", { class: "sub", text: weatherLabel(d.code) }),
            el("span", { text: `${deg(d.high)} / ${deg(d.low)}` })))));
    } else {
      card.append(el("p", { class: "sub", text: weatherError || "Loading the weather…" }));
    }
    wrap.append(card);
  }

  // Wardrobe
  const grid = el("div", { class: "wd-grid" });
  const sel = settings.mochiOutfit as Outfit;
  for (const o of OUTFIT_LIST) {
    const cv = document.createElement("canvas");
    const TILE = 64, px = Math.round(TILE * Math.max(1, devicePixelRatio));
    cv.width = px; cv.height = px; cv.style.width = `${TILE}px`; cv.style.height = `${TILE}px`;
    const x = cv.getContext("2d");
    if (x) { x.scale(px / TILE, px / TILE); drawOutfitIcon(x, TILE, o.id === "auto" ? seasonalOutfit() : o.id); }
    const tile = el("button", { class: "wd-tile" + (o.id === sel ? " on" : ""), "aria-label": o.name }, cv);
    tile.addEventListener("click", () => {
      Sound.resume(); Sound.play("blip");
      settings.mochiOutfit = o.id; save(); applyLook(); render();
    });
    grid.append(tile);
  }
  wrap.append(el("section", { class: "card" },
    el("h2", { text: "Wardrobe" }),
    el("p", { class: "sub", text: sel === "auto" ? `Auto · ${outfitName(seasonalOutfit())}` : outfitName(sel) }),
    grid));
  return wrap;
}

function chatScreen(): HTMLElement {
  const list = el("div", { class: "msgs" });
  if (!messages.length) list.append(el("p", { class: "sub center", text: "Ask Mochi anything." }));
  for (const m of messages) list.append(el("div", { class: `msg ${m.who}`, text: m.text }));
  if (sending) list.append(el("div", { class: "msg mochi dots", text: "…" }));
  queueMicrotask(() => { list.scrollTop = list.scrollHeight; });

  const input = el("input", { class: "field", placeholder: "Message Mochi", enterkeyhint: "send", autocomplete: "off" });
  const send = async () => {
    const text = input.value.trim();
    if (!text || sending) return;
    Sound.resume(); Sound.play("send");
    messages.push({ who: "me", text });
    sending = true; engine.setState("thinking"); render();
    try {
      const r = await Bridge.chatSend(text);
      messages.push({ who: "mochi", text: r.text });
      engine.setState("finished");
    } catch (e) {
      messages.push({ who: "note", text: (e as Error).message });
      engine.setState("error");
    }
    sending = false;
    setTimeout(() => engine.setState("idle"), 1800);
    render();
  };
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") void send(); });
  const btn = el("button", { class: "btn" }, "Send");
  btn.addEventListener("click", () => void send());
  const reset = el("button", { class: "link", text: "New chat" });
  reset.addEventListener("click", () => { messages.length = 0; void Bridge.chatReset(); render(); });

  return el("div", { class: "screen chat" },
    el("div", { class: "chat-head" }, el("h1", { text: "Chat" }), reset), list,
    el("div", { class: "composer" }, input, btn));
}

function settingsScreen(): HTMLElement {
  const wrap = el("div", { class: "screen" }, el("h1", { text: "Settings" }));

  // AI provider
  const prov = el("select", { class: "field" },
    el("option", { value: "anthropic", text: "Claude (Anthropic)" }),
    el("option", { value: "openai", text: "OpenAI-compatible (OpenRouter, Groq, Together…)" }));
  prov.value = settings.aiProvider;
  const base = el("input", { class: "field", placeholder: "https://api.openai.com/v1", value: settings.aiBaseUrl, autocapitalize: "off" });
  const model = el("input", { class: "field", placeholder: "model", value: settings.model, autocapitalize: "off" });
  const key = el("input", { class: "field", type: "password", placeholder: "API key", autocomplete: "off" });
  const keyNote = el("p", { class: "sub" });
  const keyId = () => (settings.aiProvider === "openai" ? "ai-api-key" : "anthropic-api-key") as "ai-api-key" | "anthropic-api-key";
  const refreshKey = async () => {
    keyNote.textContent = (await Bridge.secretPresent(keyId())) ? "A key is saved on this phone." : "No key yet.";
    base.style.display = settings.aiProvider === "openai" ? "" : "none";
  };
  prov.addEventListener("change", () => { settings.aiProvider = prov.value as Settings["aiProvider"]; save(); void Bridge.chatReset(); void refreshKey(); });
  base.addEventListener("change", () => { settings.aiBaseUrl = base.value; save(); });
  model.addEventListener("change", () => { settings.model = model.value; save(); });
  const saveKey = el("button", { class: "btn" }, "Save key");
  saveKey.addEventListener("click", async () => {
    try { await Bridge.secretSet(keyId(), key.value); key.value = ""; } catch (e) { keyNote.textContent = (e as Error).message; return; }
    void refreshKey();
  });
  wrap.append(el("section", { class: "card" }, el("h2", { text: "AI provider" }), prov, base, model, key, saveKey, keyNote));
  void refreshKey();

  // Weather
  const city = el("input", { class: "field", placeholder: "Search a city", value: "" });
  const results = el("div", { class: "results" });
  const wnote = el("p", { class: "sub", text: settings.weatherPlace ? `Now: ${settings.weatherPlace}` : "No city chosen." });
  let timer = 0;
  city.addEventListener("input", () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(async () => {
      results.replaceChildren();
      if (city.value.trim().length < 2) return;
      try {
        const found: Place[] = await Bridge.weatherSearch(city.value.trim());
        for (const p of found) {
          const b = el("button", { class: "row", text: p.detail ? `${p.name} — ${p.detail}` : p.name });
          b.addEventListener("click", () => {
            settings.weatherPlace = p.name; settings.weatherLat = p.lat; settings.weatherLon = p.lon;
            save(); results.replaceChildren(); city.value = ""; wnote.textContent = `Now: ${p.name}`;
            void loadWeather(true);
          });
          results.append(b);
        }
      } catch (e) { results.append(el("p", { class: "sub", text: (e as Error).message })); }
    }, 350);
  });
  const toggle = (label: string, get: () => boolean, set: (v: boolean) => void) => {
    const cb = el("input", { type: "checkbox" }); cb.checked = get();
    cb.addEventListener("change", () => { set(cb.checked); save(); applyLook(); });
    return el("label", { class: "toggle" }, el("span", { text: label }), cb);
  };
  wrap.append(el("section", { class: "card" }, el("h2", { text: "Weather" }), city, results, wnote,
    toggle("Show the weather", () => settings.showWeather, (v) => { settings.showWeather = v; }),
    toggle("Fahrenheit", () => settings.weatherFahrenheit, (v) => { settings.weatherFahrenheit = v; weather = null; void loadWeather(true); })));

  // Sound
  const vol = el("input", { type: "range", min: "0", max: "0.2", step: "0.01", value: String(settings.soundVolume) });
  vol.addEventListener("input", () => { settings.soundVolume = Number(vol.value); applyLook(); });
  vol.addEventListener("change", () => { save(); Sound.resume(); Sound.play("blip"); });
  wrap.append(el("section", { class: "card" }, el("h2", { text: "Sound" }),
    toggle("Sounds", () => settings.soundEnabled, (v) => { settings.soundEnabled = v; }), vol));
  return wrap;
}

// ── shell ─────────────────────────────────────────────────────────────────────

function render() {
  const screen = tab === "home" ? homeScreen() : tab === "chat" ? chatScreen() : settingsScreen();
  const nav = el("nav", { class: "tabs" });
  for (const [id, label] of [["home", "Mochi"], ["chat", "Chat"], ["settings", "Settings"]] as const) {
    const b = el("button", { class: id === tab ? "on" : "", text: label });
    b.addEventListener("click", () => { Sound.resume(); Sound.play("blip"); tab = id; render(); });
    nav.append(b);
  }
  app.replaceChildren(screen, nav);
  // Mochi is only on the Mochi tab; elsewhere the loop idles.
}

// Mochi: 30 fps while visible.
const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
mochiCanvas.width = Math.round(MOCHI * dpr);
mochiCanvas.height = Math.round(MOCHI * dpr);
mochiCanvas.style.width = `${MOCHI}px`;
mochiCanvas.style.height = `${MOCHI}px`;
const ctx = mochiCanvas.getContext("2d")!;
mochiCanvas.addEventListener("pointerdown", () => { Sound.resume(); engine.slap(); });
mochiCanvas.addEventListener("pointermove", (e) => {
  const r = mochiCanvas.getBoundingClientRect();
  engine.lookX = Math.max(-1, Math.min(1, (e.clientX - r.left - r.width / 2) / (r.width / 2)));
  engine.lookY = -Math.max(-1, Math.min(1, (e.clientY - r.top - r.height / 2) / (r.height / 2)));
});

let last = performance.now();
function frame(t: number) {
  if (t - last >= 33) {
    const dt = Math.min(0.05, (t - last) / 1000);
    last = t;
    if (document.hidden === false && mochiCanvas.isConnected) {
      engine.update(dt);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, MOCHI, MOCHI);
      engine.draw(ctx, MOCHI, MOCHI);
    }
  }
  requestAnimationFrame(frame);
}

async function main() {
  render();
  void Sound.preload();
  settings = { ...DEFAULT_SETTINGS, ...(await Bridge.boot()) };
  applyLook();
  render();
  void loadWeather();
  engine.setState("idle", true);
  requestAnimationFrame(frame);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) void loadWeather(); });
}

void main();
