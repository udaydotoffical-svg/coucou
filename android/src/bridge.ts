// The commands in src-tauri/src/lib.rs. In a plain browser (npm run dev) they answer with
// nothing, so the screens can be iterated on without a phone.

import { invoke } from "@tauri-apps/api/core";

export const IS_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export interface Settings {
  soundEnabled: boolean;
  soundVolume: number;
  aiProvider: "anthropic" | "openai";
  aiBaseUrl: string;
  model: string;
  mochiOutfit: string;
  weatherPlace: string;
  weatherLat: number;
  weatherLon: number;
  weatherFahrenheit: boolean;
  showWeather: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  soundEnabled: true,
  soundVolume: 0.12,
  aiProvider: "anthropic",
  aiBaseUrl: "",
  model: "claude-opus-5",
  mochiOutfit: "auto",
  weatherPlace: "",
  weatherLat: 0,
  weatherLon: 0,
  weatherFahrenheit: false,
  showWeather: true,
};

export interface Place { name: string; detail: string; lat: number; lon: number }
export interface Day { date: string; code: number; high: number; low: number }
export interface Weather {
  temp: number; feels: number; humidity: number; wind: number; code: number; isDay: boolean;
  high: number; low: number; unit: string; windUnit: string; days: Day[];
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!IS_TAURI) throw new Error("Open this in the Coucou app.");
  try {
    return await invoke<T>(cmd, args);
  } catch (err) {
    throw new Error(typeof err === "string" ? err : String(err));
  }
}

export const Bridge = {
  boot: () => call<Settings>("boot").catch(() => DEFAULT_SETTINGS),
  saveSettings: (settings: Settings) => call<void>("save_settings", { settings }),
  secretSet: (key: "anthropic-api-key" | "ai-api-key", value: string) => call<void>("secret_set", { key, value }),
  secretPresent: (key: "anthropic-api-key" | "ai-api-key") => call<boolean>("secret_present", { key }).catch(() => false),
  chatSend: (query: string) => call<{ text: string }>("chat_send", { query }),
  chatReset: () => call<void>("chat_reset").catch(() => undefined),
  weatherSearch: (query: string) => call<Place[]>("weather_search", { query }),
  weatherGet: (lat: number, lon: number, fahrenheit: boolean) => call<Weather>("weather_get", { lat, lon, fahrenheit }),
};
