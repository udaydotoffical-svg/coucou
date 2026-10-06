// Settings window — the place where anything that writes to disk is confirmed.
// Stage 2 covers the Claude Code hooks and the general preferences; API keys and
// integrations land here too in a later stage.

import "./settings.css";
import { Bridge, onEvent, type HookStatus } from "../core/bridge";
import { DEFAULT_SETTINGS, INTEGRATION_AGENTS, type Settings } from "../core/state";
import { COMPACT_HEIGHT_MAX, COMPACT_HEIGHT_MIN, ISLAND_HEIGHT_EXTRA_MAX, ISLAND_HEIGHT_EXTRA_MIN, ISLAND_WIDTH_MAX, ISLAND_WIDTH_MIN } from "../core/layout";
import { h, clear } from "../views/dom";

let settings: Settings = { ...DEFAULT_SETTINGS };
let version = "";

const root = document.getElementById("settings-root")!;

async function save() {
  await Bridge.saveSettings(settings);
}

// ── Reusable bits ─────────────────────────────────────────────────────────────

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

function statusDot(ok: boolean): HTMLElement {
  return h("i", { class: "dot", style: `background:${ok ? "#22c55e" : "#f4505e"}` });
}

function renderDiff(text: string): HTMLElement {
  const box = h("div", { class: "diff" });
  for (const line of text.split("\n")) {
    const cls = line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "ctx";
    box.append(h("div", { class: cls, text: line }));
  }
  return box;
}

// ── Claude Code section ───────────────────────────────────────────────────────

function claudeSection(status: HookStatus): HTMLElement {
  const body = h("div", { style: "display:flex;flex-direction:column;gap:12px" });
  const section = h(
    "section",
    {},
    h("h2", {}, statusDot(status.installed), h("span", { text: "Claude Code" })),
    body,
  );

  const rebuild = async () => {
    const fresh = await Bridge.hooksStatus();
    if (fresh) Object.assign(status, fresh);
    clear(body);
    draw();
    const head = section.querySelector("h2")!;
    clear(head);
    head.append(statusDot(status.installed), h("span", { text: "Claude Code" }));
  };

  function draw() {
    body.append(
      h("div", {
        class: "hint",
        text: status.installed
          ? "Coucou is hooked into your Claude Code sessions. Tool calls, questions and permission requests show up in the island, and you can answer them there."
          : "Install the hooks to see your Claude Code sessions in the island and approve permissions without leaving what you are doing.",
      }),
      h("div", { class: "row" },
        h("label", { text: "settings.json" }),
        h("span", { class: "path", text: status.settingsPath }),
      ),
      h("div", { class: "row" },
        h("label", { text: "Relay" }),
        h("span", { class: "path", text: status.hookPath }),
        statusDot(status.hookReady),
      ),
    );

    if (!status.hookReady) {
      body.append(h("div", {
        class: "notice warn",
        text: "coucou-hook.exe is not in place yet. Restart Coucou; if it still fails, build it with `cargo build -p coucou-hook`.",
      }));
    }

    const actions = h("div", { class: "row" });
    const install = h("button", {
      class: "primary",
      text: status.installed ? "Reinstall hooks…" : "Install hooks…",
      onclick: () => showPreview(true),
    });
    // Writing hook commands that point at a relay which isn't there would give
    // every Claude Code session a broken hook and nothing to show for it.
    if (!status.hookReady) {
      install.disabled = true;
      install.title = "The relay isn't installed yet.";
    }
    actions.append(install);
    if (status.installed) {
      actions.append(h("button", {
        class: "danger",
        text: "Uninstall hooks…",
        onclick: () => showPreview(false),
      }));
    }
    body.append(actions);
  }

  async function showPreview(install: boolean) {
    let preview;
    try {
      preview = await Bridge.hooksPreview(install);
    } catch (err) {
      // An unreadable or invalid settings.json stops here rather than being
      // treated as empty and written over.
      clear(body);
      body.append(
        h("div", { class: "notice err", text: String(err).replace(/^Error:\s*/, "") }),
        h("div", { class: "row" }, h("button", {
          text: "Back",
          onclick: () => { clear(body); draw(); },
        })),
      );
      return;
    }
    if (!preview) return;
    clear(body);
    body.append(
      h("div", {
        class: "hint",
        text: install
          ? "This is exactly what will change in your settings.json. Your own hooks are left untouched."
          : "This removes Coucou's entries only. Your own hooks are left untouched.",
      }),
      renderDiff(preview.diff),
      h("div", { class: "row" },
        h("span", { class: "path", text: `Backup → ${preview.backup}` }),
      ),
    );
    const confirm = h("button", {
      class: install ? "primary" : "danger",
      text: install ? "Back up and write" : "Back up and remove",
    });
    confirm.addEventListener("click", async () => {
      confirm.disabled = true;
      try {
        const backup = await Bridge.hooksApply(install, preview.fingerprint);
        clear(body);
        body.append(h("div", {
          class: "notice ok",
          text: `Done. Previous settings saved as ${backup}. Open a new Claude Code session to pick the hooks up.`,
        }));
        window.setTimeout(() => void rebuild(), 2600);
      } catch (err) {
        confirm.disabled = false;
        body.append(h("div", { class: "notice err", text: `Could not write: ${String(err)}` }));
      }
    });
    body.append(h("div", { class: "row" }, confirm, h("button", {
      text: "Cancel",
      onclick: () => { clear(body); draw(); },
    })));
  }

  draw();
  return section;
}

// ── AI provider section ───────────────────────────────────────────────────────

const MODELS: [string, string][] = [
  ["claude-opus-5", "Claude Opus 5"],
  ["claude-sonnet-5", "Claude Sonnet 5"],
  ["claude-haiku-4-5", "Claude Haiku 4.5"],
];

/** Starting points for the OpenAI-compatible provider — every field stays editable. */
const PRESETS: { label: string; url: string; models: string[] }[] = [
  { label: "OpenAI", url: "https://api.openai.com/v1", models: ["gpt-4o", "gpt-4o-mini"] },
  { label: "OpenRouter", url: "https://openrouter.ai/api/v1", models: ["openai/gpt-4o-mini"] },
  { label: "Groq", url: "https://api.groq.com/openai/v1", models: ["llama-3.3-70b-versatile"] },
  { label: "Together", url: "https://api.together.xyz/v1", models: ["meta-llama/Llama-3.3-70B-Instruct-Turbo"] },
  { label: "Mistral", url: "https://api.mistral.ai/v1", models: ["mistral-large-latest"] },
  { label: "DeepSeek", url: "https://api.deepseek.com/v1", models: ["deepseek-chat"] },
  { label: "Google Gemini", url: "https://generativelanguage.googleapis.com/v1beta/openai", models: ["gemini-2.0-flash"] },
  { label: "Ollama (this PC)", url: "http://localhost:11434/v1", models: ["llama3.2"] },
  { label: "LM Studio (this PC)", url: "http://localhost:1234/v1", models: [] },
];

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
  const saveBtn = h("button", { class: "primary", text: "Save key" });
  const clearBtn = h("button", { class: "danger", text: "Remove" });
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
      feedback.append(h("div", { class: "notice ok", text: "Saved. It never touches disk." }));
      await refresh();
    } catch (err) {
      feedback.append(h("div", { class: "notice err", text: `Could not save: ${String(err)}` }));
    }
  });

  clearBtn.addEventListener("click", async () => {
    clear(feedback);
    try {
      await Bridge.secretClear(secretKey);
      feedback.append(h("div", { class: "notice ok", text: "Key removed." }));
      await refresh();
    } catch (err) {
      feedback.append(h("div", { class: "notice err", text: `Could not remove: ${String(err)}` }));
    }
  });

  void refresh();
  return {
    dot,
    state,
    row: h("div", { class: "row" }, h("label", { text: "API key" }), field, saveBtn, clearBtn),
    feedback,
  };
}

function aiSection(): HTMLElement {
  const remembered = { anthropic: "claude-opus-5", openai: "" };
  if (settings.aiProvider === "openai") remembered.openai = settings.model;
  else remembered.anthropic = settings.model;

  const provider = h("select", {}) as HTMLSelectElement;
  provider.append(
    h("option", { value: "anthropic", text: "Claude (Anthropic)" }),
    h("option", { value: "openai", text: "OpenAI-compatible (OpenAI, OpenRouter, Groq, Ollama…)" }),
  );
  provider.value = settings.aiProvider;

  // ── Claude ──
  const claudeKey = keyRow("anthropic-api-key", "sk-ant-...", "No key yet — the chat needs one.");
  const claudeModel = h("select", {}) as HTMLSelectElement;
  for (const [id, label] of MODELS) claudeModel.append(h("option", { value: id, text: label }));
  if (!MODELS.some(([id]) => id === remembered.anthropic)) {
    claudeModel.append(h("option", { value: remembered.anthropic, text: remembered.anthropic }));
  }
  claudeModel.value = remembered.anthropic;
  claudeModel.addEventListener("change", () => {
    remembered.anthropic = claudeModel.value;
    settings.model = claudeModel.value;
    void save();
  });
  const claudeBlock = h("div", { style: "display:flex;flex-direction:column;gap:12px" },
    claudeKey.state,
    claudeKey.row,
    h("div", { class: "row" }, h("label", { text: "Model" }), claudeModel),
    claudeKey.feedback,
  );

  // ── Any OpenAI-compatible endpoint ──
  const otherKey = keyRow("ai-api-key", "your API key", "No key yet — only local servers (Ollama, LM Studio) work without one.");
  const preset = h("select", {}) as HTMLSelectElement;
  preset.append(h("option", { value: "", text: "Pick a service…" }));
  PRESETS.forEach((p, i) => preset.append(h("option", { value: String(i), text: p.label })));

  const baseUrl = h("input", {
    type: "text",
    placeholder: "https://api.openai.com/v1",
    value: settings.aiBaseUrl,
    style: "flex:1 1 auto;min-width:0",
    autocomplete: "off",
    spellcheck: "false",
  }) as HTMLInputElement;
  const modelList = h("datalist", { id: "ai-model-list" });
  const modelInput = h("input", {
    type: "text",
    placeholder: "model name, e.g. gpt-4o",
    value: remembered.openai,
    list: "ai-model-list",
    style: "flex:1 1 auto;min-width:0",
    autocomplete: "off",
    spellcheck: "false",
  }) as HTMLInputElement;

  const commitOther = () => {
    settings.aiBaseUrl = baseUrl.value.trim();
    remembered.openai = modelInput.value.trim();
    settings.model = remembered.openai;
    void save();
  };
  baseUrl.addEventListener("change", commitOther);
  modelInput.addEventListener("change", commitOther);
  preset.addEventListener("change", () => {
    const p = PRESETS[Number(preset.value)];
    if (!p) return;
    baseUrl.value = p.url;
    clear(modelList);
    for (const m of p.models) modelList.append(h("option", { value: m }));
    if (p.models[0]) modelInput.value = p.models[0];
    commitOther();
    preset.value = "";
  });

  const otherBlock = h("div", { style: "display:flex;flex-direction:column;gap:12px" },
    h("div", { class: "hint", text: "Works with any service that speaks the OpenAI chat API. Web search is only available with Claude." }),
    h("div", { class: "row" }, h("label", { text: "Service" }), preset),
    h("div", { class: "row" }, h("label", { text: "Base URL" }), baseUrl),
    h("div", { class: "row" }, h("label", { text: "Model" }), modelInput, modelList),
    otherKey.state,
    otherKey.row,
    otherKey.feedback,
  );

  const heading = h("h2", {}, h("span", { text: "AI provider" }));
  function show() {
    const openai = provider.value === "openai";
    claudeBlock.style.display = openai ? "none" : "";
    otherBlock.style.display = openai ? "" : "none";
  }
  provider.addEventListener("change", () => {
    settings.aiProvider = provider.value as Settings["aiProvider"];
    settings.model = settings.aiProvider === "openai"
      ? remembered.openai
      : remembered.anthropic;
    show();
    void save();
  });
  show();

  return h(
    "section",
    {},
    heading,
    h("div", { class: "row" }, h("label", { text: "Provider" }), provider),
    claudeBlock,
    otherBlock,
  );
}

// ── Assistant (Mochi / Knowura) section ───────────────────────────────────────

function assistantSection(hotkey: string | null, aiSection: HTMLElement): HTMLElement {
  const mode = h("select", {}) as HTMLSelectElement;
  mode.append(
    h("option", { value: "knowura", text: "Knowura (hosted assistant)" }),
    h("option", { value: "mochi", text: "Mochi (built-in chat)" }),
  );
  mode.value = settings.assistantMode;

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
  const mochiOnly = h("div", { class: "hint", text: "Mochi's own chat, using the AI provider below." });

  // The provider settings only matter to Mochi's own chat.
  const show = () => {
    const knowura = mode.value === "knowura";
    knowuraOnly.style.display = knowura ? "" : "none";
    mochiOnly.style.display = knowura ? "none" : "";
    aiSection.style.display = knowura ? "none" : "";
  };
  mode.addEventListener("change", () => {
    settings.assistantMode = mode.value as Settings["assistantMode"];
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

function layoutSection(): HTMLElement {
  // The avatars that can fill a spot: VS Code and the integrations that are switched on.
  const ids = ["integration_claude", ...settings.activeIntegrations];
  const candidates = INTEGRATION_AGENTS.filter((t) => ids.includes(t.id));
  const picker = (value: string, autoLabel: string, onPick: (id: string) => void) => {
    const sel = h("select", {}) as HTMLSelectElement;
    sel.append(h("option", { value: "", text: autoLabel }));
    for (const t of candidates) sel.append(h("option", { value: t.id, text: t.id === "integration_claude" ? "VS Code" : t.name }));
    sel.value = candidates.some((t) => t.id === value) ? value : "";
    sel.addEventListener("change", () => onPick(sel.value));
    return sel;
  };

  const slots = [settings.squareSlots[0] ?? "", settings.squareSlots[1] ?? ""];
  const setSlot = (i: number, id: string) => {
    slots[i] = id;
    settings.squareSlots = [...slots];
    void save();
  };

  return h(
    "section",
    {},
    h("h2", {}, h("span", { text: "Overview layout" })),
    h("div", { class: "hint", text: "The big avatar on the left, the two small squares for unselected avatars on the right, and the music player under them. Clicking a square swaps it with the big one." }),
    h("div", { class: "row" },
      h("label", { text: "Main avatar" }),
      picker(settings.mainAvatar, "VS Code (default)", (id) => { settings.mainAvatar = id; void save(); }),
    ),
    h("div", { class: "row" },
      h("label", { text: "Square 1" }),
      picker(slots[0], "Automatic", (id) => setSlot(0, id)),
    ),
    h("div", { class: "row" },
      h("label", { text: "Square 2" }),
      picker(slots[1], "Automatic", (id) => setSlot(1, id)),
    ),
    h("div", { class: "row" },
      h("label", { text: "Album art on closed island" }),
      toggle(settings.showMusicOnNotch, (v) => { settings.showMusicOnNotch = v; void save(); }),
      h("span", { class: "hint", text: "While music plays, the art replaces the small pills on the closed island" }),
    ),
    h("div", { class: "row" },
      h("label", { text: "Headphones on Mochi" }),
      toggle(settings.mochiHeadphones, (v) => { settings.mochiHeadphones = v; void save(); }),
      h("span", { class: "hint", text: "Mochi puts headphones on while music plays" }),
    ),
  );
}

// ── Mochi colours section ─────────────────────────────────────────────────────

function colorsSection(): HTMLElement {
  const rows = INTEGRATION_AGENTS.map((t) => {
    const name = t.id === "integration_claude" ? "VS Code" : t.name;
    const input = h("input", { type: "color", value: settings.mochiColors[t.id] ?? t.color }) as HTMLInputElement;
    input.addEventListener("change", () => {
      settings.mochiColors = { ...settings.mochiColors, [t.id]: input.value };
      void save();
    });
    const reset = h("button", {
      text: "Reset",
      onclick: () => {
        const { [t.id]: _gone, ...rest } = settings.mochiColors;
        settings.mochiColors = rest;
        input.value = t.color;
        void save();
      },
    });
    return h("div", { class: "row" }, h("label", { text: name }), input, reset);
  });
  return h(
    "section",
    {},
    h("h2", {}, h("span", { text: "Mochi colours" })),
    h("div", { class: "hint", text: "Pick a colour for each Mochi: its body in the pills, the squares and the closed island." }),
    ...rows,
  );
}

// ── Weather section ───────────────────────────────────────────────────────────

function weatherSection(): HTMLElement {
  const status = h("div", { class: "hint", text: settings.weatherPlace ? `Showing the weather for ${settings.weatherPlace}.` : "No city chosen yet." });
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
    settings.weatherPlace = p.name;
    settings.weatherLat = p.lat;
    settings.weatherLon = p.lon;
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
  units.value = settings.weatherFahrenheit ? "f" : "c";
  units.addEventListener("change", () => { settings.weatherFahrenheit = units.value === "f"; void save(); });

  return h(
    "section",
    {},
    h("h2", {}, h("span", { text: "Weather" })),
    h("div", { class: "hint", text: "Shows the temperature in the island's bar and a weather tab. It uses Open-Meteo, which needs no account; only the city you pick here is looked up." }),
    status,
    h("div", { class: "row" }, h("label", { text: "City" }), input, find),
    results,
    h("div", { class: "row" }, h("label", { text: "Units" }), units),
    h("div", { class: "row" },
      h("label", { text: "Show weather" }),
      toggle(settings.showWeather, (v) => { settings.showWeather = v; void save(); }),
    ),
  );
}

// ── Integrations section ──────────────────────────────────────────────────────

interface IntegrationDef {
  id: string;
  name: string;
  color: string;
  /** Credential Manager keys, in the order they are shown. */
  fields: { key: string; label: string; placeholder: string; secret: boolean }[];
}

const INTEGRATIONS: IntegrationDef[] = [
  { id: "integration_stripe", name: "Stripe", color: "#0570DE",
    fields: [{ key: "stripe-api-key", label: "Secret key", placeholder: "sk_live_…", secret: true }] },
  { id: "integration_github", name: "GitHub", color: "#F4505E",
    fields: [{ key: "github-token", label: "Token", placeholder: "ghp_…", secret: true }] },
  { id: "integration_vercel", name: "Vercel", color: "#7C5CFF",
    fields: [{ key: "vercel-token", label: "Token", placeholder: "…", secret: true }] },
  { id: "integration_n8n", name: "n8n", color: "#F29B38",
    fields: [
      { key: "n8n-url", label: "Instance URL", placeholder: "https://n8n.example.com", secret: false },
      { key: "n8n-api-key", label: "API key", placeholder: "…", secret: true },
    ] },
  { id: "integration_resend", name: "Resend", color: "#22C55E",
    fields: [{ key: "resend-api-key", label: "API key", placeholder: "re_…", secret: true }] },
  { id: "integration_notion", name: "Notion", color: "#8C8C8C",
    fields: [{ key: "notion-api-key", label: "Integration token", placeholder: "ntn_…", secret: true }] },
  { id: "integration_calcom", name: "Cal.com", color: "#C9956A",
    fields: [{ key: "calcom-api-key", label: "API key", placeholder: "cal_…", secret: true }] },
];

const MAX_ACTIVE = 4;

function integrationsSection(present: Record<string, boolean>): HTMLElement {
  const note = h("div", { class: "hint" });
  const list = h("div", { style: "display:flex;flex-direction:column;gap:14px" });

  function updateNote() {
    const used = settings.activeIntegrations.length;
    note.textContent = `Pick up to ${MAX_ACTIVE} pills to show next to Mochi — ${used}/${MAX_ACTIVE} in use. Keys are stored in the Windows Credential Manager, never on disk.`;
  }

  for (const def of INTEGRATIONS) {
    const active = settings.activeIntegrations.includes(def.id);
    const sw = h("button", { class: active ? "switch on" : "switch" });
    sw.addEventListener("click", () => {
      const on = settings.activeIntegrations.includes(def.id);
      if (on) {
        settings.activeIntegrations = settings.activeIntegrations.filter((x) => x !== def.id);
      } else {
        if (settings.activeIntegrations.length >= MAX_ACTIVE) return;
        settings.activeIntegrations = [...settings.activeIntegrations, def.id];
      }
      sw.classList.toggle("on", !on);
      updateNote();
      void save();
    });

    const rows = h("div", { style: "display:flex;flex-direction:column;gap:6px;flex:1 1 auto;min-width:0" });
    for (const field of def.fields) {
      const input = h("input", {
        type: field.secret ? "password" : "text",
        placeholder: present[field.key] ? "••••••••  (stored)" : field.placeholder,
        autocomplete: "off",
        spellcheck: "false",
        style: "flex:1 1 auto;min-width:0",
      }) as HTMLInputElement;
      const saveBtn = h("button", { text: "Save" });
      const dotEl = statusDot(present[field.key] ?? false);
      saveBtn.addEventListener("click", async () => {
        const value = input.value.trim();
        try {
          await Bridge.secretSet(field.key, value);
          present[field.key] = value.length > 0;
          input.value = "";
          input.placeholder = value ? "••••••••  (stored)" : field.placeholder;
          dotEl.style.background = value ? "#22c55e" : "#f4505e";
        } catch {
          dotEl.style.background = "#f5a524";
        }
      });
      rows.append(
        h("div", { class: "row" },
          h("label", { style: "min-width:104px", text: field.label }),
          input, saveBtn, dotEl,
        ),
      );
    }

    list.append(
      h("div", { style: "display:flex;gap:12px;align-items:flex-start" },
        h("div", { style: "display:flex;align-items:center;gap:8px;min-width:132px;padding-top:4px" },
          sw,
          h("i", { class: "dot", style: `background:${def.color}` }),
          h("span", { style: "font-size:12.5px", text: def.name }),
        ),
        rows,
      ),
    );
  }

  updateNote();
  return h("section", {}, h("h2", {}, h("span", { text: "Integrations" })), note, list);
}

// ── General section ───────────────────────────────────────────────────────────

function generalSection(): HTMLElement {
  const volume = h("input", {
    type: "range", min: "0", max: "0.2", step: "0.005",
    value: String(settings.soundVolume),
  }) as HTMLInputElement;
  volume.addEventListener("input", () => {
    settings.soundVolume = Number(volume.value);
    void save();
  });

  const autoClose = h("input", {
    type: "number", min: "5", max: "120", step: "1",
    value: String(Math.round(settings.autoCloseInterval)),
    style: "width:72px",
  }) as HTMLInputElement;
  autoClose.addEventListener("change", () => {
    settings.autoCloseInterval = Math.max(5, Math.min(120, Number(autoClose.value) || 15));
    autoClose.value = String(settings.autoCloseInterval);
    void save();
  });

  const autoHide = toggle(settings.autoHide, (v) => {
    settings.autoHide = v;
    autoClose.disabled = !v;
    void save();
  });
  autoClose.disabled = !settings.autoHide;

  const width = slider(ISLAND_WIDTH_MIN, ISLAND_WIDTH_MAX, 10, settings.islandWidth, (v) => `${v}px`, (v) => {
    settings.islandWidth = v;
    void save();
  });
  const heightExtra = slider(ISLAND_HEIGHT_EXTRA_MIN, ISLAND_HEIGHT_EXTRA_MAX, 10, settings.islandHeightExtra, (v) => (v === 0 ? "default" : v > 0 ? `+${v}px` : `${v}px`), (v) => {
    settings.islandHeightExtra = v;
    void save();
  });
  const compactHeight = slider(COMPACT_HEIGHT_MIN, COMPACT_HEIGHT_MAX, 2, settings.compactHeight, (v) => (v === 32 ? "default" : `${v}px`), (v) => {
    settings.compactHeight = v;
    void save();
  });
  const resetSize = h("button", {
    text: "Reset size",
    onclick: () => {
      settings.islandWidth = DEFAULT_SETTINGS.islandWidth;
      settings.islandHeightExtra = DEFAULT_SETTINGS.islandHeightExtra;
      settings.compactHeight = DEFAULT_SETTINGS.compactHeight;
      compactHeight.set(settings.compactHeight);
      width.set(settings.islandWidth);
      heightExtra.set(settings.islandHeightExtra);
      void save();
    },
  });

  const screen = h("select", {}) as HTMLSelectElement;
  screen.append(
    h("option", { value: "primary", text: "Main display" }),
    h("option", { value: "cursor", text: "Display under the cursor" }),
  );
  screen.value = settings.screen;
  screen.addEventListener("change", () => {
    settings.screen = screen.value as Settings["screen"];
    void save();
  });

  return h(
    "section",
    {},
    h("h2", {}, h("span", { text: "General" })),
    h("div", { class: "row" },
      h("label", { text: "Sound" }),
      toggle(settings.soundEnabled, (v) => { settings.soundEnabled = v; void save(); }),
      volume,
    ),
    h("div", { class: "row" },
      h("label", { text: "Open on hover" }),
      toggle(settings.openOnHover, (v) => { settings.openOnHover = v; void save(); }),
      h("span", { class: "hint", text: "Opens when the pointer rests on the island, closes when it leaves" }),
    ),
    h("div", { class: "row" },
      h("label", { text: "Close on click outside" }),
      toggle(settings.closeOnClickOutside, (v) => { settings.closeOnClickOutside = v; void save(); }),
      h("span", { class: "hint", text: "Clicking elsewhere closes the open island and the Knowura panel (the file-drop view stays open until you switch away)" }),
    ),
    h("div", { class: "row" },
      h("label", { text: "Pills on closed island" }),
      toggle(settings.showMiniPills, (v) => { settings.showMiniPills = v; void save(); }),
      h("span", { class: "hint", text: "The small integration pills beside Mochi; off leaves just the main blob" }),
    ),
    h("div", { class: "row" },
      h("label", { text: "Auto-hide" }),
      autoHide,
      h("span", { class: "hint", text: "Off keeps the island open and visible until you close it" }),
    ),
    h("div", { class: "row" },
      h("label", { text: "Auto-close" }),
      autoClose,
      h("span", { class: "hint", text: "seconds after you leave the island" }),
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
      toggle(settings.alwaysOnTop, (v) => { settings.alwaysOnTop = v; void save(); }),
    ),
    h("div", { class: "row" },
      h("label", { text: "Show in taskbar" }),
      toggle(settings.showInTaskbar, (v) => { settings.showInTaskbar = v; void save(); }),
    ),
    h("div", { class: "row" },
      h("label", { text: "Island lives on" }),
      screen,
    ),
    h("div", { class: "row" },
      h("label", { text: "Launch at startup" }),
      toggle(settings.autostart, (v) => { settings.autostart = v; void save(); }),
    ),
  );
}

// ── Boot ──────────────────────────────────────────────────────────────────────

async function main() {
  const boot = await Bridge.boot();
  if (boot) {
    settings = { ...settings, ...boot.settings };
    version = boot.version;
  }
  const status = (await Bridge.hooksStatus()) ?? {
    installed: false, settingsPath: "", hookPath: "", hookReady: false,
  };

  const keys = [
    "stripe-api-key", "github-token", "vercel-token",
    "n8n-url", "n8n-api-key", "resend-api-key", "notion-api-key", "calcom-api-key",
  ];
  const present: Record<string, boolean> = {};
  for (const k of keys) present[k] = (await Bridge.secretPresent(k)) ?? false;

  const ai = aiSection();
  clear(root);
  root.append(
    h("h1", {}, h("span", { text: "Coucou" }), h("span", { class: "version", text: version })),
    claudeSection(status),
    assistantSection(boot?.knowuraHotkey ?? null, ai),
    ai,
    layoutSection(),
    weatherSection(),
    colorsSection(),
    integrationsSection(present),
    generalSection(),
    h("div", {
      class: "hint",
      text: "No telemetry. Network requests only go to the services you configure yourself.",
    }),
  );

  void onEvent<Settings>("settings-changed", (s) => {
    settings = { ...settings, ...s };
  });
}

void main();
