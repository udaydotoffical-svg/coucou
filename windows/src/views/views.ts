// Island views — DOM ports of IslandViewContent.swift. Paddings, font sizes,
// colours and wording are copied from the Swift views so both platforms read
// identically.

import { DEFAULT_COLOR, palette } from "../core/color";
import { h, svg, clear, dot } from "./dom";
import { ICONS } from "./icons";
import { buildWeather, degrees, refreshWeather, weatherIcon } from "./weather";
import { Ticker } from "./ticker";
import { State, type AgentTask } from "../core/state";
import { washRGBA, type IslandViewName, type Wash } from "../core/layout";
import { createMiniBot, pruneMiniBots } from "../mochi/minibots";
import { buildPrompt } from "./chat";
import { buildChoose, buildUpload, buildUploading } from "./upload";
import { renderIntegrationCard, type IntegrationCardHooks } from "./integrations";

export interface ViewActions {
  setView(v: IslandViewName): void;
  collapse(): void;
  setFocus(id: string): void;
  openTerminal(): void;
  /** The ↗ button: opens whatever the focused pill points at. */
  openTarget(): void;
  openUrl(url: string): void;
  decide(d: "allow" | "deny"): void;
  toggleSound(): void;
  setVolume(v: number): void;
  setAutoClose(seconds: number): void;
  openSettingsWindow(): void;
  blip(): void;
  /** The music player's buttons: "toggle" | "next" | "prev" | "seek:<seconds>". */
  musicControl(action: string): void;
}

export interface ViewHost {
  el: HTMLElement;
  sync(): void;
  /** Called when the view becomes active, for views with a text field. */
  focus?(): void;
  /** Called every frame while the view is on screen. */
  tick?(nowMs: number): void;
}

// ── Shared pieces ─────────────────────────────────────────────────────────────

function card(wash: Wash, ...children: (Node | string)[]): HTMLElement {
  const el = h("div", { class: wash ? "card wash" : "card" }, ...children);
  if (wash) el.style.setProperty("--wash", washRGBA(wash));
  return el;
}

function btn(
  label: string,
  kind: "primary" | "secondary",
  onClick: () => void,
  kbd?: string,
): HTMLElement {
  return h(
    "button",
    { class: `btn ${kind}`, onclick: onClick },
    h("span", { text: label }),
    kbd ? h("span", { class: "kbd", text: kbd }) : null,
  );
}

/** AgentWho — coloured dot + task name + grey label. */
function agentWho(task: AgentTask | null, label: string): HTMLElement {
  const row = h("div", { class: "who-row" });
  if (task) {
    row.append(dot(task.color, 8), h("span", { class: "n", text: task.name }));
  }
  row.append(h("span", { text: label }));
  return row;
}

function stack(padLeft: number, padRight: number, ...children: Node[]): HTMLElement {
  const el = h("div", { class: "stack" }, ...children);
  el.style.padding = `4px ${padRight}px 4px ${padLeft}px`;
  return el;
}

// ── Header ────────────────────────────────────────────────────────────────────

export function buildHeader(actions: ViewActions): ViewHost {
  const tabHome = h("button", { class: "tab", title: "Overview", onclick: () => go("overview") }, svg(ICONS.house, 13));
  const tabChat = h("button", { class: "tab", title: "Ask", onclick: () => go("prompt") }, svg(ICONS.bubble, 13));
  const tabDrop = h("button", { class: "tab", title: "Drop", onclick: () => go("upload") }, svg(ICONS.plus, 13));
  const tabWeather = h("button", { class: "tab", title: "Weather", onclick: () => go("weather") }, weatherIcon(3, true, 14));
  const chip = h("button", { class: "wx-chip", title: "Weather", onclick: () => go("weather") });
  let chipKey = "";

  const gearBtn = h("button", { title: "Settings", onclick: () => go("settings") }, svg(ICONS.gear, 14));
  const soundBtn = h("button", { title: "Mute", onclick: () => actions.toggleSound() }, svg(ICONS.speakerOn, 14));

  function go(v: IslandViewName) {
    actions.blip();
    actions.setView(v);
  }

  const el = h(
    "div",
    { id: "header" },
    h("div", { class: "tabs" }, tabHome, tabChat, tabDrop, tabWeather),
    chip,
    h("div", { class: "header-actions" }, gearBtn, soundBtn),
  );

  return {
    el,
    sync() {
      const v = State.view;
      tabHome.classList.toggle("on", v === "overview" || v === "empty");
      tabChat.classList.toggle("on", v === "prompt");
      tabDrop.classList.toggle("on", v === "upload");
      tabWeather.classList.toggle("on", v === "weather");
      tabWeather.style.display = State.settings.showWeather ? "" : "none";
      // The temperature in the middle of the bar, once there is a city and a forecast.
      const w = State.weather;
      if (State.settings.showWeather && State.settings.weatherPlace) void refreshWeather();
      chip.style.display = State.settings.showWeather && w ? "" : "none";
      const ck = w ? `${w.code}|${w.isDay}|${Math.round(w.temp)}|${w.place}|${Math.round(w.high)}|${Math.round(w.low)}` : "";
      if (ck !== chipKey) {
        chipKey = ck;
        clear(chip);
        if (w) {
          chip.append(
            weatherIcon(w.code, w.isDay, 13),
            h("span", { class: "wx-where", text: w.place }),
            h("b", { text: degrees(w.temp) }),
            h("span", { class: "wx-hl", text: `H ${degrees(w.high)} · L ${degrees(w.low)}` }),
          );
        }
      }
      gearBtn.classList.toggle("on", v === "settings");
      clear(gearBtn);
      gearBtn.append(svg(v === "settings" ? ICONS.gearFill : ICONS.gear, 14));
      clear(soundBtn);
      soundBtn.append(svg(State.settings.soundEnabled ? ICONS.speakerOn : ICONS.speakerOff, 14));
      el.style.opacity = v === "confused" ? "0" : "1";
    },
  };
}

// ── Overview ──────────────────────────────────────────────────────────────────

function buildOverview(actions: ViewActions): ViewHost {
  const ticker = new Ticker();
  const who = h("div", { class: "who" });
  const tickerBody = h("div", { class: "card-body" }, who, ticker.el);
  const leftBody = h("div", { class: "left-body" });
  const jump = h(
    "button",
    { class: "icon-btn jump", title: "Open", onclick: () => actions.openTarget() },
    svg(ICONS.arrowUpRight, 8),
  );
  const left = card(null, leftBody, jump);
  // The right side. With music: two small squares for unselected avatars and the player
  // under them. Without: the original grid of pills.
  const squares = h("div", { class: "duo" });
  const player = buildPlayer(actions);
  const rightcol = h("div", { class: "rightcol" }, squares, player.el);
  const pills = h("div", { class: "pills" });
  const pillsCard = card(null, pills);

  const el = h("div", { class: "view overview" },
    h("div", { class: "left" }, left),
    h("div", { class: "right" }, rightcol, pillsCard),
  );
  let pillKeyShown = "";

  let pillIds = "";
  let detailOpen = false;
  let lastFocus: string | null = null;
  let mode: "ticker" | "card" | null = null;
  let cardKey = "";

  const hooks: IntegrationCardHooks = {
    get detailOpen() {
      return detailOpen;
    },
    openDetail() {
      detailOpen = true;
      cardKey = "";
      State.notify();
    },
    closeDetail() {
      detailOpen = false;
      cardKey = "";
      State.notify();
    },
    openSettings: () => actions.openSettingsWindow(),
  };

  return {
    el,
    tick(nowMs: number) {
      if (mode === "ticker") ticker.tick(nowMs);
    },
    sync() {
      const task = State.focusTask;
      if (task?.id !== lastFocus) {
        lastFocus = task?.id ?? null;
        detailOpen = false;
        cardKey = "";
        mode = null;
      }

      // VS Code with a live Claude Code session keeps the ticker; every other
      // pill shows its own card, exactly like IntegrationCardView.
      const sessionActive =
        task?.id === "integration_claude" && (task.state !== "idle" || task.steps.length > 0);

      if (task && sessionActive) {
        if (mode !== "ticker") {
          clear(leftBody);
          leftBody.append(tickerBody);
          mode = "ticker";
          cardKey = "";
        }
        clear(who);
        who.append(
          dot(task.color, 7),
          h("span", { class: "name", text: task.name }),
          h("span", { class: "tool", text: task.source === "claudeCode" ? "Claude Code" : "n8n" }),
        );
        if (task.steps.length > 1) {
          who.append(h("span", {
            class: "count",
            text: `${Math.min(task.stepIndex + 1, task.steps.length)}/${task.steps.length}`,
          }));
        }
        ticker.sync(task);
      } else if (task) {
        const info = State.integrations[task.id];
        const key = [
          task.id, detailOpen, task.state, task.steps.join("|"),
          info?.loaded, info?.error, info?.configured,
          JSON.stringify(info?.data ?? {}),
        ].join("~");
        if (key !== cardKey) {
          cardKey = key;
          mode = "card";
          clear(leftBody);
          leftBody.append(renderIntegrationCard(task, hooks));
        }
      }

      jump.style.display = detailOpen ? "none" : "";

      const showPlayer = !!State.music?.active;
      rightcol.style.display = showPlayer ? "" : "none";
      pillsCard.style.display = showPlayer ? "none" : "";
      if (showPlayer) {
        const slots = State.squareTasks();
        const squareKey = slots.map((t) => (t ? `${t.id}:${t.color}:${t.pillBadge ?? ""}` : "-")).join("|");
        if (squareKey !== pillIds) {
          pillIds = squareKey;
          clear(squares);
          for (const t of slots) squares.append(buildSquare(t, actions));
          pruneMiniBots();
        }
        player.sync();
      } else {
        const others = State.otherTasks.slice(0, 4);
        const pillKey = others.map((t) => `${t.id}:${t.color}:${t.pillBadge ?? ""}`).join("|");
        if (pillKey !== pillKeyShown) {
          pillKeyShown = pillKey;
          clear(pills);
          for (const t of others) pills.append(buildPill(t, actions));
          pruneMiniBots();
        }
      }
    },
  };
}

function buildPill(task: AgentTask, actions: ViewActions): HTMLElement {
  const label = task.id === "integration_claude" ? "VS Code" : task.name;
  const canvas = createMiniBot(task, 24);
  const pill = h(
    "div",
    { class: "pill", onclick: () => actions.setFocus(task.id) },
    canvas,
    h("span", { class: "lbl", text: label }),
  );
  pill.style.borderColor = `${task.color}24`;
  pill.addEventListener("mouseenter", () => {
    pill.style.background = `${task.color}2e`;
    pill.style.borderColor = `${task.color}8c`;
    pill.style.boxShadow = `0 2px 10px ${task.color}59`;
    (pill.querySelector(".lbl") as HTMLElement).style.color = lighten(task.color, 0.3);
  });
  pill.addEventListener("mouseleave", () => {
    pill.style.background = "";
    pill.style.borderColor = `${task.color}24`;
    pill.style.boxShadow = "";
    (pill.querySelector(".lbl") as HTMLElement).style.color = "";
  });

  if (task.pillBadge) {
    const colors = { approval: "#F5A524", finished: "#22C55E", error: "#F4505E" } as const;
    const icons = { approval: ICONS.bang, finished: ICONS.check, error: ICONS.xmark } as const;
    const inner = h("i", { style: `background:${colors[task.pillBadge]}` }, svg(icons[task.pillBadge], 6, { stroke: task.pillBadge === "finished" ? 3 : 0 }));
    const badge = h("div", { class: "pill-badge" }, inner);
    badge.style.boxShadow = `0 0 4px ${colors[task.pillBadge]}99`;
    pill.append(badge);
  }
  return pill;
}

/** One of the overview's two small squares: an unselected avatar. Click to select it. */
function buildSquare(task: AgentTask | null, actions: ViewActions): HTMLElement {
  if (!task) return h("div", { class: "square empty" });
  const label = task.id === "integration_claude" ? "VS Code" : task.name;
  const canvas = createMiniBot(task, 26);
  const sq = h(
    "div",
    { class: "square", onclick: () => actions.setFocus(task.id) },
    canvas,
    h("span", { class: "lbl", text: label }),
  );
  sq.style.borderColor = `${task.color}30`;
  sq.addEventListener("mouseenter", () => {
    sq.style.background = `${task.color}2e`;
    sq.style.borderColor = `${task.color}8c`;
    sq.style.boxShadow = `0 2px 10px ${task.color}59`;
    (sq.querySelector(".lbl") as HTMLElement).style.color = lighten(task.color, 0.3);
  });
  sq.addEventListener("mouseleave", () => {
    sq.style.background = "";
    sq.style.borderColor = `${task.color}30`;
    sq.style.boxShadow = "";
    (sq.querySelector(".lbl") as HTMLElement).style.color = "";
  });

  if (task.pillBadge) {
    const colors = { approval: "#F5A524", finished: "#22C55E", error: "#F4505E" } as const;
    const icons = { approval: ICONS.bang, finished: ICONS.check, error: ICONS.xmark } as const;
    const inner = h("i", { style: `background:${colors[task.pillBadge]}` }, svg(icons[task.pillBadge], 6, { stroke: task.pillBadge === "finished" ? 3 : 0 }));
    const badge = h("div", { class: "pill-badge" }, inner);
    badge.style.boxShadow = `0 0 4px ${colors[task.pillBadge]}99`;
    sq.append(badge);
  }
  return sq;
}

// ── Music player ──────────────────────────────────────────────────────────────

const clock = (secs: number) => {
  const s = Math.max(0, Math.floor(secs));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/**
 * The player under the two squares: album art with a blurred glow behind it, the
 * track (scrolling when it is long), a bar to seek on, and previous / play / next.
 * What is playing comes from Windows' media session, so it works for Spotify, a
 * browser tab, Apple Music, VLC — whatever is playing.
 */
function buildPlayer(actions: ViewActions): { el: HTMLElement; sync(): void } {
  const bg = h("div", { class: "p-bg" });
  const art = h("div", { class: "p-art noart" }, svg(ICONS.note, 20));
  const title = h("span", { class: "p-title-text" });
  const titleBox = h("div", { class: "p-title" }, title);
  // Moving bars above the title, in rainbow colours. They bounce with the music playing.
  const viz = h("div", { class: "p-viz" });
  for (let i = 0; i < 20; i++) {
    const bar = h("i");
    bar.style.setProperty("--i", String(i));
    bar.style.setProperty("--d", `${(0.55 + ((i * 37) % 11) / 14).toFixed(2)}s`);
    bar.style.setProperty("--o", `-${(i * 0.13).toFixed(2)}s`);
    bar.style.setProperty("--lo", (0.15 + ((i * 53) % 7) / 30).toFixed(2));
    viz.append(bar);
  }
  const artist = h("div", { class: "p-artist" });
  const elapsed = h("span", { class: "p-time" });
  const total = h("span", { class: "p-time r" });
  const fill = h("div", { class: "p-fill" });
  const bar = h("div", { class: "p-bar", title: "Seek" }, fill);
  const prev = h("button", { class: "p-btn", title: "Previous" }, svg(ICONS.skipPrev, 13)) as HTMLButtonElement;
  const play = h("button", { class: "p-btn p-play", title: "Play / pause" }, svg(ICONS.play, 15)) as HTMLButtonElement;
  const next = h("button", { class: "p-btn", title: "Next" }, svg(ICONS.skipNext, 13)) as HTMLButtonElement;
  const shuffle = h("button", { class: "p-mini", title: "Shuffle" }, svg(ICONS.shuffle, 12, { stroke: 2 })) as HTMLButtonElement;
  const repeat = h("button", { class: "p-mini", title: "Repeat" }, svg(ICONS.repeat, 12, { stroke: 2 })) as HTMLButtonElement;

  const el = h(
    "div",
    { class: "player idle" },
    bg,
    art,
    h("div", { class: "p-main" },
      viz,
      h("div", { class: "p-head" }, titleBox),
      artist,
      h("div", { class: "p-seek" }, elapsed, bar, total),
    ),
    h("div", { class: "p-ctl" },
      h("div", { class: "p-row" }, prev, play, next),
      h("div", { class: "p-skips" }, shuffle, repeat),
    ),
  );

  // While the bar is being dragged it shows the drag position, not the song's.
  let scrub: number | null = null;
  const livePosition = (): number => {
    const m = State.music;
    if (!m) return 0;
    const p = m.position + (m.playing ? (performance.now() - State.musicAt) / 1000 : 0);
    return m.duration > 0 ? Math.min(p, m.duration) : p;
  };
  const paint = () => {
    const m = State.music;
    if (!m?.active) return;
    const p = scrub ?? livePosition();
    fill.style.width = m.duration > 0 ? `${(p / m.duration) * 100}%` : "0%";
    elapsed.textContent = clock(p);
    total.textContent = m.duration > 0 ? clock(m.duration) : "";
  };

  // The bar moves on a timer that only runs while the player is on screen and playing.
  let timer: number | null = null;
  const syncTimer = () => {
    const want = State.mode === "expanded" && State.view === "overview" && !!State.music?.playing;
    if (want && timer == null) timer = window.setInterval(paint, 500);
    else if (!want && timer != null) {
      window.clearInterval(timer);
      timer = null;
    }
  };

  shuffle.addEventListener("click", () => {
    const m = State.music;
    if (m) {
      m.shuffle = !m.shuffle;
      State.notify();
    }
    actions.musicControl("shuffle");
  });
  repeat.addEventListener("click", () => {
    const m = State.music;
    if (m) {
      m.repeat = m.repeat === "none" ? "list" : m.repeat === "list" ? "track" : "none";
      State.notify();
    }
    actions.musicControl("repeat");
  });

  prev.addEventListener("click", () => actions.musicControl("prev"));
  next.addEventListener("click", () => actions.musicControl("next"));
  play.addEventListener("click", () => {
    const m = State.music;
    if (m) {
      // Instant feedback; Windows confirms a moment later.
      m.position = livePosition();
      m.playing = !m.playing;
      State.musicAt = performance.now();
      State.notify();
    }
    actions.musicControl("toggle");
  });
  // Drag the bar to scrub; the song jumps when you let go. A plain click seeks too.
  const secondsAt = (e: PointerEvent): number => {
    const m = State.music;
    const r = bar.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * (m?.duration ?? 0);
  };
  bar.addEventListener("pointerdown", (e) => {
    const m = State.music;
    if (!m?.canSeek || m.duration <= 0) return;
    bar.setPointerCapture(e.pointerId);
    bar.classList.add("scrubbing");
    scrub = secondsAt(e);
    paint();
    e.preventDefault();
  });
  bar.addEventListener("pointermove", (e) => {
    if (scrub == null) return;
    scrub = secondsAt(e);
    paint();
  });
  const release = (commit: boolean) => {
    if (scrub == null) return;
    const secs = scrub;
    scrub = null;
    bar.classList.remove("scrubbing");
    const m = State.music;
    if (commit && m) {
      m.position = secs;
      State.musicAt = performance.now();
      actions.musicControl(`seek:${secs.toFixed(2)}`);
    }
    paint();
  };
  bar.addEventListener("pointerup", () => release(true));
  bar.addEventListener("pointercancel", () => release(false));

  // A title too long for its space slides sideways so it can be read in full. The space
  // changes while the island opens, so it is measured again whenever it changes size.
  const measureTitle = () => {
    const over = title.scrollWidth - titleBox.clientWidth;
    titleBox.classList.toggle("scroll", over > 4);
    if (over > 4) titleBox.style.setProperty("--over", `${over + 8}px`);
  };
  new ResizeObserver(measureTitle).observe(titleBox);

  let trackKey = "";
  let wasPlaying: boolean | null = null;
  let repeatShown = "none";
  let colorShown = "";
  return {
    el,
    sync() {
      const m = State.music;
      const idle = !m || !m.active;
      el.classList.toggle("idle", idle);
      // The bars only move while the island is open: a closed one costs nothing.
      el.classList.toggle("playing", !!m?.playing && State.mode === "expanded");
      const pal = palette(State.musicColor ?? DEFAULT_COLOR);
      if (pal.p !== colorShown) {
        colorShown = pal.p;
        el.style.setProperty("--p", pal.p);
        el.style.setProperty("--p-light", pal.light);
        el.style.setProperty("--p-ink", pal.ink);
      }
      if (idle) {
        if (trackKey !== "idle") {
          trackKey = "idle";
          title.textContent = "Nothing playing";
          artist.textContent = "Play something in Spotify, YouTube Music…";
          art.style.backgroundImage = "";
          art.classList.add("noart");
          bg.style.backgroundImage = "";
          titleBox.classList.remove("scroll");
        }
        syncTimer();
        return;
      }
      const key = `${m.app}|${m.title}|${m.artist}|${m.art?.length ?? 0}`;
      if (key !== trackKey) {
        trackKey = key;
        title.textContent = m.title || "Unknown title";
        artist.textContent = m.artist || m.album || "";
        const url = m.art ? `url("${m.art}")` : "";
        art.style.backgroundImage = url;
        bg.style.backgroundImage = url;
        art.classList.toggle("noart", !m.art);
        measureTitle();
      }
      if (wasPlaying !== m.playing) {
        wasPlaying = m.playing;
        clear(play);
        play.append(svg(m.playing ? ICONS.pause : ICONS.play, 15));
      }
      prev.disabled = !m.canPrev;
      next.disabled = !m.canNext;
      play.disabled = !m.canToggle;
      shuffle.disabled = !m.canShuffle;
      repeat.disabled = !m.canRepeat;
      shuffle.classList.toggle("on", m.shuffle);
      repeat.classList.toggle("on", m.repeat !== "none");
      if (repeatShown !== m.repeat) {
        repeatShown = m.repeat;
        clear(repeat);
        repeat.append(svg(m.repeat === "track" ? ICONS.repeatOne : ICONS.repeat, 12, { stroke: 2 }));
      }
      bar.classList.toggle("seekable", m.canSeek && m.duration > 0);
      paint();
      syncTimer();
    },
  };
}

function lighten(hex: string, amount: number): string {
  const v = parseInt(hex.replace("#", ""), 16);
  const c = [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((x) =>
    Math.min(255, Math.round(x + amount * 255)),
  );
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

// ── Empty ─────────────────────────────────────────────────────────────────────

function buildEmpty(actions: ViewActions): ViewHost {
  const body = h(
    "div",
    { class: "stack", style: "padding:0 18px 0 118px;flex-direction:row;align-items:center;gap:16px" },
    h(
      "div",
      { style: "display:flex;flex-direction:column;gap:5px" },
      h("div", { class: "title", text: "Nothing running right now." }),
      h("div", { class: "sub", text: "Drop a file or window, or ask me anything." }),
    ),
    h("div", { class: "grow" }),
    btn("Ask Claude", "primary", () => actions.setView("prompt")),
  );
  return { el: h("div", { class: "view" }, card(null, body)), sync() {} };
}

// ── Approval ──────────────────────────────────────────────────────────────────

function buildApproval(actions: ViewActions): ViewHost {
  const who = h("div");
  const code = h("div", { class: "code" });
  const row = h("div", { class: "actions" });
  const el = h("div", { class: "view" }, card("amber", stack(116, 16, who, code, row)));
  let rowKey = "";
  return {
    el,
    sync() {
      clear(who);
      who.append(agentWho(State.focusTask, "needs permission"));
      // The whole point of approving here rather than in the terminal: this line
      // is the command, the file path or the URL being authorised, not just the
      // name of the tool asking.
      code.textContent = State.pendingApproval?.command || State.pendingApproval?.tool || "…";
      // Two buttons, built once. Rebuilding them between a mouse-down and a
      // mouse-up would swallow the click, and there is nothing left to vary:
      // "Always" is gone until the remembered-rules list exists to back it.
      if (rowKey === "built") return;
      rowKey = "built";
      clear(row);
      row.append(
        btn("Deny", "secondary", () => actions.decide("deny"), "N"),
        btn("Allow", "primary", () => actions.decide("allow"), "Y"),
      );
    },
  };
}

// ── Question ──────────────────────────────────────────────────────────────────

function buildQuestion(): ViewHost {
  const who = h("div");
  const title = h("div", { class: "title" });
  const row = h("div", { class: "actions" });
  const el = h("div", { class: "view" }, card("cyan", stack(116, 16, who, title, row)));
  return {
    el,
    sync() {
      clear(who);
      who.append(agentWho(State.focusTask, "Claude Code is asking a question"));
      const task = State.focusTask;
      title.textContent = task?.steps.at(-1) ?? "Claude needs an answer.";
      clear(row);
      row.append(h("div", { class: "sub", text: "Answer in your terminal — Coucou can't reply for you yet." }));
    },
  };
}

// ── Error ─────────────────────────────────────────────────────────────────────

function buildError(actions: ViewActions): ViewHost {
  const who = h("div");
  const title = h("div", { class: "title", text: "Workflow stopped." });
  const detail = h("div", { class: "detail" });
  const row = h("div", { class: "actions" },
    btn("Retry", "primary", () => actions.setView(State.defaultView())),
    btn("Open in n8n", "secondary", () => actions.openUrl("")),
  );
  const el = h("div", { class: "view" }, card("red", stack(116, 16, who, title, detail, row)));
  return {
    el,
    sync() {
      const task = State.focusTask;
      clear(who);
      who.append(agentWho(task, task?.source === "n8n" ? "n8n" : "Claude Code"));
      title.textContent = task?.source === "n8n" ? "Workflow stopped." : "Session stopped on an error.";
      detail.textContent = task?.steps.at(-1) ?? "No detail available.";
    },
  };
}

// ── Finished ──────────────────────────────────────────────────────────────────

function buildFinished(actions: ViewActions): ViewHost {
  const who = h("div");
  const title = h("div", { class: "title" });
  const row = h("div", { class: "actions" },
    btn("Open terminal", "primary", () => actions.openTerminal()),
    btn("OK", "secondary", () => actions.collapse()),
  );
  const el = h("div", { class: "view" }, card("green", stack(116, 16, who, title, row)));
  return {
    el,
    sync() {
      clear(who);
      who.append(agentWho(State.focusTask, "Claude Code finished"));
      title.textContent = State.focusTask?.steps.at(-1) ?? "Session finished";
    },
  };
}

// ── Confused ──────────────────────────────────────────────────────────────────

function buildConfused(): ViewHost {
  const body = h(
    "div",
    { class: "stack", style: "padding:0 18px 0 128px" },
    h("div", { class: "title", text: "Too many hits at once." }),
    h("div", { class: "sub", text: "Give me a sec — back to work in three seconds." }),
  );
  return { el: h("div", { class: "view" }, card("pink", body)), sync() {} };
}

// ── Note ──────────────────────────────────────────────────────────────────────

function buildNote(): ViewHost {
  const title = h("div", { class: "title" });
  const el = h("div", { class: "view" }, card(null, h("div", { class: "stack", style: "padding:0 18px 0 98px" }, title)));
  return {
    el,
    sync() {
      title.textContent = State.noteMessage ?? "";
    },
  };
}

// ── In-island settings ────────────────────────────────────────────────────────

function buildSettings(actions: ViewActions): ViewHost {
  const soundSwitch = h("button", { class: "switch", onclick: () => actions.toggleSound() });
  const volume = h("input", {
    type: "range", min: "0", max: "0.2", step: "0.005",
    oninput: (e: Event) => actions.setVolume(Number((e.target as HTMLInputElement).value)),
  }) as HTMLInputElement;
  const autoLabel = h("span", {});
  const segButtons = [10, 15, 30].map((s) =>
    h("button", { onclick: () => actions.setAutoClose(s) }, `${s}s`),
  );
  const claudeBadge = h("span", { class: "status-badge" });
  const apiBadge = h("span", { class: "status-badge" });

  const rows = h(
    "div",
    { class: "settings-rows" },
    h("div", { class: "settings-row" }, soundSwitch, h("span", { text: "Sound" }), volume),
    h(
      "div",
      { class: "settings-row" },
      svg(ICONS.timer, 12),
      autoLabel,
      h("div", { class: "seg" }, ...segButtons),
    ),
    h(
      "div",
      { class: "settings-row", style: "gap:14px" },
      claudeBadge,
      apiBadge,
      h("div", { class: "grow" }),
      h("button", {
        class: "link-btn",
        style: "color:#8e939c;font-size:11.5px",
        text: "Settings…",
        onclick: () => actions.openSettingsWindow(),
      }),
    ),
  );

  const el = h("div", { class: "view" },
    card(null, h("div", { class: "stack", style: "padding:14px 16px 14px 84px" }, rows)));

  return {
    el,
    sync() {
      const s = State.settings;
      soundSwitch.classList.toggle("on", s.soundEnabled);
      volume.value = String(s.soundVolume);
      volume.style.opacity = s.soundEnabled ? "1" : "0.4";
      autoLabel.textContent = `Auto-close · ${Math.round(s.autoCloseInterval)}s`;
      segButtons.forEach((b, i) => b.classList.toggle("on", s.autoCloseInterval === [10, 15, 30][i]));
      clear(claudeBadge);
      claudeBadge.append(
        dot(s.hooksInstalled ? "#22C55E" : "#F4505E", 6),
        h("span", { text: "Claude Code" }),
      );
      clear(apiBadge);
      apiBadge.append(dot("#F4505E", 6), h("span", { text: "API" }));
    },
  };
}

// ── Placeholders filled in later stages ───────────────────────────────────────

function buildPlaceholder(title: string, sub: string): ViewHost {
  const body = h(
    "div",
    { class: "stack", style: "padding:0 18px 0 118px" },
    h("div", { class: "title", text: title }),
    h("div", { class: "sub", text: sub }),
  );
  return { el: h("div", { class: "view" }, card(null, body)), sync() {} };
}

// ── Registry ──────────────────────────────────────────────────────────────────

export function buildViews(
  actions: ViewActions,
  onChatHeightChange: () => void,
): Map<IslandViewName, ViewHost> {
  const map = new Map<IslandViewName, ViewHost>();
  map.set("overview", buildOverview(actions));
  map.set("weather", buildWeather(actions));
  map.set("empty", buildEmpty(actions));
  map.set("approval", buildApproval(actions));
  map.set("question", buildQuestion());
  map.set("error", buildError(actions));
  map.set("finished", buildFinished(actions));
  map.set("confused", buildConfused());
  map.set("note", buildNote());
  map.set("settings", buildSettings(actions));
  map.set("prompt", buildPrompt(onChatHeightChange));
  map.set("upload", buildUpload());
  map.set("uploading", buildUploading());
  map.set("choose", buildChoose(actions));
  // Not in the Windows v1: sending a file by email, window attach + web result.
  map.set("mail", buildPlaceholder("Sending by email isn't in this version.", ""));
  map.set("searching", buildPlaceholder("Claude is searching…", ""));
  map.set("result", buildPlaceholder("Result", ""));
  return map;
}
