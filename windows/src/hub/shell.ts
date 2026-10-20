// The Coucou window: a sidebar with Notch (every setting of the island) and the page on the right,
// under its coloured band. Port of FlowHub.swift, without Flow (dictation, the Notetaker…) and
// « OK Coucou », which this build does not have: Knowura Speak and Knowura take their place.

import "./hub.css";
import { h, clear } from "../views/dom";
import { t } from "../i18n/i18n";
import { onEvent } from "../core/bridge";
import { hero, liveMochi, setWindowShown } from "./hero";
import { FlowBridge } from "../core/flow";
import { icon } from "./ui";

export type PageId =
  | "general" | "pills" | "agents" | "chat" | "knowura" | "island" | "computer"
  | "integrations" | "phone" | "shortcuts";

interface PageDef {
  id: PageId;
  icon: string;
  title: () => string;
  /** The band's line; none for pages that draw their own band. */
  subtitle?: () => string;
}

export const NOTCH_PAGES: PageDef[] = [
  { id: "general", icon: "gear", title: () => t("General"), subtitle: () => t("Mochi, his sounds and how the island behaves.") },
  { id: "pills", icon: "grid", title: () => t("Active pills"), subtitle: () => t("The pills shown in the island, their order and their colours.") },
  { id: "agents", icon: "terminal", title: () => t("Agents"), subtitle: () => t("Claude Code, Codex and the other agents Mochi follows.") },
  { id: "chat", icon: "chat", title: () => t("Chat"), subtitle: () => t("The AI of the island's chat, with your own keys.") },
  { id: "knowura", icon: "wave", title: () => "Knowura", subtitle: () => "The assistant in the notch, and Knowura Speak: hold Ctrl+Win and talk." },
  { id: "island", icon: "window", title: () => "Island", subtitle: () => "How big it is, what it shows, where Mochi's squares and music player go, the weather." },
  { id: "computer", icon: "sliders", title: () => "Mochi on your PC", subtitle: () => "Tell him what to do and he does it, with a pointer of his own." },
  { id: "integrations", icon: "puzzle", title: () => t("Integrations"), subtitle: () => t("Stripe, GitHub, Vercel, n8n, Notion and the rest.") },
  { id: "phone", icon: "phone", title: () => t("Android phone"), subtitle: () => t("Your agents and their approvals on your Android phone, over your Wi-Fi.") },
  { id: "shortcuts", icon: "keyboard", title: () => t("Shortcuts"), subtitle: () => t("The keys that open the island and its actions.") },
];

export interface HubOptions {
  version: string;
  /** Draws the island's settings for one of the Notch pages into `container`. */
  renderNotch(page: PageId, container: HTMLElement): Promise<void>;
}

export async function startHub(root: HTMLElement, opts: HubOptions) {
  document.body.classList.add("hub-window");
  // The window is created hidden and only shown and hidden afterwards: its
  // canvases animate only while it is on screen (#792).
  await onEvent<boolean>("hub-visible", setWindowShown);
  const shown = await hubShown();
  if (shown !== null) setWindowShown(shown);
  let current: PageId = "general";
  const items = new Map<PageId, HTMLElement>();
  const scroll = h("div", { class: "hub-scroll" });
  let rendering = 0;

  async function show(page: PageId) {
    const def = NOTCH_PAGES.find((p) => p.id === page) ?? NOTCH_PAGES[0];
    current = def.id;
    for (const [id, el] of items) el.classList.toggle("on", id === current);
    const token = ++rendering;
    const page_ = h("div", { class: "hub-page" });
    page_.append(hero(def.id, def.title(), def.subtitle?.() ?? null));
    const container = h("div", { id: "settings-root" });
    page_.append(container);
    await opts.renderNotch(def.id, container);
    if (token !== rendering) return;
    clear(scroll);
    scroll.append(page_);
    scroll.scrollTop = 0;
  }

  // ── The sidebar ──
  const side = h("nav", { class: "hub-side" });
  const logo = h("canvas", {});
  side.append(h("div", { class: "hub-brand" }, logo, h("span", { text: "Coucou" })));
  liveMochi(logo as HTMLCanvasElement);
  side.append(h("div", { class: "hub-group", text: t("Notch") }));
  for (const p of NOTCH_PAGES) {
    const b = h("button", { class: "hub-item", onclick: () => void show(p.id) });
    b.append(icon(p.icon), h("span", { text: p.title() }));
    items.set(p.id, b);
    side.append(b);
  }
  side.append(h("div", { class: "spacer" }), h("div", { class: "hub-version", text: `Coucou ${opts.version}` }));

  clear(root);
  root.append(side, h("main", { class: "hub-panel" }, scroll));
  await show(current);

  void onEvent<string>("hub-page", (page) => {
    // The old Flow settings page is the General one here.
    const id = (page === "settings" || page === "flowsettings" ? "general" : page) as PageId;
    if (NOTCH_PAGES.some((p) => p.id === id)) void show(id);
  });
  return {
    redraw: () => void show(current),
    current: () => current,
  };
}

/** Whether Rust has the Coucou window on screen right now (null outside the app). */
async function hubShown(): Promise<boolean | null> {
  return FlowBridge.hubShown();
}
