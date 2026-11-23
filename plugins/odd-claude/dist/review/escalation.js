// Agent risk escalation. The agent may name one of the six Task Size high-risk items for a candidate; that makes a review due
// whatever the assessed tier, and a fresh START freezes the tier as high. It can only raise, never lower.
//
// Review assess / start / run record a valid escalation bound to the exact candidate identity
// (`<git-common-dir>/odd-plugin/review-escalations.json`, atomic writes, bounded). The Stop reminder and the delivery notice
// read it through `due.ts`; a changed candidate has another identity, so the escalation no longer applies. Reads are
// fail-closed to "no escalation" (a missing, corrupt or oversized file is never an error for a hook).
import { lstatSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "./store.js";
export const ESCALATION_SCHEMA = "odd-claude.review-escalations/v1";
/** The reason cap, in UTF-8 bytes (native assess measures bytes, not characters). */
export const ESCALATION_REASON_MAX_BYTES = 500;
const MAX_ENTRIES = 16;
const MAX_FILE_BYTES = 64 * 1024;
const SHA_RE = /^sha256:[0-9a-f]{64}$/;
/** Only a line break breaks the consent decode: tabs and other characters are accepted. */
const LINE_BREAK = /[\n\v\f\r\u0085\u2028\u2029]/;
/** The escalation store cannot be written (a non-regular file in its place, an unusable odd-plugin directory, an I/O error). Nothing is written. */
export class EscalationStoreError extends Error {
    constructor(message, options) {
        super(message.slice(0, 300), options);
        this.name = "EscalationStoreError";
    }
}
/** Schema of the `escalate` tool argument (shared by review_assess, review_start and review_run). */
export const ESCALATE_SCHEMA_DESCRIPTION = 'Agent risk escalation {"item": 1-6 (the Task Size high-risk item), "reason": one line, non-empty, at most 500 UTF-8 bytes}. Makes a review due whatever the tier (Stop reminder and delivery notice included) and, on a fresh START, freezes the tier as high. It can only raise the tier, never lower it, and it applies to this exact candidate only.';
/** Validates the `escalate` argument. A string is the reason it is invalid. */
export function decodeEscalation(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        return "escalate must be an object with item and reason";
    const o = value;
    const unexpected = Object.keys(o).find((k) => k !== "item" && k !== "reason");
    if (unexpected !== undefined)
        return `escalate does not accept ${unexpected}`;
    const { item, reason } = o;
    if (typeof item !== "number" || !Number.isInteger(item) || item < 1 || item > 6)
        return "escalate item must be an integer from 1 to 6 naming a high-risk item";
    if (typeof reason !== "string" || reason.trim() === "" || Buffer.byteLength(reason, "utf8") > ESCALATION_REASON_MAX_BYTES) {
        return `escalate reason must be a non-empty string of at most ${ESCALATION_REASON_MAX_BYTES} UTF-8 bytes`;
    }
    if (LINE_BREAK.test(reason))
        return "escalate reason must be one line: no line breaks";
    return { item, reason };
}
const pathFor = (commonDir) => join(commonDir, "odd-plugin", "review-escalations.json");
function readEntries(commonDir) {
    try {
        const path = pathFor(commonDir);
        const st = lstatSync(path);
        if (!st.isFile() || st.size > MAX_FILE_BYTES)
            return [];
        const parsed = JSON.parse(readFileSync(path, "utf8"));
        if (parsed.schema !== ESCALATION_SCHEMA || !Array.isArray(parsed.entries))
            return [];
        const out = [];
        for (const e of parsed.entries) {
            const o = e;
            const d = decodeEscalation({ item: o?.item, reason: o?.reason });
            if (typeof d !== "string" && typeof o.target_identity === "string" && SHA_RE.test(o.target_identity))
                out.push({ target_identity: o.target_identity, ...d });
        }
        return out;
    }
    catch {
        return [];
    }
}
/** The escalation recorded for exactly this candidate identity, or undefined. Never throws. */
export function readEscalation(commonDir, targetIdentity) {
    const found = readEntries(commonDir).find((e) => e.target_identity === targetIdentity);
    return found === undefined ? undefined : { item: found.item, reason: found.reason };
}
/** Records (replaces) the escalation of one candidate identity; keeps only the newest MAX_ENTRIES. Atomic. Throws EscalationStoreError and writes nothing when the store is unusable. */
export function recordEscalation(commonDir, targetIdentity, escalation) {
    if (!SHA_RE.test(targetIdentity))
        throw new RangeError("target identity must be sha256:<64 hex>");
    const dir = join(commonDir, "odd-plugin");
    const path = pathFor(commonDir);
    const kind = (p) => {
        try {
            const st = lstatSync(p);
            return st.isDirectory() ? "dir" : st.isFile() ? "file" : "other";
        }
        catch {
            return "absent";
        }
    };
    const dirKind = kind(dir);
    if (dirKind === "file" || dirKind === "other")
        throw new EscalationStoreError("the escalation store cannot be used: the odd-plugin directory of this clone is not a real directory");
    const pathKind = kind(path);
    if (pathKind === "dir" || pathKind === "other")
        throw new EscalationStoreError("the escalation store cannot be used: review-escalations.json is not a regular file; the escalation was not recorded");
    try {
        if (dirKind === "absent")
            mkdirSync(dir, { recursive: true, mode: 0o700 });
        const entries = [...readEntries(commonDir).filter((e) => e.target_identity !== targetIdentity), { target_identity: targetIdentity, item: escalation.item, reason: escalation.reason }].slice(-MAX_ENTRIES);
        writeAtomic(path, `${JSON.stringify({ schema: ESCALATION_SCHEMA, entries })}\n`);
    }
    catch (e) {
        throw new EscalationStoreError(`the escalation store cannot be written (${e.code ?? "error"}); the escalation was not recorded`, { cause: e });
    }
}
/**
 * Wraps a risk assessor so a candidate with a recorded escalation is high (raise only): a START then reads and freezes the
 * tier as high. The assessed reasons stay, with the agent's escalation named first.
 */
export function escalatingAssessor(base) {
    return async (snapshot, repository) => {
        const assessment = await base(snapshot, repository);
        if (assessment.level === "high")
            return assessment;
        const escalation = readEscalation(repository.commonDir, snapshot.identity);
        if (escalation === undefined)
            return assessment;
        return {
            ...assessment,
            level: "high",
            reasons: [{ code: "agent_escalation", signal: `item ${escalation.item}` }, ...assessment.reasons],
            evidence: [`agent escalation (high-risk item ${escalation.item}): ${escalation.reason}`, ...assessment.evidence],
        };
    };
}
