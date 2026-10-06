// Integration cards shown in the overview's left card — DOM ports of
// IntegrationCardView and friends from IslandViewContent.swift.
//
// Cal.com is the one simplification: macOS shows a three-level calendar
// (month → day → booking); here it is the list of upcoming bookings.

import { h, svg, clear, dot } from "./dom";
import { ICONS } from "./icons";
import { State, type AgentTask } from "../core/state";
import { Bridge } from "../core/bridge";
import {
  CI_COLOR, contributionColor, dayLabel, lastDays, lastWeeks, worstCI,
  type GitHubActivity, type GitHubPR, type GitHubRepoCI, type GitHubSection,
} from "../core/github";

/** Same shape as the Swift `timeAgo` computed properties. */
export function timeAgo(value: unknown): string {
  const date = typeof value === "number" ? new Date(value) : new Date(String(value));
  const diff = (Date.now() - date.getTime()) / 1000;
  if (!Number.isFinite(diff)) return "";
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

function header(color: string, name: string, kind: string, extra?: Node): HTMLElement {
  const row = h("div", { class: "int-head" }, dot(color, 7), h("b", { text: name }), h("span", { text: kind }));
  if (extra) row.append(extra);
  return row;
}

/** Highlighted first row + plain rows, the layout every list card shares. */
function listRow(accent: string, first: boolean, ...children: Node[]): HTMLElement {
  const row = h("div", { class: first ? "int-row first" : "int-row" }, dot(accent, 5), ...children);
  if (first) row.style.background = `${accent}14`;
  return row;
}

function get(id: string): Record<string, unknown> {
  return (State.integrations[id]?.data ?? {}) as Record<string, unknown>;
}

function arr(id: string, key: string): Record<string, unknown>[] {
  const v = get(id)[key];
  return Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
}

// ── Not configured / idle ─────────────────────────────────────────────────────

const OPEN_URLS: Record<string, string> = {
  integration_resend: "https://resend.com/emails",
  integration_vercel: "https://vercel.com/dashboard",
  integration_github: "https://github.com",
  integration_stripe: "https://dashboard.stripe.com/payments",
  integration_notion: "https://notion.so",
  integration_calcom: "https://app.cal.com/bookings",
};

function idleCard(task: AgentTask, openSettings: () => void): HTMLElement {
  const info = State.integrations[task.id];
  const configured = info?.configured ?? false;
  const error = info?.error ?? null;
  // The Claude Code pill is about hooks, not a key — the macOS wording would be
  // misleading here.
  const missing = task.id === "integration_claude" ? "Hooks not installed" : "Key not configured";
  const label = error ?? (configured ? "Connected · loading…" : missing);
  const statusColor = error || !configured ? "#F4505E" : "#22C55E";

  const actions = h("div", { class: "int-actions" });
  if (task.id === "integration_claude") {
    actions.append(
      h("button", {
        class: "link-btn",
        style: `color:${task.color}b3`,
        text: "Open Visual Studio Code",
        onclick: () => void Bridge.openInVSCode(task.sessionCwd ?? null),
      }),
    );
  } else if (task.id === "integration_n8n") {
    actions.append(
      h("button", {
        class: "link-btn",
        style: `color:${task.color}d9`,
        text: "Open n8n",
        onclick: () => void Bridge.openN8n(),
      }),
    );
  } else if (OPEN_URLS[task.id]) {
    actions.append(
      h("button", {
        class: "link-btn",
        style: `color:${task.color}d9`,
        text: `Open ${task.name}`,
        onclick: () => void Bridge.openUrl(OPEN_URLS[task.id]),
      }),
    );
  }
  if (configured) {
    actions.append(
      h("button", {
        class: "link-btn",
        style: `color:${task.color}d9`,
        text: "Refresh",
        onclick: () => void Bridge.refreshIntegration(task.id),
      }),
    );
  } else {
    actions.append(
      h("button", { class: "link-btn", style: "color:#8e939c", text: "Settings…", onclick: openSettings }),
    );
  }

  return h(
    "div",
    { class: "int-card" },
    header(task.color, task.id === "integration_claude" ? "VS Code" : task.name, "Integration"),
    h("div", { class: "int-status" }, dot(statusColor, 5), h("span", { text: label })),
    actions,
  );
}

// ── Vercel ────────────────────────────────────────────────────────────────────

function vercelCard(onDetail: () => void): HTMLElement {
  const deployments = arr("integration_vercel", "deployments");
  const rows = h("div", { class: "int-rows" });
  deployments.slice(0, 3).forEach((d, i) => {
    const accent = d.state === "READY" ? "#22C55E" : "#F4505E";
    const name = h("span", { class: "int-name", text: String(d.projectName ?? "") });
    const ago = h("span", { class: "int-ago", text: timeAgo(d.createdAt) });
    if (i === 0) {
      const more = h(
        "button",
        { class: "int-more", title: "Details", onclick: onDetail },
        svg(ICONS.ellipsis, 8),
      );
      rows.append(listRow(accent, true, name, ago, more));
    } else {
      rows.append(listRow(accent, false, name, ago));
    }
  });
  return h("div", { class: "int-card" }, header("#7C5CFF", "Vercel", "Deployments"), rows);
}

function vercelDetail(onBack: () => void): HTMLElement {
  const d = arr("integration_vercel", "deployments")[0] ?? {};
  const success = d.state === "READY";
  const accent = success ? "#22C55E" : "#F4505E";
  const status = success ? "Ready" : d.state === "CANCELED" ? "Canceled" : "Error";
  const body = h("div", { class: "int-detail-body" });
  if (d.commitMessage) body.append(h("div", { class: "int-commit", text: String(d.commitMessage) }));
  const meta = h("div", { class: "int-meta" });
  if (d.branch) meta.append(h("span", { text: String(d.branch) }));
  meta.append(h("span", { text: `${timeAgo(d.createdAt)} ago` }));
  body.append(meta);
  if (d.url) {
    body.append(
      h("button", {
        class: "int-link",
        text: String(d.url),
        onclick: () => void Bridge.openUrl(`https://${d.url}`),
      }),
    );
  }
  return h(
    "div",
    { class: "int-card detail" },
    h(
      "div",
      { class: "int-detail-head" },
      h("button", { class: "int-back", onclick: onBack }, svg(ICONS.chevronLeft, 10, { stroke: 2.4 })),
      dot(accent, 6),
      h("b", { text: String(d.projectName ?? "Deployment") }),
      h("span", { class: "int-badge", style: `color:${accent};background:${accent}24`, text: status }),
    ),
    body,
  );
}

// ── Resend ────────────────────────────────────────────────────────────────────

function resendCard(): HTMLElement {
  const emails = arr("integration_resend", "emails");
  const total = get("integration_resend").total;
  const extra =
    total != null
      ? h("span", { class: "int-total" }, h("i", { class: "pulse" }), h("span", { text: String(total) }))
      : undefined;
  const rows = h("div", { class: "int-rows" });
  emails.slice(0, 3).forEach((e, i) => {
    const delivered = e.lastEvent === "delivered";
    const accent = delivered ? "#22C55E" : "#F4505E";
    const to = Array.isArray(e.to) ? String(e.to[0] ?? "?") : "?";
    const short = to.split("@")[0];
    const cells: Node[] = [
      h("span", { class: "int-name", text: short }),
      h("span", { class: "int-ago", text: timeAgo(e.createdAt) }),
    ];
    if (i === 0 && e.subject) cells.push(h("span", { class: "int-sub", text: String(e.subject) }));
    rows.append(listRow(accent, i === 0, ...cells));
  });
  return h("div", { class: "int-card" }, header("#22C55E", "Resend", "Emails", extra), rows);
}

// ── GitHub ────────────────────────────────────────────────────────────────────

function statRow(icon: string, color: string, label: string, value: string): HTMLElement {
  return h(
    "div",
    { class: "int-stat" },
    h("i", { class: "int-stat-icon", style: `color:${color}` }, svg(icon, 10)),
    h("span", { class: "int-stat-label", text: label }),
    h("span", { class: "int-stat-value", text: value }),
  );
}

/** The part of the GitHub card that can change without the integration data changing. */
export function githubKey(): string {
  return `${State.githubPulse?.fetchedAt ?? 0}|${State.githubActivity?.fetchedAt ?? 0}|${ghSection}`;
}

/** Which list the GitHub detail shows; set before opening it. */
let ghSection: GitHubSection = "myPRs";
export function openGitHubSection(section: GitHubSection) {
  ghSection = section;
}

function ghOpen(url: string) {
  try {
    if (new URL(url).hostname === "github.com") void Bridge.openUrl(url);
  } catch { /* not a URL: nothing to open */ }
}

function githubStatButton(icon: string, color: string, label: string, value: string, onTap: () => void): HTMLElement {
  const row = statRow(icon, color, label, value);
  row.classList.add("tap");
  row.addEventListener("click", onTap);
  return row;
}

/** Stars and the last seven days of contributions: opens the activity. */
function githubHeaderExtra(onTap: () => void): HTMLElement {
  const stats = get("integration_github");
  const act = State.githubActivity;
  const box = h("button", { class: "gh-mini", title: "Activity", onclick: onTap });
  if (stats.totalStars != null) box.append(h("span", { text: `\u2605 ${fmtCount(Number(stats.totalStars))}` }));
  if (act) {
    const row = h("span", { class: "gh-days" });
    for (const d of lastDays(act, 7)) {
      const sq = h("i");
      sq.style.background = contributionColor(d.level);
      row.append(sq);
    }
    box.append(row);
  } else if (stats.totalStars == null) {
    box.append(h("span", { text: "Overview" }));
  }
  return box;
}

const fmtCount = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** The GitHub card once the pulse has arrived: pull requests, reviews, the default branch's CI. */
function githubPulseCard(onSection: (s: GitHubSection) => void): HTMLElement {
  const pulse = State.githubPulse!;
  const prs = pulse.myPRs;
  const failing = prs.filter((p) => p.ci === "failure").length;
  const running = prs.filter((p) => p.ci === "pending").length;
  const prValue = !prs.length ? "0" : failing ? `${prs.length} \u00b7 ${failing} failing` : running ? `${prs.length} \u00b7 running` : String(prs.length);

  const main = worstCI(pulse.mainCI);
  const mainFailing = pulse.mainCI.filter((r) => r.ci === "failure").length;
  const [mainIcon, mainValue] =
    main === "failure" ? [ICONS.sealFail, `${mainFailing} failing`]
    : main === "pending" ? [ICONS.seal, "running"]
    : main === "success" ? [ICONS.seal, "all green"]
    : [ICONS.seal, pulse.mainCI.length ? "unknown" : "no repos"];

  const stats = h(
    "div",
    { class: "int-stats" },
    githubStatButton(ICONS.pullRequest, CI_COLOR[worstCI(prs)], "My PRs", prValue, () => onSection("myPRs")),
    githubStatButton(ICONS.eye, pulse.toReview.length ? "#8AB4F8" : "#6B7079", "To review", String(pulse.toReview.length), () => onSection("toReview")),
    githubStatButton(mainIcon, CI_COLOR[main], "Default branch CI", mainValue, () => onSection("mainCI")),
  );
  for (const icon of stats.querySelectorAll(".int-stat-icon svg")) {
    // These are line icons.
    (icon as SVGElement).querySelector("path")?.setAttribute("fill", "none");
    (icon as SVGElement).querySelector("path")?.setAttribute("stroke", "currentColor");
    (icon as SVGElement).querySelector("path")?.setAttribute("stroke-width", "1.8");
    (icon as SVGElement).querySelector("path")?.setAttribute("stroke-linecap", "round");
    (icon as SVGElement).querySelector("path")?.setAttribute("stroke-linejoin", "round");
  }
  return h(
    "div",
    { class: "int-card" },
    header("#F4505E", "GitHub", "", githubHeaderExtra(() => onSection("activity"))),
    stats,
  );
}

function ghPRRow(pr: GitHubPR, showCI: boolean): HTMLElement {
  const dotEl = h("i", { class: "gh-dot" });
  dotEl.style.background = showCI && pr.ci !== "unknown" ? CI_COLOR[pr.ci] : "transparent";
  return h(
    "button",
    { class: "gh-row", title: pr.title, onclick: () => ghOpen(pr.url) },
    dotEl,
    h("span", { class: "gh-ref", text: `${pr.repo.split("/").pop() ?? pr.repo}#${pr.number}` }),
    h("span", { class: "gh-title", text: pr.title }),
    pr.isDraft ? h("span", { class: "gh-draft", text: "Draft" }) : null,
  );
}

function ghRepoRow(repo: GitHubRepoCI): HTMLElement {
  const word = { failure: "failing", pending: "running", success: "passing", unknown: "" }[repo.ci];
  const dotEl = h("i", { class: "gh-dot" });
  dotEl.style.background = repo.ci === "unknown" ? "transparent" : CI_COLOR[repo.ci];
  const word_ = h("span", { class: "gh-word", text: word });
  word_.style.color = CI_COLOR[repo.ci];
  return h(
    "button",
    {
      class: "gh-row",
      title: `${repo.repo} · ${repo.branch}`,
      onclick: () => ghOpen(repo.url.endsWith("/") ? `${repo.url}actions` : `${repo.url}/actions`),
    },
    dotEl,
    h("span", { class: "gh-ref", text: repo.repo.split("/").pop() ?? repo.repo }),
    h("span", { class: "gh-title", text: repo.branch }),
    word_,
  );
}

function ghActivityDetail(act: GitHubActivity | null, onBack: () => void): HTMLElement {
  const stats = get("integration_github");
  const right = h("button", { class: "gh-right" });
  const grid = h("div", { class: "gh-grid" });
  const setRight = (text: string) => { right.textContent = text; };
  const login = State.githubPulse?.login;
  right.addEventListener("click", () => { if (login) ghOpen(`https://github.com/${login}`); });

  const summary = () => {
    if (!act) return "";
    const total = act.total.toLocaleString("en-US");
    return stats.totalRepos != null ? `${total} past year \u00b7 ${stats.totalRepos} repos` : `${total} past year`;
  };
  setRight(summary());

  if (act) {
    for (const week of lastWeeks(act, 23)) {
      const col = h("div", { class: "gh-week" });
      for (let dow = 0; dow < 7; dow++) {
        const day = week.find((d) => d.weekday === dow);
        const sq = h("i");
        if (day) {
          sq.style.background = contributionColor(day.level);
          const label = `${dayLabel(day.date)} \u00b7 ${day.count === 0 ? "No contributions" : day.count === 1 ? "1 contribution" : `${day.count} contributions`}`;
          sq.addEventListener("mouseenter", () => setRight(label));
          sq.addEventListener("mouseleave", () => setRight(summary()));
          sq.addEventListener("click", () => setRight(label));
        } else sq.style.visibility = "hidden";
        col.append(sq);
      }
      grid.append(col);
    }
  } else {
    grid.append(h("div", { class: "int-status", text: "Loading\u2026" }));
  }
  return h(
    "div",
    { class: "int-card detail" },
    h("div", { class: "int-detail-head" },
      h("button", { class: "int-back", onclick: onBack }, svg(ICONS.chevronLeft, 10, { stroke: 2.4 })),
      h("b", { class: "keep", text: "Activity" }),
      act ? right : null),
    grid,
  );
}

function githubDetail(onBack: () => void): HTMLElement {
  const pulse = State.githubPulse!;
  if (ghSection === "activity") return ghActivityDetail(State.githubActivity, onBack);
  const title = { myPRs: "My PRs", toReview: "To review", mainCI: "Default branch CI", activity: "Activity" }[ghSection];
  const rows = h("div", { class: "gh-list" });
  const items = ghSection === "myPRs" ? pulse.myPRs : ghSection === "toReview" ? pulse.toReview : [];
  const repos = ghSection === "mainCI" ? pulse.mainCI : [];
  for (const pr of items) rows.append(ghPRRow(pr, ghSection === "myPRs"));
  for (const r of repos) rows.append(ghRepoRow(r));
  if (!items.length && !repos.length) rows.append(h("div", { class: "int-status", text: "Nothing here" }));
  return h(
    "div",
    { class: "int-card detail" },
    h("div", { class: "int-detail-head" },
      h("button", { class: "int-back", onclick: onBack }, svg(ICONS.chevronLeft, 10, { stroke: 2.4 })),
      h("b", { text: title })),
    rows,
  );
}

function githubCard(): HTMLElement {
  const d = get("integration_github");
  const stars = Number(d.totalStars ?? 0);
  const repos = Number(d.totalRepos ?? 0);
  const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  return h(
    "div",
    { class: "int-card" },
    header("#F4505E", "GitHub", "Overview"),
    h(
      "div",
      { class: "int-stats" },
      statRow(ICONS.star, "#F5A524", "Total stars", fmt(stars)),
      statRow(ICONS.stack, "#6B7079", "Repositories", String(repos)),
    ),
  );
}

// ── Stripe ────────────────────────────────────────────────────────────────────

function stripeCard(): HTMLElement {
  const d = get("integration_stripe");
  const balance = (Number(d.balance ?? 0) / 100).toFixed(2);
  const currency = String(d.currency ?? "eur").toUpperCase();
  const rows = h("div", { class: "int-rows tight" });
  for (const p of arr("integration_stripe", "payments")) {
    const success = p.status === "succeeded";
    const accent = success ? "#22C55E" : "#F4505E";
    rows.append(
      h(
        "div",
        { class: "int-row" },
        dot(accent, 5),
        h("span", { class: "int-name", text: String(p.description ?? "Payment") }),
        h("span", {
          class: "int-amount",
          style: "color:#22c55e",
          text: `+${(Number(p.amount ?? 0) / 100).toFixed(2)}`,
        }),
        h("span", { class: "int-ago", text: timeAgo(p.createdAt) }),
      ),
    );
  }
  return h(
    "div",
    { class: "int-card" },
    header("#0570DE", "Stripe", "Payments"),
    h("div", { class: "int-balance" }, h("span", { text: balance }), h("i", { text: currency })),
    rows,
  );
}

// ── Notion ────────────────────────────────────────────────────────────────────

function notionCard(): HTMLElement {
  const rows = h("div", { class: "int-rows tight" });
  for (const p of arr("integration_notion", "pages").slice(0, 3)) {
    rows.append(
      h(
        "button",
        {
          class: "int-page",
          onclick: () => {
            if (typeof p.url === "string") void Bridge.openUrl(p.url);
          },
        },
        p.emoji
          ? h("span", { class: "int-emoji", text: String(p.emoji) })
          : h("i", { class: "int-emoji" }, svg(ICONS.doc, 9)),
        h("span", { class: "int-name", text: String(p.title ?? "Untitled") }),
        h("span", { class: "int-ago", text: timeAgo(p.lastEditedAt) }),
      ),
    );
  }
  return h("div", { class: "int-card" }, header("#E8E8E8", "Notion", "Recent"), rows);
}

// ── Cal.com ───────────────────────────────────────────────────────────────────

function calcomCard(): HTMLElement {
  const bookings = arr("integration_calcom", "bookings")
    .slice()
    .sort((a, b) => new Date(String(a.start)).getTime() - new Date(String(b.start)).getTime());
  const rows = h("div", { class: "int-rows tight" });
  if (bookings.length === 0) {
    rows.append(h("div", { class: "int-empty", text: "No calls scheduled" }));
  }
  for (const b of bookings.slice(0, 3)) {
    const when = new Date(String(b.start));
    const day = when.toLocaleDateString(undefined, { day: "2-digit", month: "2-digit" });
    const time = when.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    rows.append(
      h(
        "div",
        { class: "int-row" },
        dot("#C9956A", 4),
        h("span", { class: "int-time", text: `${day} ${time}` }),
        h("span", { class: "int-name", text: String(b.title ?? "Meeting") }),
      ),
    );
  }
  return h("div", { class: "int-card" }, header("#C9956A", "Cal.com", "Schedule"), rows);
}

// ── n8n ───────────────────────────────────────────────────────────────────────

function n8nCard(task: AgentTask, onDetail: () => void, openSettings: () => void): HTMLElement {
  const hasActivity = task.steps.length > 0 && (task.state === "finished" || task.state === "error");
  if (!hasActivity) return idleCard(task, openSettings);
  const success = task.state === "finished";
  const accent = success ? "#22C55E" : "#F4505E";
  return h(
    "div",
    { class: "int-card" },
    header("#F29B38", "n8n", "Workflow"),
    h(
      "div",
      { class: "int-actions" },
      h(
        "button",
        {
          class: "int-pill",
          style: `background:${accent}1a;border-color:${accent}38`,
          onclick: onDetail,
        },
        dot(accent, 5),
        h("span", { class: "int-name", text: task.steps[0] ?? "Workflow" }),
        svg(ICONS.ellipsis, 8),
      ),
    ),
  );
}

function n8nDetail(task: AgentTask, onBack: () => void): HTMLElement {
  const success = task.state === "finished";
  const accent = success ? "#22C55E" : "#F4505E";
  const detail = task.steps[1];
  return h(
    "div",
    { class: "int-card detail" },
    h(
      "div",
      { class: "int-detail-head" },
      h("button", { class: "int-back", onclick: onBack }, svg(ICONS.chevronLeft, 10, { stroke: 2.4 })),
      dot(accent, 6),
      h("b", { text: task.steps[0] ?? "Workflow" }),
      h("span", {
        class: "int-badge",
        style: `color:${accent};background:${accent}24`,
        text: success ? "Success" : "Failed",
      }),
    ),
    detail
      ? h("pre", { class: "int-detail-text", text: detail })
      : h("div", {
          class: "int-status",
          text: success ? "Completed successfully." : "No error details available.",
        }),
  );
}

// ── Dispatch ──────────────────────────────────────────────────────────────────

export interface IntegrationCardHooks {
  detailOpen: boolean;
  openDetail(): void;
  closeDetail(): void;
  openSettings(): void;
}

/** True when this integration has data worth showing instead of the idle card. */
export function hasIntegrationData(id: string): boolean {
  const info = State.integrations[id];
  if (!info || info.error) return false;
  switch (id) {
    case "integration_vercel":
      return arr(id, "deployments").length > 0;
    case "integration_resend":
      return arr(id, "emails").length > 0;
    case "integration_github":
      return get(id).totalRepos != null || State.githubPulse != null;
    case "integration_stripe":
      return info.loaded;
    case "integration_notion":
      return arr(id, "pages").length > 0;
    case "integration_calcom":
      return info.loaded;
    default:
      return false;
  }
}

export function renderIntegrationCard(task: AgentTask, hooks: IntegrationCardHooks): HTMLElement {
  if (task.id === "integration_n8n") {
    const hasActivity = task.steps.length > 0 && (task.state === "finished" || task.state === "error");
    return hooks.detailOpen && hasActivity
      ? n8nDetail(task, hooks.closeDetail)
      : n8nCard(task, hooks.openDetail, hooks.openSettings);
  }
  if (task.id === "integration_vercel" && hasIntegrationData(task.id)) {
    return hooks.detailOpen ? vercelDetail(hooks.closeDetail) : vercelCard(hooks.openDetail);
  }
  if (task.id === "integration_github" && State.githubPulse && hasIntegrationData(task.id)) {
    return hooks.detailOpen
      ? githubDetail(hooks.closeDetail)
      : githubPulseCard((section) => { ghSection = section; hooks.openDetail(); });
  }
  if (!hasIntegrationData(task.id)) return idleCard(task, hooks.openSettings);

  switch (task.id) {
    case "integration_resend":
      return resendCard();
    case "integration_github":
      return githubCard();
    case "integration_stripe":
      return stripeCard();
    case "integration_notion":
      return notionCard();
    case "integration_calcom":
      return calcomCard();
    default:
      return idleCard(task, hooks.openSettings);
  }
}

export { clear };
