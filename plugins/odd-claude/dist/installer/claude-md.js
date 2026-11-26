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
const normalize = (s) => s.replace(/\r\n/g, "\n").replace(/^\n+/, "").replace(/\n+$/, "");
/** Blocks shipped in `<payloadDir>/claude-md`, in filename order. A missing dir means none. */
export function readDesiredBlocks(payloadDir, resolve) {
    const dir = join(payloadDir, "claude-md");
    if (!existsSync(dir))
        return [];
    const out = [];
    const seen = new Set();
    for (const name of readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith(".md")).map((e) => e.name).sort()) {
        const id = name.slice(0, -3).replace(/^\d+-/, "");
        if (!ID_RE.test(id))
            throw new Error(`claude-md/${name}: block id ${JSON.stringify(id)} must match ${ID_RE}`);
        if (seen.has(id))
            throw new Error(`claude-md/${name}: duplicate block id ${id}`);
        seen.add(id);
        out.push({ id, text: normalize(resolve(readFileSync(join(dir, name), "utf8"))) });
    }
    return out;
}
/** Markers outside CLOSED CommonMark fenced code blocks (``` or ~~~, 3+ chars; the closing fence uses the same char and is at least as long). An unclosed fence hides nothing: its markers count as outside. */
function markersOutsideFences(text) {
    const out = [];
    let fence = null;
    let pos = 0;
    while (pos < text.length) {
        let nl = text.indexOf("\n", pos);
        if (nl < 0)
            nl = text.length;
        const line = text.slice(pos, nl).replace(/\r$/, "");
        const f = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
        if (fence) {
            if (f && f[1][0] === fence.ch && f[1].length >= fence.len && f[2].trim() === "")
                fence = null;
        }
        else if (f && !(f[1][0] === "`" && f[2].includes("`"))) {
            fence = { ch: f[1][0], len: f[1].length, resume: nl + 1, outLen: out.length };
        }
        else {
            for (const m of line.matchAll(MARKER_RE))
                out.push({ closing: m[1] === "/", id: m[2], at: pos + m.index, len: m[0].length });
        }
        pos = nl + 1;
    }
    if (fence) {
        out.length = fence.outLen;
        for (const m of text.slice(fence.resume).matchAll(MARKER_RE))
            out.push({ closing: m[1] === "/", id: m[2], at: fence.resume + m.index, len: m[0].length });
    }
    return out;
}
export function parseBlocks(text) {
    const blocks = new Map();
    let open = null;
    let malformed = null;
    for (const m of markersOutsideFences(text)) {
        const { closing, id, at } = m;
        if (!closing) {
            if (open)
                malformed ??= `marker odd-claude:${id} opens inside odd-claude:${open.id}`;
            else
                open = { id, start: at, innerStart: at + m.len };
        }
        else if (!open || open.id !== id) {
            malformed ??= `orphan closing marker odd-claude:${id}`;
        }
        else {
            if (blocks.has(id))
                malformed ??= `duplicate block odd-claude:${id}`;
            blocks.set(id, { start: open.start, end: at + m.len, hash: sha256(normalize(text.slice(open.innerStart, at))) });
            open = null;
        }
    }
    if (open)
        malformed ??= `unclosed marker odd-claude:${open.id}`;
    return { blocks, malformed };
}
/** Same ownership semantics as planInstallFiles, per block. */
export function planBlocks(current, desired, owned) {
    const parsed = parseBlocks(current ?? "");
    const rawIds = new Set([...(current ?? "").matchAll(MARKER_RE)].map((m) => m[2]));
    const fenced = (id) => rawIds.has(id) && !parsed.blocks.has(id);
    const bad = () => (parsed.malformed ? `CLAUDE.md has malformed odd-claude markers (${parsed.malformed}); kept` : undefined);
    const actions = [];
    for (const d of desired) {
        const base = { id: d.id, text: d.text };
        const cur = parsed.blocks.get(d.id);
        const reason = bad();
        if (reason)
            actions.push({ ...base, action: "conflict", reason });
        else if (!cur && fenced(d.id))
            actions.push({ ...base, action: "conflict", reason: "CLAUDE.md has odd-claude markers inside a code fence" });
        else if (!cur)
            actions.push({ ...base, action: "create" });
        else if (cur.hash === sha256(d.text))
            actions.push({ ...base, action: "unchanged" });
        else if (owned[d.id] === undefined)
            actions.push({ ...base, action: "conflict", reason: "block exists and was not installed by odd-claude" });
        else if (cur.hash === owned[d.id])
            actions.push({ ...base, action: "update" });
        else
            actions.push({ ...base, action: "conflict", reason: "block was edited since odd-claude installed it" });
    }
    const wanted = new Set(desired.map((d) => d.id));
    for (const [id, hash] of Object.entries(owned).sort(([a], [b]) => a.localeCompare(b))) {
        if (wanted.has(id))
            continue;
        const cur = parsed.blocks.get(id);
        const reason = bad();
        if (reason)
            actions.push({ action: "conflict", id, reason });
        else if (!cur)
            continue;
        else
            actions.push(cur.hash === hash ? { action: "remove", id } : { action: "conflict", id, reason: "no longer shipped but edited since install; kept" });
    }
    return actions;
}
const eolOf = (text) => (text.includes("\r\n") ? "\r\n" : "\n");
const render = (id, text, eol) => `<!-- odd-claude:${id} -->${eol}${text.replace(/\n/g, eol)}${eol}<!-- /odd-claude:${id} -->`;
function removeBlock(text, f, eol) {
    let end = f.end;
    const before0 = text.slice(0, f.start);
    if (text.startsWith(eol, end))
        end += eol.length;
    // A blank separator line after the block goes with it, unless the text before still needs it.
    if (text.startsWith(eol, end) && (before0 === "" || before0.endsWith(eol)))
        end += eol.length;
    let before = before0;
    const after = text.slice(end);
    // Undo the blank separator that insertion added when the removed block was the last thing in the file.
    // A block appended after a file without a final newline has no trailing EOL: drop the separator too, restoring the file exactly.
    if (after === "" && before.endsWith(eol + eol))
        before = before.slice(0, f.end === text.length ? -2 * eol.length : -eol.length);
    return before + after;
}
/** Applies create/update/remove to `current` and returns the new text; text outside the markers is untouched. */
export function applyBlocks(current, actions) {
    let text = current ?? "";
    const eol = eolOf(text);
    for (const a of actions.filter((x) => x.action === "update" || x.action === "remove")) {
        const f = parseBlocks(text).blocks.get(a.id);
        if (!f)
            continue;
        text = a.action === "update" ? text.slice(0, f.start) + render(a.id, a.text, eol) + text.slice(f.end) : removeBlock(text, f, eol);
    }
    const created = actions.filter((x) => x.action === "create").map((a) => render(a.id, a.text, eol));
    if (created.length > 0) {
        let head = text;
        if (head.trim() !== "")
            head += (head.endsWith(eol) ? "" : eol) + (head.endsWith(eol + eol) ? "" : eol);
        else
            head = "";
        // Keep a file without a final newline without one (uninstall restores it byte for byte).
        text = head + created.join(eol + eol) + (head === "" || text.endsWith(eol) ? eol : "");
    }
    return text;
}
