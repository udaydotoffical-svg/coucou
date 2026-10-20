// "Mochi, do something on my PC": the island stretches into a wide pill with a text field, the
// way the Dynamic Island grows for a call. Enter hands the task to src-tauri/src/computer.rs and
// the island folds back while Mochi's blue pointer takes over; Esc or a click elsewhere cancels.

import { invoke } from "@tauri-apps/api/core";
import { IS_TAURI } from "../core/bridge";
import { State } from "../core/state";
import { h } from "./dom";
import type { ViewActions, ViewHost } from "./views";

export function buildAgent(actions: ViewActions): ViewHost {
  const input = h("input", {
    class: "agent-input",
    type: "text",
    placeholder: "What should I do on your PC?",
    autocomplete: "off",
    spellcheck: "false",
    maxlength: "1000",
  }) as HTMLInputElement;
  const hint = h("div", { class: "agent-hint", text: "Enter to start · Esc to cancel" });
  const el = h("div", { class: "view agent-view" }, h("div", { class: "agent-field" }, input, hint));

  let busy = false;
  const showError = (text: string) => {
    hint.textContent = text;
    hint.classList.add("err");
    // A little shake, like a wrong passcode.
    el.classList.remove("shake");
    void el.offsetWidth;
    el.classList.add("shake");
  };

  const start = async () => {
    const task = input.value.trim();
    if (!task || busy) return;
    busy = true;
    try {
      if (IS_TAURI) await invoke("computer_start", { task });
      input.value = "";
      actions.collapse();
    } catch (e) {
      showError(String(e));
    } finally {
      busy = false;
    }
  };

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void start();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      actions.collapse();
    }
  });
  input.addEventListener("input", () => {
    if (hint.classList.contains("err")) {
      hint.classList.remove("err");
      hint.textContent = "Enter to start · Esc to cancel";
    }
  });

  return {
    el,
    sync() {
      el.classList.toggle("off", !State.settings.computerUse);
      if (!State.settings.computerUse && !hint.classList.contains("err")) {
        hint.textContent = "Turn on \"Let Mochi use my PC\" in Settings first";
      }
    },
    focus() {
      input.focus();
      input.select();
    },
  };
}
