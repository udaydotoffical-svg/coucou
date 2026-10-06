// GitHub pulse and activity: what src-tauri/src/github.rs sends, and the alerts that come
// from comparing one pulse with the next (GitHubPulse.events / AppState.handleGitHubEvents).

export type CIState = "pending" | "success" | "failure" | "unknown";

export interface GitHubPR {
  /** "owner/repo#number" */
  id: string;
  title: string;
  url: string;
  repo: string;
  number: number;
  isDraft: boolean;
  ci: CIState;
  review: "approved" | "changesRequested" | "pending" | "unknown";
  headSha: string | null;
}

export interface GitHubRepoCI {
  repo: string;
  url: string;
  branch: string;
  ci: CIState;
  headSha: string | null;
}

export interface GitHubPulse {
  login: string;
  myPRs: GitHubPR[];
  toReview: GitHubPR[];
  mainCI: GitHubRepoCI[];
  hasPending: boolean;
  fetchedAt: number;
}

export interface ContributionDay {
  /** YYYY-MM-DD */
  date: string;
  count: number;
  /** 0 (none) to 4 */
  level: number;
  /** 0 = Sunday … 6 = Saturday */
  weekday: number;
}

export interface GitHubActivity {
  total: number;
  weeks: ContributionDay[][];
  fetchedAt: number;
}

export type GitHubSection = "myPRs" | "toReview" | "mainCI" | "activity";

export type GitHubEvent =
  | { kind: "ciFailed"; id: string }
  | { kind: "ciPassed"; id: string }
  | { kind: "mainFailed"; repo: string }
  | { kind: "reviewRequested"; id: string };

/**
 * What changed between two pulses. Nothing on the first one (no alerts for what was already
 * there when Coucou started). A new commit whose check is already over alerts at once, so a fast
 * CI is not missed between two polls; one still running waits for the poll that sees its result.
 * The default branch only ever alerts on a failure.
 */
export function githubEvents(old: GitHubPulse | null, now: GitHubPulse): GitHubEvent[] {
  if (!old) return [];
  const out: GitHubEvent[] = [];

  const oldPR = new Map(old.myPRs.map((p) => [p.id, p]));
  for (const pr of now.myPRs) {
    const prev = oldPR.get(pr.id);
    if (prev && prev.headSha === pr.headSha) {
      if (pr.ci === "failure" && prev.ci !== "failure") out.push({ kind: "ciFailed", id: pr.id });
      else if (pr.ci === "success" && prev.ci === "pending") out.push({ kind: "ciPassed", id: pr.id });
    } else if (pr.ci === "success") out.push({ kind: "ciPassed", id: pr.id });
    else if (pr.ci === "failure") out.push({ kind: "ciFailed", id: pr.id });
  }

  const oldRepo = new Map(old.mainCI.map((r) => [r.repo, r]));
  for (const repo of now.mainCI) {
    const prev = oldRepo.get(repo.repo);
    if (prev && prev.headSha === repo.headSha) {
      if (repo.ci === "failure" && prev.ci !== "failure") out.push({ kind: "mainFailed", repo: repo.repo });
    } else if (repo.ci === "failure") out.push({ kind: "mainFailed", repo: repo.repo });
  }

  const oldReview = new Set(old.toReview.map((p) => p.id));
  for (const pr of now.toReview) if (!oldReview.has(pr.id)) out.push({ kind: "reviewRequested", id: pr.id });
  return out;
}

/** What the pill should show and play: error beats a review request, which beats a green CI. */
export function githubAlert(events: GitHubEvent[]): { badge: "finished" | "error"; sound: "error" | "question" | "finish" } | null {
  let level = 0;
  let badge: "finished" | "error" = "finished";
  let sound: "error" | "question" | "finish" = "finish";
  for (const e of events) {
    if ((e.kind === "ciFailed" || e.kind === "mainFailed") && level < 3) { level = 3; badge = "error"; sound = "error"; }
    else if (e.kind === "reviewRequested" && level < 2) { level = 2; badge = "finished"; sound = "question"; }
    else if (e.kind === "ciPassed" && level < 1) { level = 1; badge = "finished"; sound = "finish"; }
  }
  return level ? { badge, sound } : null;
}

export function worstCI(items: { ci: CIState }[]): CIState {
  if (items.some((i) => i.ci === "failure")) return "failure";
  if (items.some((i) => i.ci === "pending")) return "pending";
  if (items.some((i) => i.ci === "success")) return "success";
  return "unknown";
}

export const CI_COLOR: Record<CIState, string> = {
  failure: "#F4505E",
  pending: "#F5A524",
  success: "#22C55E",
  unknown: "#6B7079",
};

/** The squares of the contribution calendar, from nothing to a lot. */
export function contributionColor(level: number): string {
  switch (level) {
    case 1: return "#0E4429";
    case 2: return "#006D32";
    case 3: return "#26A641";
    case 4: return "#39D353";
    default: return "rgba(255,255,255,0.06)";
  }
}

export function lastDays(a: GitHubActivity, n: number): ContributionDay[] {
  const all = a.weeks.flat();
  return all.slice(Math.max(0, all.length - n));
}

export function lastWeeks(a: GitHubActivity, n: number): ContributionDay[][] {
  return a.weeks.slice(Math.max(0, a.weeks.length - n));
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-10-05" → "Oct 5". */
export function dayLabel(date: string): string {
  const [, m, d] = date.split("-").map(Number);
  return m >= 1 && m <= 12 ? `${MONTHS[m - 1]} ${d}` : date;
}
