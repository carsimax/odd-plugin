// Managed blocks inside <claudeDir>/CLAUDE.md, fenced by `<!-- odd-claude:ID -->` ... `<!-- /odd-claude:ID -->`.
// Text outside the markers is never read for meaning and never changed (D2). The ledger (manifest.blocks) maps a block id to
// the hash of its inner text when we wrote it: a block is replaced or removed only when its current hash equals that hash.
//
// Block sources: `<payload>/claude-md/<NN->name.md`, ordered by filename. The id is the filename without `.md` and without an
// optional leading numeric order prefix (`10-core.md` -> `core`, `core.md` -> `core`); ids are `[a-z0-9][a-z0-9-]*` and unique.
// Inner text is normalized to LF with the surrounding newlines trimmed before hashing; the file's own line ending (LF or CRLF)
// is used for everything we write.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "./manifest.js";

export const CLAUDE_MD = "CLAUDE.md";
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const MARKER_RE = /<!--[ \t]*(\/?)odd-claude:([A-Za-z0-9_-]+)[ \t]*-->/g;

export interface DesiredBlock {
  id: string;
  /** Normalized inner text (LF, no leading or trailing newline). */
  text: string;
}

const normalize = (s: string): string => s.replace(/\r\n/g, "\n").replace(/^\n+/, "").replace(/\n+$/, "");

/** Blocks shipped in `<payloadDir>/claude-md`, in filename order. A missing dir means none. */
export function readDesiredBlocks(payloadDir: string, resolve: (s: string) => string): DesiredBlock[] {
  const dir = join(payloadDir, "claude-md");
  if (!existsSync(dir)) return [];
  const out: DesiredBlock[] = [];
  const seen = new Set<string>();
  for (const name of readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith(".md")).map((e) => e.name).sort()) {
    const id = name.slice(0, -3).replace(/^\d+-/, "");
    if (!ID_RE.test(id)) throw new Error(`claude-md/${name}: block id ${JSON.stringify(id)} must match ${ID_RE}`);
    if (seen.has(id)) throw new Error(`claude-md/${name}: duplicate block id ${id}`);
    seen.add(id);
    out.push({ id, text: normalize(resolve(readFileSync(join(dir, name), "utf8"))) });
  }
  return out;
}

interface Found {
  start: number;
  end: number;
  hash: string;
}
export interface ParsedClaudeMd {
  blocks: Map<string, Found>;
  /** Set when markers are duplicated, orphaned or nested: nothing is guessed, every block is a conflict. */
  malformed: string | null;
}

export function parseBlocks(text: string): ParsedClaudeMd {
  const blocks = new Map<string, Found>();
  let open: { id: string; start: number; innerStart: number } | null = null;
  let malformed: string | null = null;
  for (const m of text.matchAll(MARKER_RE)) {
    const closing = m[1] === "/";
    const id = m[2]!;
    const at = m.index!;
    if (!closing) {
      if (open) malformed ??= `marker odd-claude:${id} opens inside odd-claude:${open.id}`;
      else open = { id, start: at, innerStart: at + m[0].length };
    } else if (!open || open.id !== id) {
      malformed ??= `orphan closing marker odd-claude:${id}`;
    } else {
      if (blocks.has(id)) malformed ??= `duplicate block odd-claude:${id}`;
      blocks.set(id, { start: open.start, end: at + m[0].length, hash: sha256(normalize(text.slice(open.innerStart, at))) });
      open = null;
    }
  }
  if (open) malformed ??= `unclosed marker odd-claude:${open.id}`;
  return { blocks, malformed };
}

export type BlockActionKind = "create" | "update" | "unchanged" | "conflict" | "remove";
export interface BlockAction {
  action: BlockActionKind;
  id: string;
  /** Final inner text for create/update/unchanged. */
  text?: string;
  reason?: string;
}

/** Same ownership semantics as planInstallFiles, per block. */
export function planBlocks(current: string | null, desired: DesiredBlock[], owned: Record<string, string>): BlockAction[] {
  const parsed = parseBlocks(current ?? "");
  const bad = (): string | undefined => (parsed.malformed ? `CLAUDE.md has malformed odd-claude markers (${parsed.malformed}); kept` : undefined);
  const actions: BlockAction[] = [];
  for (const d of desired) {
    const base = { id: d.id, text: d.text };
    const cur = parsed.blocks.get(d.id);
    const reason = bad();
    if (reason) actions.push({ ...base, action: "conflict", reason });
    else if (!cur) actions.push({ ...base, action: "create" });
    else if (cur.hash === sha256(d.text)) actions.push({ ...base, action: "unchanged" });
    else if (owned[d.id] === undefined) actions.push({ ...base, action: "conflict", reason: "block exists and was not installed by odd-claude" });
    else if (cur.hash === owned[d.id]) actions.push({ ...base, action: "update" });
    else actions.push({ ...base, action: "conflict", reason: "block was edited since odd-claude installed it" });
  }
  const wanted = new Set(desired.map((d) => d.id));
  for (const [id, hash] of Object.entries(owned).sort(([a], [b]) => a.localeCompare(b))) {
    if (wanted.has(id)) continue;
    const cur = parsed.blocks.get(id);
    const reason = bad();
    if (reason) actions.push({ action: "conflict", id, reason });
    else if (!cur) continue;
    else actions.push(cur.hash === hash ? { action: "remove", id } : { action: "conflict", id, reason: "no longer shipped but edited since install; kept" });
  }
  return actions;
}

const eolOf = (text: string): string => (text.includes("\r\n") ? "\r\n" : "\n");
const render = (id: string, text: string, eol: string): string => `<!-- odd-claude:${id} -->${eol}${text.replace(/\n/g, eol)}${eol}<!-- /odd-claude:${id} -->`;

function removeBlock(text: string, f: Found, eol: string): string {
  let end = f.end;
  const before0 = text.slice(0, f.start);
  if (text.startsWith(eol, end)) end += eol.length;
  // A blank separator line after the block goes with it, unless the text before still needs it.
  if (text.startsWith(eol, end) && (before0 === "" || before0.endsWith(eol))) end += eol.length;
  let before = before0;
  const after = text.slice(end);
  // Undo the blank separator that insertion added when the removed block was the last thing in the file.
  if (after === "" && before.endsWith(eol + eol)) before = before.slice(0, -eol.length);
  return before + after;
}

/** Applies create/update/remove to `current` and returns the new text; text outside the markers is untouched. */
export function applyBlocks(current: string | null, actions: BlockAction[]): string {
  let text = current ?? "";
  const eol = eolOf(text);
  for (const a of actions.filter((x) => x.action === "update" || x.action === "remove")) {
    const f = parseBlocks(text).blocks.get(a.id);
    if (!f) continue;
    text = a.action === "update" ? text.slice(0, f.start) + render(a.id, a.text!, eol) + text.slice(f.end) : removeBlock(text, f, eol);
  }
  const created = actions.filter((x) => x.action === "create").map((a) => render(a.id, a.text!, eol));
  if (created.length > 0) {
    let head = text;
    if (head.trim() !== "") head += (head.endsWith(eol) ? "" : eol) + (head.endsWith(eol + eol) ? "" : eol);
    else head = "";
    text = head + created.join(eol + eol) + eol;
  }
  return text;
}
