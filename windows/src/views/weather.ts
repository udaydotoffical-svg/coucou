// Weather: the tab's card and the little chip in the island's header.
// The data comes from Open-Meteo through Rust (src-tauri/src/weather.rs); the city is
// chosen in the settings.

import { Bridge } from "../core/bridge";
import { State, type WeatherInfo } from "../core/state";
import { h, clear } from "./dom";
import type { ViewActions, ViewHost } from "./views";

type Kind = "sun" | "moon" | "cloudSun" | "cloud" | "rain" | "snow" | "storm" | "fog";


/** WMO weather codes → an icon. */
function kindOf(code: number, isDay: boolean): Kind {
  if (code === 0 || code === 1) return isDay ? "sun" : "moon";
  if (code === 2) return isDay ? "cloudSun" : "cloud";
  if (code === 3) return "cloud";
  if (code === 45 || code === 48) return "fog";
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return "rain";
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "snow";
  if (code >= 95) return "storm";
  return "cloud";
}

export function weatherLabel(code: number): string {
  if (code === 0) return "Clear";
  if (code === 1) return "Mostly clear";
  if (code === 2) return "Partly cloudy";
  if (code === 3) return "Overcast";
  if (code === 45 || code === 48) return "Fog";
  if (code >= 51 && code <= 57) return "Drizzle";
  if (code >= 61 && code <= 67) return "Rain";
  if (code >= 71 && code <= 77) return "Snow";
  if (code >= 80 && code <= 82) return "Showers";
  if (code === 85 || code === 86) return "Snow showers";
  if (code >= 95) return "Thunderstorm";
  return "Cloudy";
}

// ── The icons ─────────────────────────────────────────────────────────────────
// Drawn in Mochi's own style: soft filled shapes, two dot eyes, blush, a tiny smile.

const INK = "#3b2a2a";

/** Mochi's face, centred at (cx, cy) in the 48×48 box. */
function face(cx: number, cy: number, mood: "happy" | "sleepy" | "worried" = "happy"): string {
  const eyes =
    mood === "sleepy"
      ? `<path d="M${cx - 6.2} ${cy} q2.2 -2.4 4.4 0 M${cx + 1.8} ${cy} q2.2 -2.4 4.4 0" stroke="${INK}" stroke-width="1.6" fill="none" stroke-linecap="round"/>`
      : `<circle cx="${cx - 3.8}" cy="${cy}" r="1.9" fill="${INK}"/><circle cx="${cx + 3.8}" cy="${cy}" r="1.9" fill="${INK}"/>` +
        `<circle cx="${cx - 3.2}" cy="${cy - 0.7}" r="0.6" fill="#fff"/><circle cx="${cx + 4.4}" cy="${cy - 0.7}" r="0.6" fill="#fff"/>`;
  const cheeks =
    `<ellipse cx="${cx - 7}" cy="${cy + 3.2}" rx="2.4" ry="1.6" fill="#ff8fa3" opacity="0.8"/>` +
    `<ellipse cx="${cx + 7}" cy="${cy + 3.2}" rx="2.4" ry="1.6" fill="#ff8fa3" opacity="0.8"/>`;
  const mouth =
    mood === "worried"
      ? `<ellipse cx="${cx}" cy="${cy + 4.6}" rx="1.4" ry="1.8" fill="${INK}"/>`
      : `<path d="M${cx - 2.4} ${cy + 3} q2.4 2.7 4.8 0" stroke="${INK}" stroke-width="1.6" fill="none" stroke-linecap="round"/>`;
  return eyes + cheeks + mouth;
}

/** A puffy cloud with a face, optionally moved and scaled inside the box. */
function cloudShape(fill: string, shade: string, mood: "happy" | "sleepy" | "worried", transform = ""): string {
  return (
    `<g transform="${transform}">` +
    `<g fill="${fill}"><circle cx="16.5" cy="27" r="8"/><circle cx="26.5" cy="22.5" r="10"/><circle cx="34" cy="28.5" r="7"/><rect x="16.5" y="27" width="17.5" height="9" rx="4.5"/></g>` +
    `<path d="M18 35.2h15" stroke="${shade}" stroke-width="1.5" stroke-linecap="round" opacity="0.55"/>` +
    face(25, 28.5, mood) +
    `</g>`
  );
}

function rays(cx: number, cy: number, from: number, to: number, count: number, color: string, width: number): string {
  let out = `<g stroke="${color}" stroke-width="${width}" stroke-linecap="round">`;
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    out += `<line x1="${(cx + Math.cos(a) * from).toFixed(1)}" y1="${(cy + Math.sin(a) * from).toFixed(1)}" x2="${(cx + Math.cos(a) * to).toFixed(1)}" y2="${(cy + Math.sin(a) * to).toFixed(1)}"/>`;
  }
  return out + "</g>";
}

const drop = (x: number, y: number) =>
  `<path d="M${x} ${y} q-3 4 0 6.4 q3 -2.4 0 -6.4z" fill="#5aa9ff"/><circle cx="${x - 0.7}" cy="${y + 4.2}" r="0.7" fill="#fff" opacity="0.8"/>`;

const SKY = `<linearGradient id="wxsun" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffe27a"/><stop offset="1" stop-color="#ffb703"/></linearGradient>`;

function markup(kind: Kind): string {
  switch (kind) {
    case "sun":
      return `<defs>${SKY}</defs>${rays(24, 24, 15.5, 20.5, 8, "#ffb703", 3.2)}<circle cx="24" cy="24" r="12" fill="url(#wxsun)"/>${face(24, 23.5)}`;
    case "moon":
      return (
        `<circle cx="24" cy="25" r="13" fill="#fff1b8"/><circle cx="31" cy="19" r="2.2" fill="#f3dc8c"/><circle cx="17.5" cy="31.5" r="1.6" fill="#f3dc8c"/>` +
        face(24, 24.5, "sleepy") +
        `<path d="M38 8l1.1 2.6 2.6 1.1-2.6 1.1L38 15.4l-1.1-2.6-2.6-1.1 2.6-1.1z M9 12l.8 1.9 1.9.8-1.9.8L9 17.4l-.8-1.9-1.9-.8 1.9-.8z" fill="#fff1b8"/>`
      );
    case "cloudSun":
      return (
        `<defs>${SKY}</defs>${rays(17, 16, 9.5, 13.2, 7, "#ffb703", 2.6)}<circle cx="17" cy="16" r="7.6" fill="url(#wxsun)"/>` +
        cloudShape("#f4f8ff", "#b9cdea", "happy", "translate(5 5) scale(0.9)")
      );
    case "rain":
      return cloudShape("#d3deee", "#9fb4d3", "happy", "translate(0 -4)") + drop(15.5, 36) + drop(24, 38.5) + drop(32.5, 36);
    case "snow":
      return (
        cloudShape("#eef4fb", "#bcd0e8", "happy", "translate(0 -4)") +
        `<g stroke="#bfe6ff" stroke-width="2" stroke-linecap="round"><path d="M16 36v5M13.5 38.5h5"/><path d="M24 39v5M21.5 41.5h5"/><path d="M32 36v5M29.5 38.5h5"/></g>`
      );
    case "storm":
      return (
        cloudShape("#9aa7c0", "#6d7b97", "worried", "translate(0 -5)") +
        `<path d="M26.5 30.5l-6.5 9h5l-2.2 7.5 8.2-10.5h-5.2l3-6z" fill="#ffd60a" stroke="#ff9f0a" stroke-width="1" stroke-linejoin="round"/>`
      );
    case "fog":
      return (
        cloudShape("#e3e9f2", "#b7c3d6", "sleepy", "translate(0 -7) scale(0.95)") +
        `<g stroke="#c8d2e1" stroke-width="3" stroke-linecap="round"><path d="M10 37h28"/><path d="M14 43h20"/></g>`
      );
    default:
      return cloudShape("#f4f8ff", "#b9cdea", "happy");
  }
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** A cute Mochi-style icon for a WMO weather code. */
export function weatherIcon(code: number, isDay: boolean, size: number): SVGSVGElement {
  const el = document.createElementNS(SVG_NS, "svg");
  el.setAttribute("viewBox", "0 0 48 48");
  el.setAttribute("width", String(size));
  el.setAttribute("height", String(size));
  el.setAttribute("aria-hidden", "true");
  el.innerHTML = markup(kindOf(code, isDay));
  return el;
}

export const degrees = (v: number): string => `${Math.round(v)}°`;

// ── Fetching ──────────────────────────────────────────────────────────────────

const FRESH_MS = 10 * 60 * 1000;
let inflight = false;

/** Fetches the weather for the chosen city, unless it is recent enough already. */
export async function refreshWeather(force = false): Promise<void> {
  const s = State.settings;
  if (!s.showWeather || !s.weatherPlace || State.paused || inflight) return;
  const w = State.weather;
  if (
    !force && w && Date.now() - w.fetchedAt < FRESH_MS &&
    w.place === s.weatherPlace && w.fahrenheit === s.weatherFahrenheit
  ) return;
  inflight = true;
  try {
    const r = await Bridge.weatherGet(s.weatherLat, s.weatherLon, s.weatherFahrenheit);
    State.weather = {
      ...r,
      place: s.weatherPlace,
      fahrenheit: s.weatherFahrenheit,
      fetchedAt: Date.now(),
    } as WeatherInfo;
    State.weatherError = null;
  } catch (err) {
    State.weatherError = String(err).replace(/^Error:\s*/, "");
  } finally {
    inflight = false;
    State.notify();
  }
}

/** Fetch now and then every 20 minutes. Nothing runs without a city. */
export function startWeather() {
  void refreshWeather(true);
  window.setInterval(() => void refreshWeather(), 20 * 60 * 1000);
}

// ── The tab ───────────────────────────────────────────────────────────────────

const weekday = (iso: string, i: number): string => {
  if (i === 0) return "Today";
  const d = new Date(`${iso}T12:00:00`);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { weekday: "short" });
};

export function buildWeather(actions: ViewActions): ViewHost {
  const body = h("div", { class: "wx" });
  const el = h("div", { class: "view" }, h("div", { class: "card wash wx-card" }, body));
  (el.querySelector(".card") as HTMLElement).style.setProperty("--wash", "rgba(56,189,248,0.45)");
  let key = "";

  return {
    el,
    sync() {
      const s = State.settings;
      void refreshWeather();
      const w = State.weather;
      const k = JSON.stringify([s.weatherPlace, s.weatherFahrenheit, w?.fetchedAt, State.weatherError]);
      if (k === key) return;
      key = k;
      clear(body);

      if (!s.weatherPlace) {
        body.append(
          h("div", { class: "wx-note" },
            h("b", { text: "No city yet" }),
            h("span", { text: "Choose where you are and the weather shows up here." }),
            h("button", { class: "btn secondary", text: "Open settings", onclick: () => actions.openSettingsWindow() }),
          ),
        );
        return;
      }
      if (!w) {
        body.append(
          h("div", { class: "wx-note" },
            h("b", { text: s.weatherPlace }),
            h("span", { text: State.weatherError ?? "Getting the weather…" }),
            State.weatherError
              ? h("button", { class: "btn secondary", text: "Try again", onclick: () => void refreshWeather(true) })
              : null,
          ),
        );
        return;
      }

      body.append(
        h("div", { class: "wx-now" },
          h("div", { class: "wx-temp" }, weatherIcon(w.code, w.isDay, 30), h("span", { text: degrees(w.temp) })),
          h("div", { class: "wx-cond", text: weatherLabel(w.code) }),
          h("div", { class: "wx-place", text: w.place }),
          h("div", { class: "wx-facts", text: `Feels ${degrees(w.feels)} · ${Math.round(w.humidity)}% humidity · ${Math.round(w.wind)} ${w.windUnit}` }),
        ),
        h("div", { class: "wx-days" },
          ...w.days.slice(0, 5).map((d, i) =>
            h("div", { class: "wx-day" },
              h("span", { class: "wx-dn", text: weekday(d.date, i) }),
              weatherIcon(d.code, true, 20),
              h("span", { class: "wx-hi", text: degrees(d.high) }),
              h("span", { class: "wx-lo", text: degrees(d.low) }),
            ),
          ),
        ),
      );
    },
  };
}
