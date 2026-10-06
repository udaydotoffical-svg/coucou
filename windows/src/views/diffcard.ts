// The card that shows the lines of one file the agent changed (DiffCardView in IslandViewContent.swift).
// It sits over the ticker; its back button, Escape or a new view brings the ticker back.

import { diffName, type FileDiff } from "../core/diff";
import { Bridge } from "../core/bridge";
import { h, svg } from "./dom";
import { ICONS } from "./icons";

export interface DiffCard {
  el: HTMLElement;
  /** Shows a diff, or hides the card when null. */
  show(diff: FileDiff | null): void;
}

export function buildDiffCard(onDismiss: () => void): DiffCard {
  const name = h("span");
  const add = h("span", { class: "add" });
  const del = h("span", { class: "del" });
  const open = h("button", { class: "icon-btn", title: "Open the file" }, svg(ICONS.arrowUpRight, 8));
  const back = h("button", { class: "dc-back", onclick: onDismiss }, svg(ICONS.chevronRight, 9, { stroke: 2.4 }), name);
  (back.firstChild as SVGElement).style.transform = "scaleX(-1)";
  const lines = h("div", { class: "dc-lines" });
  const el = h(
    "div",
    { class: "diffcard" },
    h("div", { class: "dc-head" }, back, h("span", { class: "diff-counts" }, add, del), open),
    lines,
  );

  let shown: FileDiff | null = null;
  open.addEventListener("click", () => {
    if (shown) void Bridge.openChangedFile(shown.path);
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && shown) {
      e.stopImmediatePropagation();
      onDismiss();
    }
  }, true);

  return {
    el,
    show(diff) {
      if (diff === shown) return;
      shown = diff;
      el.classList.toggle("on", !!diff);
      lines.replaceChildren();
      if (!diff) return;
      name.textContent = diffName(diff);
      add.textContent = diff.added > 0 ? `+${diff.added}` : "";
      del.textContent = diff.removed > 0 ? `−${diff.removed}` : "";
      const all = diff.hunks.flatMap((hk) => hk.lines);
      if (diff.tooLarge) {
        lines.append(h("div", { class: "dc-note", text: "Diff too large" }));
      } else if (!all.length) {
        lines.append(h("div", { class: "dc-note", text: "No changes" }));
      } else {
        const frag = document.createDocumentFragment();
        for (const l of all) {
          frag.append(
            h("div", { class: `dl ${l.kind === "added" ? "add" : l.kind === "removed" ? "del" : ""}` },
              h("i", { text: l.kind === "added" ? "+" : l.kind === "removed" ? "−" : " " }),
              h("span", { text: l.text })),
          );
        }
        lines.append(frag);
      }
    },
  };
}
