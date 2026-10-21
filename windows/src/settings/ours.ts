// Our sections of the Coucou window, next to Louis's: the Knowura assistant and Knowura Speak, the
// overview layout, the island's size and behaviour, the weather, and Mochi doing tasks on your PC.
// main.ts hands over the window's settings and its save through `bindOurs`.

import { Bridge } from "../core/bridge";
import { DEFAULT_SETTINGS, type Settings } from "../core/state";
import { availablePills } from "../core/pills";
import {
  COMPACT_HEIGHT_MAX, COMPACT_HEIGHT_MIN, ISLAND_HEIGHT_EXTRA_MAX, ISLAND_HEIGHT_EXTRA_MIN,
  ISLAND_WIDTH_MAX, ISLAND_WIDTH_MIN,
} from "../core/layout";
import { h, clear } from "../views/dom";
import { t } from "../i18n/i18n";
import { statusDot } from "./parts";

interface Ours {
  settings(): Settings;
  save(): Promise<void>;
}
let ctx: Ours = { settings: () => ({ ...DEFAULT_SETTINGS }), save: async () => {} };
let afterRestore: () => void = () => {};
export function bindOurs(c: Ours, restored?: () => void) {
  if (restored) afterRestore = restored;
  ctx = c;
}
const S = () => ctx.settings();
const save = () => ctx.save();

function toggle(on: boolean, onChange: (v: boolean) => void): HTMLElement {
  const el = h("button", { class: on ? "switch on" : "switch", "aria-pressed": on });
  el.addEventListener("click", () => {
    const next = !el.classList.contains("on");
    el.classList.toggle("on", next);
    onChange(next);
  });
  return el;
}

/** A range input with a live value label; `onChange` fires on release, not on every pixel. */
function slider(
  min: number,
  max: number,
  step: number,
  value: number,
  format: (v: number) => string,
  onChange: (v: number) => void,
) {
  const input = h("input", {
    type: "range", min: String(min), max: String(max), step: String(step), value: String(value),
    style: "flex:1 1 auto;min-width:0",
  }) as HTMLInputElement;
  const label = h("span", { class: "hint", style: "min-width:64px;text-align:right", text: format(value) });
  input.addEventListener("input", () => { label.textContent = format(Number(input.value)); });
  input.addEventListener("change", () => onChange(Number(input.value)));
  return {
    el: h("div", { class: "row", style: "flex:1 1 auto;min-width:0" }, input, label),
    set(v: number) {
      input.value = String(v);
      label.textContent = format(v);
    },
  };
}

/** A password field with Save / Remove, bound to one Credential Manager entry. */
function keyRow(secretKey: string, placeholder: string, emptyHint: string) {
  const dot = statusDot(false);
  const state = h("span", { class: "hint" });
  const field = h("input", {
    type: "password",
    style: "flex:1 1 auto;min-width:0",
    autocomplete: "off",
    spellcheck: "false",
  }) as HTMLInputElement;
  const saveBtn = h("button", { class: "primary", text: t("Save key") });
  const clearBtn = h("button", { class: "danger", text: t("Remove") });
  const feedback = h("div", {});

  async function refresh() {
    const present = (await Bridge.secretPresent(secretKey)) ?? false;
    dot.style.background = present ? "#22c55e" : "#f4505e";
    state.textContent = present ? "Key saved in the Windows Credential Manager." : emptyHint;
    field.placeholder = present ? "••••••••••••  (stored)" : placeholder;
    clearBtn.style.display = present ? "" : "none";
  }

  saveBtn.addEventListener("click", async () => {
    const value = field.value.trim();
    if (!value) return;
    clear(feedback);
    try {
      await Bridge.secretSet(secretKey, value);
      field.value = "";
      feedback.append(h("div", { class: "notice ok", text: t("Saved. It never touches disk.") }));
      await refresh();
    } catch (err) {
      feedback.append(h("div", { class: "notice err", text: `Could not save: ${String(err)}` }));
    }
  });

  clearBtn.addEventListener("click", async () => {
    clear(feedback);
    try {
      await Bridge.secretClear(secretKey);
      feedback.append(h("div", { class: "notice ok", text: t("Key removed.") }));
      await refresh();
    } catch (err) {
      feedback.append(h("div", { class: "notice err", text: `Could not remove: ${String(err)}` }));
    }
  });

  void refresh();
  return {
    dot,
    state,
    row: h("div", { class: "row" }, h("label", { text: t("API key") }), field, saveBtn, clearBtn),
    feedback,
  };
}

// ── Assistant (Mochi / Knowura) section ───────────────────────────────────────

export function assistantSection(hotkey: string | null): HTMLElement {
  const mode = h("select", {}) as HTMLSelectElement;
  mode.append(
    h("option", { value: "knowura", text: "Knowura (hosted assistant)" }),
    h("option", { value: "mochi", text: "Mochi (built-in chat)" }),
  );
  mode.value = S().assistantMode;

  const keyText = hotkey ?? "Alt+Space";
  const knowuraOnly = h("div", { style: "display:flex;flex-direction:column;gap:12px" },
    h("div", {
      class: "hint",
      text: `The chat tab opens the Knowura assistant — chat, live voice, attachments and quizzes, signed in once and kept. ` +
        `${keyText} opens the text box from anywhere (and closes it again). There is no voice shortcut: use the mic button in the panel, or Start voice in the tray menu.`,
    }),
    h("div", { class: "row" },
      h("button", { class: "primary", text: "Open text box", onclick: () => void Bridge.knowuraOpen("text") }),
      h("button", { text: "Start voice", onclick: () => void Bridge.knowuraOpen("voice") }),
      h("button", { text: "Sign in with the browser", onclick: () => void Bridge.knowuraSignInBrowser() }),
    ),
    h("div", { class: "hint", text: "Signing in works two ways: inside the app (Google opens in its own window), or in your browser with the button above — the app then picks your account up by itself once Knowura supports it." }),
  );
  const mochiOnly = h("div", { class: "hint", text: "Mochi's own chat. Pick the provider and the model in the chat view." });

  const show = () => {
    const knowura = mode.value === "knowura";
    knowuraOnly.style.display = knowura ? "" : "none";
    mochiOnly.style.display = knowura ? "none" : "";
  };
  mode.addEventListener("change", () => {
    S().assistantMode = mode.value as Settings["assistantMode"];
    show();
    void save();
  });
  show();

  return h(
    "section",
    {},
    h("h2", {}, h("span", { text: "Assistant" })),
    h("div", { class: "row" }, h("label", { text: "Chat mode" }), mode),
    knowuraOnly,
    mochiOnly,
  );
}

// ── Overview layout section ───────────────────────────────────────────────────

export function layoutSection(): HTMLElement {
  // The pills that can fill a spot: the main one and the integrations that are switched on.
  const ids = [S().mainPill, ...S().activeIntegrations];
  const candidates = availablePills().filter((p) => ids.includes(p.id));
  const picker = (value: string, autoLabel: string, onPick: (id: string) => void) => {
    const sel = h("select", {}) as HTMLSelectElement;
    sel.append(h("option", { value: "", text: autoLabel }));
    for (const p of candidates) sel.append(h("option", { value: p.id, text: p.name }));
    sel.value = candidates.some((p) => p.id === value) ? value : "";
    sel.addEventListener("change", () => onPick(sel.value));
    return sel;
  };

  const slots = [S().squareSlots[0] ?? "", S().squareSlots[1] ?? ""];
  const setSlot = (i: number, id: string) => {
    slots[i] = id;
    S().squareSlots = [...slots];
    void save();
  };

  return h(
    "section",
    {},
    h("h2", {}, h("span", { text: "Overview layout" })),
    h("div", { class: "hint", text: "The big avatar on the left, the two small squares for the other avatars on the right, and the music player under them. Clicking a square swaps it with the big one." }),
    h("div", { class: "row" },
      h("label", { text: "Square 1" }),
      picker(slots[0], t("Automatic"), (id) => setSlot(0, id)),
    ),
    h("div", { class: "row" },
      h("label", { text: "Square 2" }),
      picker(slots[1], t("Automatic"), (id) => setSlot(1, id)),
    ),
    h("div", { class: "row" },
      h("label", { text: "Album art on closed island" }),
      toggle(S().showMusicOnNotch, (v) => { S().showMusicOnNotch = v; void save(); }),
      h("span", { class: "hint", text: "While music plays, the art replaces the small pills on the closed island" }),
    ),
    h("div", { class: "row" },
      h("label", { text: "Headphones on Mochi" }),
      toggle(S().mochiHeadphones, (v) => { S().mochiHeadphones = v; void save(); }),
      h("span", { class: "hint", text: "Mochi puts headphones on while music plays" }),
    ),
    h("div", { class: "row" },
      h("label", { text: "Mochi dances to music" }),
      toggle(S().mochiDances, (v) => { S().mochiDances = v; void save(); }),
      h("span", { class: "hint", text: "He hops and sways to the beat while music plays" }),
    ),
  );
}

// ── Island section: behaviour and size ────────────────────────────────────────

export function islandSection(): HTMLElement {
  const width = slider(ISLAND_WIDTH_MIN, ISLAND_WIDTH_MAX, 10, S().islandWidth, (v) => `${v}px`, (v) => {
    S().islandWidth = v;
    void save();
  });
  const heightExtra = slider(ISLAND_HEIGHT_EXTRA_MIN, ISLAND_HEIGHT_EXTRA_MAX, 10, S().islandHeightExtra, (v) => (v === 0 ? "default" : v > 0 ? `+${v}px` : `${v}px`), (v) => {
    S().islandHeightExtra = v;
    void save();
  });
  const compactHeight = slider(COMPACT_HEIGHT_MIN, COMPACT_HEIGHT_MAX, 2, S().compactHeight, (v) => (v === 32 ? "default" : `${v}px`), (v) => {
    S().compactHeight = v;
    void save();
  });
  const resetSize = h("button", {
    text: "Reset size",
    onclick: () => {
      S().islandWidth = DEFAULT_SETTINGS.islandWidth;
      S().islandHeightExtra = DEFAULT_SETTINGS.islandHeightExtra;
      S().compactHeight = DEFAULT_SETTINGS.compactHeight;
      compactHeight.set(S().compactHeight);
      width.set(S().islandWidth);
      heightExtra.set(S().islandHeightExtra);
      void save();
    },
  });

  return h(
    "section",
    {},
    h("h2", {}, h("span", { text: "Island" })),
    h("div", { class: "row" },
      h("label", { text: "Mochi feels the PC" }),
      toggle(S().mochiFeelsPc, (v) => { S().mochiFeelsPc = v; void save(); }),
      h("span", { class: "hint", text: "He sweats and panics when the processor is busy, puffs up when memory is short, gets tired on a low battery. Point at him to see why." }),
    ),
    h("div", { class: "row" },
      h("label", { text: "Close on click outside" }),
      toggle(S().closeOnClickOutside, (v) => { S().closeOnClickOutside = v; void save(); }),
      h("span", { class: "hint", text: "Clicking elsewhere closes the open island and the Knowura panel (the file-drop view stays open until you switch away)" }),
    ),
    h("div", { class: "row" },
      h("label", { text: "Pills on closed island" }),
      toggle(S().showMiniPills, (v) => { S().showMiniPills = v; void save(); }),
      h("span", { class: "hint", text: "The small integration pills beside Mochi; off leaves just the main blob" }),
    ),
    h("div", { class: "row" },
      h("label", { text: "Auto-hide" }),
      toggle(S().autoHide, (v) => { S().autoHide = v; void save(); }),
      h("span", { class: "hint", text: "Off keeps the island open and visible until you close it" }),
    ),
    h("div", { class: "row" },
      h("label", { text: "Open island width" }),
      width.el,
    ),
    h("div", { class: "row" },
      h("label", { text: "Closed island height" }),
      compactHeight.el,
    ),
    h("div", { class: "row" },
      h("label", { text: "Open island height" }),
      heightExtra.el,
      resetSize,
    ),
    h("div", { class: "row" },
      h("label", { text: "Always on top" }),
      toggle(S().alwaysOnTop, (v) => { S().alwaysOnTop = v; void save(); }),
    ),
    h("div", { class: "row" },
      h("label", { text: "Show in taskbar" }),
      toggle(S().showInTaskbar, (v) => { S().showInTaskbar = v; void save(); }),
    ),
  );
}

// ── Knowura Speak section ─────────────────────────────────────────────────────

const speakLanguages = (): [string, string][] => [
  ["auto", t("Automatic")], ["en", "English"], ["fr", "Français"], ["es", "Español"], ["de", "Deutsch"], ["it", "Italiano"],
  ["pt", "Português"], ["nl", "Nederlands"], ["pl", "Polski"], ["tr", "Türkçe"], ["ru", "Русский"],
  ["ja", "日本語"], ["zh", "中文"], ["ko", "한국어"], ["hi", "हिन्दी"], ["ar", "العربية"],
];

// ── Computer use section ──────────────────────────────────────────────────────

export function brainPicker(): HTMLElement {
  const sel = h("select", {}) as HTMLSelectElement;
  sel.append(
    h("option", { value: "main", text: "My main agent (Claude Code or OpenCode)" }),
    h("option", { value: "claude", text: "Claude Code" }),
    h("option", { value: "opencode", text: "OpenCode" }),
    h("option", { value: "groq", text: "Groq (free API key)" }),
  );
  sel.value = S().computerBrain;
  sel.addEventListener("change", () => {
    S().computerBrain = sel.value as Settings["computerBrain"];
    void save();
  });
  return sel;
}

function opencodeModelRow(): HTMLElement {
  const input = h("input", {
    type: "text",
    value: S().computerOpencodeModel,
    placeholder: "provider/model (empty = OpenCode's own default)",
    style: "flex:1 1 auto;min-width:0",
    spellcheck: "false",
  }) as HTMLInputElement;
  input.addEventListener("change", () => {
    S().computerOpencodeModel = input.value.replace(/\s+/g, "").slice(0, 120);
    void save();
  });
  return h("div", { class: "row" },
    h("label", { text: "OpenCode model" }),
    input,
    h("span", { class: "hint", text: "It has to see images (for example a Claude or GPT model)." }),
  );
}

export function computerSection(): HTMLElement {
  return h(
    "section",
    {},
    h("h2", {}, h("span", { text: "Mochi does tasks on your PC" })),
    h("div", { class: "hint", text: "Tell Mochi what to do (tray icon → \"Mochi: do something on my PC…\") and he does it with his own blue pointer: he looks at the screen, moves your mouse, clicks and types. Press Esc, move the mouse yourself, or use the tray's \"Stop Mochi\" to stop him at any time." }),
    h("div", { class: "row" },
      h("label", { text: "Who thinks for Mochi" }),
      brainPicker(),
      h("span", { class: "hint", text: "Your main agent (Active pills) does the thinking when it is Claude Code or OpenCode. Groq is free but slow." }),
    ),
    opencodeModelRow(),
    h("div", { class: "row" },
      h("label", { text: "Let Mochi use my PC" }),
      toggle(S().computerUse, (v) => { S().computerUse = v; void save(); }),
      h("span", { class: "hint", text: "Off by default. He never types passwords, pays, sends or deletes unless you ask." }),
    ),
  );
}

export function speakSection(): HTMLElement {
  const language = h("select", {}) as HTMLSelectElement;
  for (const [code, name] of speakLanguages()) language.append(h("option", { value: code, text: name }));
  language.value = S().speakLanguage;
  language.addEventListener("change", () => {
    S().speakLanguage = language.value;
    void save();
  });

  const model = h("select", {}) as HTMLSelectElement;
  model.append(
    h("option", { value: "whisper-large-v3-turbo", text: "Turbo (fastest)" }),
    h("option", { value: "whisper-large-v3", text: "Large v3 (most accurate)" }),
  );
  model.value = S().speakModel;
  model.addEventListener("change", () => {
    S().speakModel = model.value;
    void save();
  });

  const words = h("input", {
    type: "text",
    value: S().speakWords,
    placeholder: "Knowura, Coucou, Mochi",
    style: "flex:1 1 auto;min-width:0",
    spellcheck: "false",
  }) as HTMLInputElement;
  words.addEventListener("change", () => {
    S().speakWords = words.value.slice(0, 300);
    void save();
  });

  return h(
    "section",
    {},
    h("h2", {}, h("span", { text: "Knowura Speak" })),
    h("div", { class: "hint", text: "Hold Ctrl+Win, talk, let go: the words are typed wherever you were typing, and a small Mochi in headphones listens above your cursor, dressed in his usual outfit. Your voice is sent to Groq's Whisper with your own key when you let go; it is never saved on this PC." }),
    h("div", { class: "row" },
      h("label", { text: "Knowura Speak" }),
      toggle(S().speakEnabled, (v) => { S().speakEnabled = v; void save(); }),
      h("span", { class: "hint", text: "Watches for Ctrl+Win only while this is on" }),
    ),
    h("div", { class: "hint", text: "Your Groq API key (console.groq.com). It stays in the Windows Credential Manager." }),
    ...(() => {
      const k = keyRow("groq-api-key", "gsk_…", "No key yet: Knowura Speak needs one.");
      return [k.row, h("div", { class: "row" }, k.dot, k.state), k.feedback];
    })(),
    h("div", { class: "row" }, h("label", { text: t("Model") }), model),
    h("div", { class: "row" },
      h("label", { text: t("Language") }),
      language,
      h("span", { class: "hint", text: "Automatic works for most people" }),
    ),
    h("div", { class: "row" },
      h("label", { text: "Words to spell your way" }),
      words,
    ),
  );
}

// ── Weather section ───────────────────────────────────────────────────────────

export function weatherSection(): HTMLElement {
  const status = h("div", { class: "hint", text: S().weatherPlace ? `Showing the weather for ${S().weatherPlace}.` : "No city chosen yet." });
  const input = h("input", {
    type: "text",
    placeholder: "Your city, for example Paris",
    style: "flex:1 1 auto;min-width:0",
    autocomplete: "off",
    spellcheck: "false",
  }) as HTMLInputElement;
  const find = h("button", { class: "primary", text: "Find" });
  const results = h("div", { style: "display:flex;flex-direction:column;gap:6px" });

  const choose = (p: { name: string; detail: string; lat: number; lon: number }) => {
    S().weatherPlace = p.name;
    S().weatherLat = p.lat;
    S().weatherLon = p.lon;
    void save();
    status.textContent = `Showing the weather for ${p.name}${p.detail ? ` (${p.detail})` : ""}.`;
    clear(results);
    input.value = "";
  };

  async function search() {
    const query = input.value.trim();
    if (!query) return;
    clear(results);
    results.append(h("div", { class: "hint", text: "Searching…" }));
    try {
      const found = await Bridge.weatherSearch(query);
      clear(results);
      if (!found.length) {
        results.append(h("div", { class: "hint", text: "No city by that name." }));
        return;
      }
      for (const p of found) {
        results.append(h("button", { text: p.detail ? `${p.name} — ${p.detail}` : p.name, onclick: () => choose(p) }));
      }
    } catch (err) {
      clear(results);
      results.append(h("div", { class: "notice err", text: String(err).replace(/^Error:\s*/, "") }));
    }
  }
  find.addEventListener("click", () => void search());
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") void search(); });

  const units = h("select", {}) as HTMLSelectElement;
  units.append(h("option", { value: "c", text: "Celsius (°C, km/h)" }), h("option", { value: "f", text: "Fahrenheit (°F, mph)" }));
  units.value = S().weatherFahrenheit ? "f" : "c";
  units.addEventListener("change", () => { S().weatherFahrenheit = units.value === "f"; void save(); });

  return h(
    "section",
    {},
    h("h2", {}, h("span", { text: "Weather" })),
    h("div", { class: "hint", text: "Shows the temperature in the island's bar and a weather tab. It uses Open-Meteo, which needs no account; only the city you pick here is looked up." }),
    status,
    h("div", { class: "row" }, h("label", { text: t("City") }), input, find),
    results,
    h("div", { class: "row" }, h("label", { text: "Units" }), units),
    h("div", { class: "row" },
      h("label", { text: "Show weather" }),
      toggle(S().showWeather, (v) => { S().showWeather = v; void save(); }),
    ),
  );
}


// ── Backups section ───────────────────────────────────────────────────────────

/** Every new version keeps a copy of your settings first; this brings one back. */
export function backupSection(): HTMLElement {
  const list = h("div", { class: "hint", text: "…" });
  const select = h("select", {}) as HTMLSelectElement;
  const note = h("div", { class: "hint" });
  const restore = h("button", { text: "Restore" }) as HTMLButtonElement;
  restore.disabled = true;
  void Bridge.settingsBackups().then((all) => {
    const backups = all ?? [];
    if (!backups.length) {
      list.textContent = "No backup yet: the next update keeps one.";
      return;
    }
    list.textContent = "A copy of your settings is kept before every new version. Pick one to bring it back.";
    for (const [name, secs] of backups) {
      const when = secs ? new Date(secs * 1000).toLocaleString() : "";
      select.append(h("option", { value: name, text: `${name.replace("settings.json.backup-", "")}  ·  ${when}` }));
    }
    restore.disabled = false;
  });
  restore.addEventListener("click", async () => {
    const name = select.value;
    if (!name || !window.confirm("Replace your current settings with this backup? The current ones are kept as a backup first.")) return;
    const backup = await Bridge.settingsBackupRead(name);
    if (!backup) {
      note.textContent = "That backup could not be read.";
      return;
    }
    Object.assign(S(), backup);
    await save();
    note.textContent = "Restored.";
    afterRestore();
  });
  return h(
    "section",
    {},
    h("h2", {}, h("span", { text: "Backups" })),
    list,
    h("div", { class: "row" }, select, restore),
    note,
  );
}
