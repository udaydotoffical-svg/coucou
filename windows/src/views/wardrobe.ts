// The wardrobe: a grid of tiles, one per outfit. Hovering a tile dresses Mochi in it,
// clicking keeps it. Opened by right-clicking Mochi (WardrobeView in IslandViewContent.swift).

import { Bridge } from "../core/bridge";
import { State } from "../core/state";
import { drawOutfitIcon, OUTFIT_LIST, outfitName, resolveOutfit, seasonalOutfit, type Outfit } from "../mochi/outfits";
import { h } from "./dom";
import type { ViewActions, ViewHost } from "./views";

const TILE = 30;

export function buildWardrobe(actions: ViewActions): ViewHost {
  const title = h("div", { class: "title", text: "Wardrobe" });
  const sub = h("div", { class: "sub" });
  const grid = h("div", { class: "wd-grid" });
  const tiles = new Map<Outfit, HTMLElement>();

  const dpr = () => Math.max(1, window.devicePixelRatio || 1);

  for (const o of OUTFIT_LIST) {
    const cv = document.createElement("canvas");
    const px = Math.round(TILE * dpr());
    cv.width = px;
    cv.height = px;
    cv.style.width = `${TILE - 8}px`;
    cv.style.height = `${TILE - 8}px`;
    const x = cv.getContext("2d");
    if (x) {
      x.scale(px / TILE, px / TILE);
      // "Auto" shows the outfit of the day, or a bare Mochi when there is none.
      drawOutfitIcon(x, TILE, o.id === "auto" ? seasonalOutfit() : o.id);
    }
    const tile = h("button", { class: "wd-tile", title: o.name }, cv);
    if (o.id === "auto") tile.append(h("span", { class: "wd-auto", text: "AUTO" }));
    tile.addEventListener("mouseenter", () => {
      State.wardrobePreview = resolveOutfit(o.id);
      State.notify();
    });
    tile.addEventListener("mouseleave", () => {
      State.wardrobePreview = null;
      State.notify();
    });
    tile.addEventListener("click", () => {
      if (State.settings.mochiOutfit === o.id) return;
      actions.blip();
      State.settings.mochiOutfit = o.id;
      void Bridge.saveSettings(State.settings);
      State.notify();
    });
    tiles.set(o.id, tile);
    grid.append(tile);
  }

  const body = h(
    "div",
    { class: "stack", style: "padding:0 18px 0 118px;gap:8px" },
    h("div", { class: "wd-head" }, title, sub),
    grid,
  );
  const el = h("div", { class: "view" }, h("div", { class: "card" }, body));

  return {
    el,
    sync() {
      const sel = (State.settings.mochiOutfit || "auto") as Outfit;
      for (const [id, tile] of tiles) tile.classList.toggle("on", id === sel);
      const shown = State.wardrobePreview;
      const seasonal = seasonalOutfit();
      if (shown != null) sub.textContent = outfitName(shown);
      else if (sel === "auto") sub.textContent = `Auto · ${outfitName(seasonal)}`;
      else sub.textContent = outfitName(sel);
    },
  };
}
