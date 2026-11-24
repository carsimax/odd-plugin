// R36 local session stats, ported from upstream lib/shell-stats.ts (collectSessionStats + renderStatsRows).
// Differences: upstream reads Pi session entries and prices them; a Claude Code hook gets no usage API, so the
// numbers come from the transcript JSONL (`transcript_path` in hook input), persisted per session in the state
// file so the CLI can find it. Local only: no cost lookup, no quota endpoint, no network. Every read is bounded.
import { formatDuration } from "./subagents.js";
import { readSessionState } from "./state.js";
import { recordTranscriptPath, validPath } from "./transcript-path.js";
import { cleanText, readTail, STATS_MAX_LINE_BYTES, STATS_TAIL_BYTES } from "./transcript-tail.js";
export { recordTranscriptPath, STATS_MAX_LINE_BYTES, STATS_TAIL_BYTES };
const MAX_MODELS = 8;
const count = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
export function readTranscriptPath(sessionId, opts = {}) {
    const p = readSessionState(sessionId, opts).transcriptPath;
    return validPath(p) ? p : undefined;
}
/** Token totals from the transcript tail; undefined when it cannot be read. Never throws. */
export function collectTranscriptStats(path) {
    try {
        const tail = readTail(path);
        if (tail === undefined)
            return undefined;
        // Streaming writes the same message id several times with a growing usage: the last record wins.
        const byMessage = new Map();
        let first = Infinity;
        let last = -Infinity;
        let anon = 0;
        for (const line of tail.text.split("\n")) {
            if (line === "" || line.length > STATS_MAX_LINE_BYTES)
                continue;
            if (!line.includes('"usage"') && !line.includes('"timestamp"'))
                continue;
            let entry;
            try {
                entry = JSON.parse(line);
            }
            catch {
                continue;
            }
            if (typeof entry !== "object" || entry === null)
                continue;
            const at = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
            if (Number.isFinite(at)) {
                first = Math.min(first, at);
                last = Math.max(last, at);
            }
            const m = entry.message;
            const u = m?.usage;
            if (entry.type !== "assistant" || typeof m !== "object" || m === null || typeof u !== "object" || u === null)
                continue;
            const model = typeof m.model === "string" ? cleanText(m.model).slice(0, 80) : "";
            if (model === "<synthetic>")
                continue;
            byMessage.set(typeof m.id === "string" && m.id !== "" ? m.id : `anon-${anon++}`, {
                model: model === "" ? "unknown" : model,
                input: count(u.input_tokens),
                output: count(u.output_tokens),
                cacheRead: count(u.cache_read_input_tokens),
                cacheWrite: count(u.cache_creation_input_tokens),
            });
        }
        const stats = { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, spanMs: last > first ? last - first : 0, truncated: tail.truncated, bytesRead: tail.bytes, models: [] };
        const models = new Map();
        for (const r of byMessage.values()) {
            stats.turns++;
            stats.input += r.input;
            stats.output += r.output;
            stats.cacheRead += r.cacheRead;
            stats.cacheWrite += r.cacheWrite;
            const mu = models.get(r.model) ?? { model: r.model, turns: 0, tokens: 0 };
            mu.turns++;
            mu.tokens += r.input + r.output + r.cacheRead + r.cacheWrite;
            models.set(r.model, mu);
        }
        stats.models = [...models.values()].sort((a, b) => b.tokens - a.tokens || b.turns - a.turns).slice(0, MAX_MODELS);
        return stats;
    }
    catch {
        return undefined;
    }
}
export function readExploration(sessionId, opts = {}) {
    const e = readSessionState(sessionId, opts).exploration;
    if (typeof e !== "object" || e === null)
        return undefined;
    return { lookups: count(e.lookups), bytes: count(e.bytes) };
}
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
function tokens(n) {
    if (n < 1000)
        return String(n);
    if (n < 1_000_000)
        return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
    return `${(n / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M`;
}
/** Mirrors upstream renderStatsRows (spent line dropped: no pricing offline). */
export function renderStats(v) {
    const out = ["odd-claude stats (this session, local data only)"];
    const t = v.transcript;
    if (t === undefined)
        out.push(v.note ?? "No transcript to read for this session yet.");
    else {
        out.push(`turns      ${t.turns}${t.spanMs > 0 ? ` · ${formatDuration(t.spanMs)}` : ""}`);
        out.push(`tokens     in ${tokens(t.input)} · out ${tokens(t.output)}`);
        const prompt = t.input + t.cacheRead + t.cacheWrite;
        if (prompt > 0)
            out.push(`cache      ${Math.round((t.cacheRead / prompt) * 100)}% hit · ${tokens(t.cacheRead)} read · ${tokens(t.cacheWrite)} written`);
        for (const m of t.models)
            out.push(`  ${m.model}  ${plural(m.turns, "turn")} · ${tokens(m.tokens)} tokens`);
        if (t.truncated)
            out.push(`(partial: only the last ${(t.bytesRead / (1024 * 1024)).toFixed(1)} MiB of the transcript was read)`);
    }
    const done = v.subagents.filter((r) => r.startedAt !== undefined && r.endedAt !== undefined);
    const running = v.subagents.filter((r) => r.endedAt === undefined).length;
    const total = done.reduce((a, r) => a + Math.max(0, r.endedAt - r.startedAt), 0);
    out.push(`subagents  ${plural(v.subagents.length, "subagent")} (${running} running)${done.length > 0 ? ` · ${formatDuration(total)} finished work` : ""}`);
    if (v.exploration !== undefined)
        out.push(`explore    this turn: ${plural(v.exploration.lookups, "lookup")} · ${v.exploration.bytes} bytes`);
    return out.join("\n");
}
