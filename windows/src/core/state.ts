// App state — mirror of AppState.swift (the parts the island needs).

import type { BotEmoteName, BotStateName, IslandMode, IslandViewName } from "./layout";
import type { EyeShape } from "../mochi/engine";
import type { RGB } from "./color";
import type { Outfit } from "../mochi/outfits";
import type { FileDiff } from "./diff";
import type { GitHubActivity, GitHubPulse } from "./github";

export type AgentSource = "claudeCode" | "n8n" | "agent";
export type PillBadge = "approval" | "finished" | "error";

export interface AgentTask {
  id: string;
  name: string;
  color: string;
  state: BotStateName;
  stepIndex: number;
  steps: string[];
  source: AgentSource;
  isIntegration: boolean;
  emote?: BotEmoteName | null;
  miniEye?: EyeShape | null;
  pillBadge?: PillBadge | null;
  sessionCwd?: string | null;
  /** The colour it has before any override from the settings. */
  baseColor?: string;
}

export interface ApprovalInfo {
  requestId: string;
  sessionId: string;
  tool: string;
  command: string;
}

export interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
}

export type PromptContext =
  | { kind: "window"; appName: string; title: string; url?: string }
  | { kind: "file"; name: string; path?: string };

export interface ResultItem {
  label: string;
  detail: string;
  url?: string;
}

export interface SearchResult {
  title: string;
  items: ResultItem[];
  note?: string;
}

const task = (
  id: string, name: string, color: string, source: AgentSource,
): AgentTask => ({
  id, name, color, state: "idle", stepIndex: 0, steps: [], source, isIntegration: true,
});

/** AgentTask.integrationAgents — same ids, names and colours as macOS. */
export const INTEGRATION_AGENTS: AgentTask[] = [
  task("integration_claude", "VS Code", "#F5F6F8", "claudeCode"),
  task("integration_resend", "Resend", "#22C55E", "n8n"),
  task("integration_n8n", "n8n", "#F29B38", "n8n"),
  task("integration_vercel", "Vercel", "#7C5CFF", "n8n"),
  task("integration_github", "GitHub", "#F4505E", "n8n"),
  task("integration_notion", "Notion", "#8C8C8C", "n8n"),
  task("integration_calcom", "Cal.com", "#C9956A", "n8n"),
  task("integration_stripe", "Stripe", "#0570DE", "n8n"),
];

export const TOGGLEABLE_INTEGRATION_IDS = [
  "integration_resend", "integration_n8n", "integration_vercel", "integration_github",
  "integration_notion", "integration_calcom", "integration_stripe",
];

/** What an integration poller last reported. */
export interface IntegrationInfo {
  data: Record<string, unknown>;
  error: string | null;
  loaded: boolean;
  configured: boolean;
}

/** What is playing on this PC (src-tauri/src/music.rs). */
export interface MusicInfo {
  active: boolean;
  playing: boolean;
  title: string;
  artist: string;
  album: string;
  app: string;
  /** Album art as a data URL. */
  art: string | null;
  /** Seconds into the track when this arrived (see State.musicAt). */
  position: number;
  duration: number;
  canPrev: boolean;
  canNext: boolean;
  canSeek: boolean;
  canToggle: boolean;
  shuffle: boolean;
  repeat: "none" | "list" | "track";
  canShuffle: boolean;
  canRepeat: boolean;
}

/** The weather now and the days ahead (src-tauri/src/weather.rs), with what it was fetched for. */
export interface WeatherInfo {
  temp: number;
  feels: number;
  humidity: number;
  wind: number;
  code: number;
  isDay: boolean;
  high: number;
  low: number;
  unit: string;
  windUnit: string;
  days: { date: string; code: number; high: number; low: number }[];
  place: string;
  fahrenheit: boolean;
  fetchedAt: number;
}

export interface Settings {
  soundEnabled: boolean;
  soundVolume: number;
  autoCloseInterval: number;
  absenceInterval: number;
  activeIntegrations: string[];
  screen: "primary" | "cursor";
  autostart: boolean;
  hooksInstalled: boolean;
  /** Model used by the chat (a Claude model, or whatever the endpoint serves). */
  model: string;
  /** "anthropic" = the Claude API; "openai" = any OpenAI-compatible endpoint. */
  aiProvider: "anthropic" | "openai";
  /** Base URL of the OpenAI-compatible API, e.g. https://api.openai.com/v1. */
  aiBaseUrl: string;
  /** Width of the open island, logical px. */
  islandWidth: number;
  /** Height added to (or, when negative, taken from) the open island's text views, logical px. */
  islandHeightExtra: number;
  /** Height of the closed (compact) island, logical px. */
  compactHeight: number;
  /** "knowura" hosts the Knowura assistant in place of the chat; "mochi" keeps the built-in chat. */
  assistantMode: "knowura" | "mochi";
  /** Which avatar is the big, selected one at start; empty = VS Code. */
  mainAvatar: string;
  /** The two small squares of the overview: the avatars they hold (empty = automatic). */
  squareSlots: string[];
  /** While music plays, show the album art on the closed island. */
  showMusicOnNotch: boolean;
  /** Mochi wears headphones while music plays. */
  mochiHeadphones: boolean;
  /** Colour overrides for individual Mochis: avatar id → "#rrggbb". */
  mochiColors: Record<string, string>;
  /** What Mochi wears: an outfit id, "auto" (by season) or "none". */
  mochiOutfit: string;
  /** Mochi lives on the desktop, outside the notch. */
  desktopMochi: boolean;
  /** Knowura Speak: hold Ctrl+Win, talk, and the words are typed where you were typing. */
  speakEnabled: boolean;
  speakModel: string;
  speakLanguage: string;
  /** Names and words Whisper should spell your way. */
  speakWords: string;
  /** Weather: the chosen city (empty = none yet), where it is, units, and whether to show it. */
  weatherPlace: string;
  weatherLat: number;
  weatherLon: number;
  weatherFahrenheit: boolean;
  showWeather: boolean;
  /** The small integration pills beside Mochi on the closed island. */
  showMiniPills: boolean;
  /** Close the open island, and the Knowura panel, when you click anywhere else. */
  closeOnClickOutside: boolean;
  /** Open when the pointer rests on the island, close when it leaves. */
  openOnHover: boolean;
  /** When off, the island never closes or hides by itself. */
  autoHide: boolean;
  alwaysOnTop: boolean;
  showInTaskbar: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  soundEnabled: true,
  soundVolume: 0.12,
  autoCloseInterval: 15,
  absenceInterval: 180,
  activeIntegrations: [
    "integration_resend", "integration_n8n", "integration_vercel", "integration_github",
  ],
  screen: "primary",
  autostart: false,
  hooksInstalled: false,
  model: "claude-opus-5",
  aiProvider: "anthropic",
  aiBaseUrl: "",
  islandWidth: 640,
  islandHeightExtra: 0,
  compactHeight: 32,
  assistantMode: "knowura",
  mainAvatar: "",
  squareSlots: ["", ""],
  showMusicOnNotch: true,
  mochiHeadphones: true,
  mochiColors: {},
  mochiOutfit: "auto",
  desktopMochi: false,
  speakEnabled: false,
  speakModel: "whisper-large-v3-turbo",
  speakLanguage: "auto",
  speakWords: "Knowura, Coucou, Mochi",
  weatherPlace: "",
  weatherLat: 0,
  weatherLon: 0,
  weatherFahrenheit: false,
  showWeather: true,
  showMiniPills: true,
  closeOnClickOutside: true,
  openOnHover: false,
  autoHide: true,
  alwaysOnTop: true,
  showInTaskbar: false,
};

type Listener = () => void;

class AppState {
  mode: IslandMode = "hidden";
  view: IslandViewName = "overview";

  tasks: AgentTask[] = [];
  focusId: string | null = null;

  stateOverride: BotStateName | null = null;

  /** Cursor in logical screen pixels, origin top-left (like AppState.mousePosition). */
  mouse = { x: 0, y: 0 };
  /** Cursor relative to the island's top-left corner. */
  mouseInIsland = { x: 0, y: 0 };

  isPinned = false;
  paused = false;
  /** The Knowura panel is open inside the notch. */
  knowuraOpen = false;

  music: MusicInfo | null = null;
  /** The main colour of the current album cover, for the player and the closed island's art. */
  musicColor: RGB | null = null;
  /** Which cover `musicColor` belongs to. */
  musicColorFor = "";

  /** Camera / microphone in use (Windows' own usage records). */
  privacy = { camera: false, mic: false };

  /** The outfit Mochi wears while the pointer is over a wardrobe tile. */
  wardrobePreview: Outfit | null = null;

  weather: WeatherInfo | null = null;
  weatherError: string | null = null;
  /** performance.now() when `music` last arrived: playback is extrapolated from it. */
  musicAt = 0;

  uploadProgress = 0;
  uploadDuration = 2.4;
  fileDragOver = false;

  promptContext: PromptContext | null = null;
  droppedFile: { name: string; path: string } | null = null;
  noteMessage: string | null = null;
  searchResult: SearchResult | null = null;
  chatHistory: ChatMessage[] = [];
  pendingApproval: ApprovalInfo | null = null;

  integrations: Record<string, IntegrationInfo> = {};

  lastActivity = performance.now();

  settings: Settings = { ...DEFAULT_SETTINGS };

  private listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Marks the UI dirty; the island re-renders on the next frame. */
  notify() {
    for (const fn of this.listeners) fn();
  }

  get focusTask(): AgentTask | null {
    return this.tasks.find((t) => t.id === this.focusId) ?? this.tasks[0] ?? null;
  }

  get effectiveState(): BotStateName {
    return this.stateOverride ?? this.focusTask?.state ?? "idle";
  }

  get otherTasks(): AgentTask[] {
    return this.tasks.filter((t) => t.id !== this.focusId);
  }

  setFocus(id: string) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    this.focusId = id;
    t.pillBadge = null;
    this.notify();
  }

  updateTask(id: string, state: BotStateName) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    t.state = state;
    this.notify();
  }

  appendStep(id: string, step: string) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    t.steps.push(step);
    if (t.steps.length > 20) t.steps.shift();
    t.stepIndex = t.steps.length - 1;
    this.notify();
  }

  // ── GitHub ──
  githubPulse: GitHubPulse | null = null;
  githubActivity: GitHubActivity | null = null;

  // ── Live diff ──
  /** The file changes of the current session, per agent, in order of arrival. */
  sessionDiffs = new Map<string, FileDiff[]>();
  private nextDiffId = 0;
  private diffTimers = new Map<string, number>();
  /** The diff open in the overview, if any. */
  activeDiff: { taskId: string; id: number } | null = null;

  /** Keeps a diff (at most 50 per agent) and returns the id its ticker step carries. */
  appendSessionDiff(id: string, diff: FileDiff): number {
    const d = { ...diff, id: this.nextDiffId++ };
    const list = this.sessionDiffs.get(id) ?? [];
    list.push(d);
    while (list.length > 50) list.shift();
    this.sessionDiffs.set(id, list);
    // Forgotten after an hour without a new one.
    window.clearTimeout(this.diffTimers.get(id));
    this.diffTimers.set(id, window.setTimeout(() => this.clearSessionDiffs(id), 3_600_000));
    return d.id;
  }

  clearSessionDiffs(id: string) {
    window.clearTimeout(this.diffTimers.get(id));
    this.diffTimers.delete(id);
    this.sessionDiffs.delete(id);
    if (this.activeDiff?.taskId === id) this.activeDiff = null;
    this.notify();
  }

  setPillBadge(id: string, badge: PillBadge | null) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    t.pillBadge = badge;
    this.notify();
  }

  /** loadIntegrationTasks() — VS Code always on, the rest opt-in (max 4). */
  loadIntegrationTasks() {
    for (const proto of INTEGRATION_AGENTS) {
      const shouldLoad =
        proto.id === "integration_claude" || this.settings.activeIntegrations.includes(proto.id);
      const idx = this.tasks.findIndex((t) => t.id === proto.id);
      if (shouldLoad && idx < 0) this.tasks.push({ ...proto, steps: [] });
      if (!shouldLoad && idx >= 0) this.tasks.splice(idx, 1);
    }
    // Order: integration_claude first, then agent_* pills (visible in slice(0,4)),
    // then other integrations in declaration order.
    const order = INTEGRATION_AGENTS.map((t) => t.id);
    this.tasks.sort((a, b) => {
      const isAgentA = a.id.startsWith("agent_");
      const isAgentB = b.id.startsWith("agent_");
      // integration_claude always first
      if (a.id === "integration_claude") return -1;
      if (b.id === "integration_claude") return 1;
      // agent_* before other integrations; preserve insertion order among themselves
      if (isAgentA && !isAgentB) return -1;
      if (isAgentB && !isAgentA) return 1;
      if (isAgentA && isAgentB) return 0;
      // both known integrations → declaration order
      return order.indexOf(a.id) - order.indexOf(b.id);
    });
    // Colours picked in the settings win over the defaults.
    for (const t of this.tasks) {
      t.baseColor ??= t.color;
      t.color = this.settings.mochiColors?.[t.id] || t.baseColor;
    }
    if (!this.focusId) this.focusId = "integration_claude";
    this.notify();
  }

  removeTask(id: string) {
    const idx = this.tasks.findIndex((t) => t.id === id);
    if (idx < 0) return;
    this.tasks.splice(idx, 1);
    if (this.focusId === id) this.focusId = this.tasks[0]?.id ?? "integration_claude";
    this.notify();
  }

  /** Creates a dynamic agent_ pill on first event; no-ops if it already exists.
   *  Inserted right after integration_claude so it appears in the visible slice(0,4). */
  upsertExternalAgent(id: string, name: string, color: string) {
    if (this.tasks.some((t) => t.id === id)) return;
    const at = this.tasks.findIndex((t) => t.id === "integration_claude") + 1;
    this.tasks.splice(at, 0, {
      id, name, color,
      state: "idle", stepIndex: 0, steps: [],
      source: "agent", isIntegration: false,
    });
    if (!this.focusId) this.focusId = id;
    this.notify();
  }

  toggleIntegration(id: string) {
    if (id === "integration_claude") return;
    const active = this.settings.activeIntegrations;
    if (active.includes(id)) {
      this.settings.activeIntegrations = active.filter((x) => x !== id);
      if (this.focusId === id) this.focusId = "integration_claude";
    } else {
      if (active.length >= 4) return;
      this.settings.activeIntegrations = [...active, id];
    }
    this.loadIntegrationTasks();
  }

  /**
   * The overview's two small squares: the avatars picked in the settings, and where a
   * slot is automatic (or its pick is the selected one) the next unselected avatar.
   */
  squareTasks(): (AgentTask | null)[] {
    const pool = this.tasks.filter((t) => t.id !== this.focusId);
    const taken = new Set<string>();
    const slots: (AgentTask | null)[] = [null, null];
    this.settings.squareSlots.slice(0, 2).forEach((id, i) => {
      const t = pool.find((x) => x.id === id && !taken.has(x.id));
      if (t) {
        slots[i] = t;
        taken.add(t.id);
      }
    });
    for (let i = 0; i < 2; i++) {
      if (slots[i]) continue;
      const t = pool.find((x) => !taken.has(x.id));
      if (t) {
        slots[i] = t;
        taken.add(t.id);
      }
    }
    return slots;
  }

  /** Selects the avatar chosen as the big one in the settings (empty = VS Code). */
  applyMainAvatar() {
    const id = this.settings.mainAvatar || "integration_claude";
    if (this.tasks.some((t) => t.id === id)) this.focusId = id;
    this.notify();
  }

  defaultView(): IslandViewName {
    return this.tasks.length === 0 ? "empty" : "overview";
  }
}

export const State = new AppState();
