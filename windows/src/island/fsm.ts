// Island open/close FSM — port of IslandStateMachine.swift.
// No DOM, no Tauri: it only reports transitions.

export type FsmState = "hidden" | "petit" | "home" | "coucou";

export class IslandStateMachine {
  state: FsmState = "hidden";

  onTransition: ((from: FsmState, to: FsmState) => void) | null = null;

  /** home → petit delay, seconds. */
  homeToPetitDelay = 15;
  /** petit → hidden delay, seconds. */
  petitToHiddenDelay = 60;
  /** coucou → petit once the greeting animation ends (no hover). */
  greetAutoCollapseDelay = 0.6;
  /** coucou → petit while the mouse hovers the greeting. */
  greetHoverCollapseDelay = 10;
  /** An alert waiting for an answer stays open, even when the mouse leaves. */
  pinned = false;
  /** Off: the island never closes (open → compact) or hides (compact → hidden) on its own. */
  autoHide = true;
  /** While Knowura is open the notch ignores the pointer completely: no peeking, no opening, no auto-close. */
  locked = false;
  /** On: resting the pointer on the island opens it, and leaving closes it again. */
  openOnHover = false;
  /** Seconds the pointer may be away before a hover-opened island closes. */
  hoverCloseDelay = 0.35;
  /** True while something should keep the closed island on screen (music playing). */
  holdVisible: () => boolean = () => false;
  /** Lets the owner keep the island open while the pointer is away (typing in the chat…). */
  hoverCloseGuard: () => boolean = () => true;

  private petitHide: number | null = null;
  private homeCollapse: number | null = null;
  private greetCollapse: number | null = null;

  // ── Inputs ──────────────────────────────────────────────────────────────────

  launch() {
    this.cancelTimers();
    this.transition("coucou");
  }

  mouseEntered() {
    if (this.locked) return;
    switch (this.state) {
      case "hidden":
        this.cancelTimers();
        this.transition("petit");
        break;
      case "petit":
        this.clear("petitHide");
        if (this.openOnHover) {
          this.cancelTimers();
          this.transition("home");
        }
        break;
      case "home":
        this.clear("homeCollapse");
        break;
      case "coucou":
        this.scheduleGreetCollapse(this.greetHoverCollapseDelay);
        break;
    }
  }

  /** `real` is false when the owner reports a leave the pointer did not make (an alert opened it elsewhere). */
  mouseLeft(real = true) {
    if (this.locked) return;
    switch (this.state) {
      case "hidden":
        break;
      case "petit":
        this.schedulePetitHide();
        break;
      case "home":
        if (real && this.openOnHover && !this.pinned && this.hoverCloseGuard()) this.scheduleHoverClose();
        else this.scheduleHomeCollapse();
        break;
      case "coucou":
        this.clear("greetCollapse");
        this.transition("petit");
        break;
    }
  }

  click() {
    if (this.locked || this.state !== "petit") return;
    this.cancelTimers();
    this.transition("home");
  }

  /** Greeting animation finished (T.end). Doesn't override a running hover timer. */
  greetComplete() {
    if (this.state !== "coucou") return;
    if (this.greetCollapse == null) this.scheduleGreetCollapse(this.greetAutoCollapseDelay);
  }

  /** Non-alert work event: show compact from hidden. */
  reveal() {
    if (this.state !== "hidden") return;
    this.cancelTimers();
    this.transition("petit");
    this.schedulePetitHide();
  }

  /** Alert or explicit request: open straight to expanded. */
  forceHome() {
    this.cancelTimers();
    this.transition("home");
  }

  /// Explicit close (OK button, Escape, an alert being answered).
  forcePetit() {
    this.cancelTimers();
    this.transition("petit");
  }

  forceHidden() {
    this.cancelTimers();
    this.transition("hidden");
  }

  // ── Timers ──────────────────────────────────────────────────────────────────

  setAutoHide(on: boolean) {
    this.autoHide = on;
    if (!on) {
      this.clear("petitHide");
      this.clear("homeCollapse");
    }
  }

  private schedulePetitHide() {
    this.clear("petitHide");
    if (!this.autoHide || this.locked || this.holdVisible()) return;
    this.petitHide = window.setTimeout(() => {
      this.petitHide = null;
      if (this.state === "petit") this.transition("hidden");
    }, this.petitToHiddenDelay * 1000);
  }

  private scheduleHoverClose() {
    this.clear("homeCollapse");
    this.homeCollapse = window.setTimeout(() => {
      this.homeCollapse = null;
      if (this.state === "home") this.transition("petit");
    }, this.hoverCloseDelay * 1000);
  }

  private scheduleHomeCollapse() {
    this.clear("homeCollapse");
    if (this.pinned || !this.autoHide || this.locked) return;
    this.homeCollapse = window.setTimeout(() => {
      this.homeCollapse = null;
      if (this.state === "home") this.transition("petit");
    }, this.homeToPetitDelay * 1000);
  }

  private scheduleGreetCollapse(delay: number) {
    this.clear("greetCollapse");
    this.greetCollapse = window.setTimeout(() => {
      this.greetCollapse = null;
      if (this.state === "coucou") this.transition("petit");
    }, delay * 1000);
  }

  private clear(which: "petitHide" | "homeCollapse" | "greetCollapse") {
    const id = this[which];
    if (id != null) window.clearTimeout(id);
    this[which] = null;
  }

  cancelTimers() {
    this.clear("petitHide");
    this.clear("homeCollapse");
    this.clear("greetCollapse");
  }

  private transition(next: FsmState) {
    if (next === this.state) return;
    const from = this.state;
    this.state = next;
    this.onTransition?.(from, next);
  }
}
