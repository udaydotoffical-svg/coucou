// Live diff: the file changes Claude makes, turned into lines the island can show.
// A port of CoucouKit/DiffEngine.swift (same limits, same hunks, same ticker step encoding).

export interface DiffLine {
  kind: "context" | "added" | "removed";
  text: string;
  /** 1-based; -1 for pure adds. */
  origLine: number;
  /** 1-based; -1 for pure removes. */
  newLine: number;
}

export interface DiffHunk { origStart: number; newStart: number; lines: DiffLine[] }

export interface FileDiff {
  /** Stable identifier, assigned by State.appendSessionDiff. */
  id: number;
  path: string;
  added: number;
  removed: number;
  hunks: DiffHunk[];
  tooLarge: boolean;
  /** True when it came from a Write (the whole file is new). */
  isNewFile: boolean;
}

export const DIFF_MAX_BYTES = 200 * 1024;
export const DIFF_MAX_LINES = 4000;

export function diffName(d: { path: string }): string {
  return d.path.split(/[\\/]/).pop() || d.path;
}

const byteLen = (s: string) => new TextEncoder().encode(s).length;

function splitLines(text: string): string[] {
  const parts = text.replace(/\r\n/g, "\n").split("\n");
  if (parts.length && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

function countFallback(old: string, now: string, path: string, tooLarge: boolean): FileDiff {
  const oldLines = old.split("\n");
  const newLines = now.split("\n");
  const oldSet = new Set(oldLines);
  const newSet = new Set(newLines);
  return {
    id: 0, path, tooLarge, isNewFile: false, hunks: [],
    added: newLines.filter((l) => l !== "" && !oldSet.has(l)).length,
    removed: oldLines.filter((l) => l !== "" && !newSet.has(l)).length,
  };
}

/** Line diff by longest common subsequence. */
function buildDiffLines(a: string[], b: string[]): DiffLine[] {
  const m = a.length, n = b.length;
  const dp: Uint32Array[] = [];
  for (let i = 0; i <= m; i++) dp.push(new Uint32Array(n + 1));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const matches: [number, number][] = [];
  let i = m, j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) { matches.push([i - 1, j - 1]); i--; j--; }
    else if (dp[i - 1][j] >= dp[i][j - 1]) i--;
    else j--;
  }
  matches.reverse();

  const out: DiffLine[] = [];
  let prevOld = -1, prevNew = -1;
  const removeUpTo = (to: number) => {
    for (let k = prevOld + 1; k < to; k++) out.push({ kind: "removed", text: a[k], origLine: k + 1, newLine: -1 });
  };
  const addUpTo = (to: number) => {
    for (let k = prevNew + 1; k < to; k++) out.push({ kind: "added", text: b[k], origLine: -1, newLine: k + 1 });
  };
  for (const [oi, ni] of matches) {
    removeUpTo(oi);
    addUpTo(ni);
    out.push({ kind: "context", text: a[oi], origLine: oi + 1, newLine: ni + 1 });
    prevOld = oi;
    prevNew = ni;
  }
  removeUpTo(m);
  addUpTo(n);
  return out;
}

/** The changed lines with three lines of context either side; overlapping ranges merge. */
function buildHunks(lines: DiffLine[], context: number): DiffHunk[] {
  const changed: number[] = [];
  lines.forEach((l, i) => { if (l.kind !== "context") changed.push(i); });
  if (!changed.length) return [];
  const merged: [number, number][] = [];
  for (const idx of changed) {
    const r: [number, number] = [Math.max(0, idx - context), Math.min(lines.length - 1, idx + context)];
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
    else merged.push(r);
  }
  return merged.map(([s, e]) => {
    const hl = lines.slice(s, e + 1);
    return {
      origStart: hl.find((l) => l.origLine > 0)?.origLine ?? 1,
      newStart: hl.find((l) => l.newLine > 0)?.newLine ?? 1,
      lines: hl,
    };
  });
}

export function diffFromEdit(old: string, now: string, path: string): FileDiff {
  if (byteLen(old) + byteLen(now) > DIFF_MAX_BYTES) return countFallback(old, now, path, true);
  const a = splitLines(old), b = splitLines(now);
  if (a.length + b.length > DIFF_MAX_LINES) return countFallback(old, now, path, true);
  // The table is quadratic: bail out before it blows up.
  if (a.length * b.length > 1_000_000) return countFallback(old, now, path, true);
  const flat = buildDiffLines(a, b);
  return {
    id: 0, path, tooLarge: false, isNewFile: false,
    hunks: buildHunks(flat, 3),
    added: flat.filter((l) => l.kind === "added").length,
    removed: flat.filter((l) => l.kind === "removed").length,
  };
}

export function diffFromNew(content: string, path: string): FileDiff {
  if (byteLen(content) > DIFF_MAX_BYTES) {
    return { id: 0, path, added: content.split("\n").length, removed: 0, hunks: [], tooLarge: true, isNewFile: true };
  }
  const lines = splitLines(content);
  if (lines.length > DIFF_MAX_LINES) {
    return { id: 0, path, added: lines.length, removed: 0, hunks: [], tooLarge: true, isNewFile: true };
  }
  const diffLines: DiffLine[] = lines.map((text, i) => ({ kind: "added", text, origLine: -1, newLine: i + 1 }));
  return {
    id: 0, path, added: diffLines.length, removed: 0, tooLarge: false, isNewFile: true,
    hunks: diffLines.length ? [{ origStart: 0, newStart: 1, lines: diffLines }] : [],
  };
}

/** The diff of an Edit / MultiEdit / Write tool call, or null for anything else (or no change). */
export function diffFromTool(tool: string, input: Record<string, unknown>): FileDiff | null {
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  const path = str(input.file_path);
  if (!path) return null;
  switch (tool) {
    case "Edit": {
      const old = str(input.old_string), now = str(input.new_string);
      if (old == null || now == null || (!old && !now)) return null;
      const d = diffFromEdit(old, now, path);
      return d.added > 0 || d.removed > 0 ? d : null;
    }
    case "MultiEdit": {
      const edits = Array.isArray(input.edits) ? (input.edits as Record<string, unknown>[]) : [];
      if (!edits.length) return null;
      let added = 0, removed = 0, tooLarge = false;
      const hunks: DiffHunk[] = [];
      for (const e of edits) {
        const old = str(e.old_string), now = str(e.new_string);
        if (old == null || now == null) continue;
        const d = diffFromEdit(old, now, path);
        added += d.added; removed += d.removed; hunks.push(...d.hunks);
        if (d.tooLarge) tooLarge = true;
      }
      return added > 0 || removed > 0 ? { id: 0, path, added, removed, hunks, tooLarge, isNewFile: false } : null;
    }
    case "Write": {
      const content = str(input.content);
      if (!content) return null;
      const d = diffFromNew(content, path);
      return d.added > 0 || d.removed > 0 ? d : null;
    }
    default:
      return null;
  }
}

// ── The ticker step that stands for a diff ────────────────────────────────────

/** A private-use character that marks a ticker step as a file diff. */
export const DIFF_STEP_MARKER = "";

export const isDiffStep = (s: string) => s.startsWith(DIFF_STEP_MARKER);

export function makeDiffStep(filename: string, added: number, removed: number, diffId: number): string {
  return `${DIFF_STEP_MARKER}${filename}\t${added}:${removed}:${diffId}`;
}

export function parseDiffStep(s: string): { filename: string; added: number; removed: number; diffId: number } | null {
  if (!isDiffStep(s)) return null;
  const body = s.slice(1);
  const tab = body.indexOf("\t");
  if (tab < 0) return null;
  const parts = body.slice(tab + 1).split(":");
  if (parts.length !== 3) return null;
  const [added, removed, diffId] = parts.map((p) => Number.parseInt(p, 10));
  if ([added, removed, diffId].some((n) => Number.isNaN(n))) return null;
  return { filename: body.slice(0, tab), added, removed, diffId };
}

/**
 * A possibly multi-line, Markdown-formatted text as one line of plain text: the first
 * paragraph that says anything (a paragraph ends at a blank line, a rule or a table row),
 * without bold markers, backticks, leading # and bullet markers.
 */
export function toOneLine(text: string, maxChars = 200): string {
  const paragraphs: string[][] = [];
  let current: string[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    const isHR = t.length >= 3 && (/^-+$/.test(t) || /^\*+$/.test(t) || /^_+$/.test(t));
    if (t === "" || isHR || t.startsWith("|")) {
      if (current.length) { paragraphs.push(current); current = []; }
    } else current.push(line);
  }
  if (current.length) paragraphs.push(current);

  for (const para of paragraphs) {
    const s = para.join("\n").replace(/\*\*/g, "").replace(/__/g, "").replace(/`/g, "");
    const processed = s.split("\n").map((line) => {
      let l = line.replace(/^#+/, "").trim();
      if (/^(- |\* |• )/.test(l)) l = l.slice(2);
      else l = l.replace(/^\d+\.\s+/, "");
      return l.trim();
    }).filter(Boolean);
    const collapsed = processed.join(" ").split(/\s+/).filter(Boolean).join(" ");
    if (collapsed) return collapsed.slice(0, maxChars);
  }
  return "";
}
