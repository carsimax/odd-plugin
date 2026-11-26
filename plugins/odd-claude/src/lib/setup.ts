// Pure logic of /odd-setup: compute a change to `permissions.defaultMode` in a
// settings.json text and a human-readable diff. No filesystem access here.
// Write scope is exactly one key: permissions.defaultMode. Every other key is preserved.

export const MODES = ["default", "acceptEdits", "auto", "plan", "bypassPermissions"] as const;

/** Explicit risk note shown with a mode (dry run and apply); undefined when the mode needs none. */
export function modeWarning(mode: string): string | undefined {
  if (mode !== "bypassPermissions") return undefined;
  return "WARNING: bypassPermissions skips every permission prompt: Claude Code runs any tool, including destructive shell commands and edits of sensitive files, without asking. odd-claude ships no hook that blocks tools: hooks stay active in this mode (observed in the Q3 spike on Claude Code 2.1.326, docs/research/open-questions.md), but none of them denies anything, so they protect nothing here and nothing else stands between a mistaken or injected instruction and your machine. Use it only in a sandbox or a disposable checkout. Undo with `/odd-setup restore`.";
}
export type Mode = (typeof MODES)[number];

export function isMode(v: unknown): v is Mode {
  return typeof v === "string" && (MODES as readonly string[]).includes(v);
}

export type Plan =
  | { ok: true; changed: boolean; before: string | null; after: string; diff: string }
  | { ok: false; error: string };

export const NO_CHANGES = "no changes";

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

type Parsed = { ok: true; root: Record<string, unknown> } | { ok: false; error: string };

function parseSettings(text: string, checkPermissions = true): Parsed {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `settings file is not valid JSON (${(err as Error).message}); refusing to touch it` };
  }
  if (!isObject(root)) return { ok: false, error: "settings file is not a JSON object; refusing to touch it" };
  if (checkPermissions && "permissions" in root && !isObject(root.permissions)) {
    return { ok: false, error: "settings `permissions` is not an object; refusing to touch it" };
  }
  return { ok: true, root };
}

/** Current permissions.defaultMode of a settings text, or undefined (absent/invalid). */
export function currentMode(text: string | null): string | undefined {
  if (text === null) return undefined;
  const p = parseSettings(text);
  if (!p.ok) return undefined;
  const perms = p.root.permissions;
  const m = isObject(perms) ? perms.defaultMode : undefined;
  return typeof m === "string" ? m : undefined;
}

function detectIndent(text: string): string | number {
  const m = /^\{[ \t]*\r?\n([ \t]+)\S/.exec(text);
  return m ? m[1]! : 2;
}

/** `text` is the current file content, or null when the file does not exist. */
export function planModeChange(text: string | null, mode: string, label = "settings.json"): Plan {
  if (!isMode(mode)) return { ok: false, error: `invalid mode "${mode}"; valid modes: ${MODES.join(", ")}` };
  if (text === null) {
    const after = JSON.stringify({ permissions: { defaultMode: mode } }, null, 2) + "\n";
    return { ok: true, changed: true, before: null, after, diff: unifiedDiff("", after, "/dev/null", label) };
  }
  const parsed = parseSettings(text);
  if (!parsed.ok) return parsed;
  const root = parsed.root;
  if (currentMode(text) === mode) return { ok: true, changed: false, before: text, after: text, diff: NO_CHANGES };
  const perms = isObject(root.permissions) ? root.permissions : {};
  perms.defaultMode = mode;
  root.permissions = perms;
  const after = JSON.stringify(root, null, detectIndent(text)) + (text.endsWith("\n") ? "\n" : "");
  return { ok: true, changed: after !== text, before: text, after, diff: unifiedDiff(text, after, label, label) };
}

function lines(s: string): string[] {
  if (s === "") return [];
  const l = s.split("\n");
  if (l[l.length - 1] === "") l.pop();
  return l;
}

/** Unified-style line diff (3 lines of context). Returns "no changes" when equal. */
export function unifiedDiff(a: string, b: string, labelA: string, labelB: string, context = 3): string {
  if (a === b) return NO_CHANGES;
  const x = lines(a);
  const y = lines(b);
  const n = x.length;
  const m = y.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i]![j] = x[i] === y[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  type Op = { t: " " | "-" | "+"; s: string };
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) ops.push({ t: " ", s: x[i++]! }), j++;
    else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) ops.push({ t: "-", s: x[i++]! });
    else ops.push({ t: "+", s: y[j++]! });
  }
  while (i < n) ops.push({ t: "-", s: x[i++]! });
  while (j < m) ops.push({ t: "+", s: y[j++]! });

  const out = [`--- ${labelA}`, `+++ ${labelB}`];
  const changeIdx = ops.map((o, k) => (o.t === " " ? -1 : k)).filter((k) => k >= 0);
  let k = 0;
  while (k < changeIdx.length) {
    let start = Math.max(0, changeIdx[k]! - context);
    let end = Math.min(ops.length, changeIdx[k]! + context + 1);
    let last = k;
    while (last + 1 < changeIdx.length && changeIdx[last + 1]! - context <= end) {
      last++;
      end = Math.min(ops.length, changeIdx[last]! + context + 1);
    }
    let aLine = 1;
    let bLine = 1;
    for (let q = 0; q < start; q++) {
      if (ops[q]!.t !== "+") aLine++;
      if (ops[q]!.t !== "-") bLine++;
    }
    const hunk = ops.slice(start, end);
    const aLen = hunk.filter((o) => o.t !== "+").length;
    const bLen = hunk.filter((o) => o.t !== "-").length;
    out.push(`@@ -${aLine},${aLen} +${bLine},${bLen} @@`);
    for (const o of hunk) out.push(o.t + o.s);
    k = last + 1;
    start = end;
  }
  return out.join("\n");
}

/** Sortable, filesystem-safe backup file name: settings.20261118T170000123Z.json */
export function backupFileName(now: Date): string {
  return `settings.${now.toISOString().replace(/[-:.]/g, "")}.json`;
}

export const BACKUP_NAME_RE = /^settings\.[A-Za-z0-9-]+\.json$/;
