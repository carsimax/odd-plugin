// Agent risk escalation. The agent may name one of the six Task Size high-risk items for a candidate; that makes a review due
// whatever the assessed tier, and a fresh START freezes the tier as high. It can only raise, never lower.
//
// Review assess / start / run record a valid escalation bound to the exact candidate identity
// (`<git-common-dir>/odd-plugin/review-escalations.json`, atomic writes, bounded). The Stop reminder and the delivery notice
// read it through `due.ts`; a changed candidate has another identity, so the escalation no longer applies. Reads are
// fail-closed to "no escalation" (a missing, corrupt or oversized file is never an error for a hook).
//
// Writes: the read-modify-write runs under a cross-process lock (`review-escalations.json.lock`, lib/lock.ts, bounded wait; a
// lock that cannot be taken is an EscalationStoreError, never a block). A corrupt store is never silently overwritten: it is
// renamed once to `review-escalations.json.corrupt-<timestamp>-<pid>` and a fresh store is written.
//
// A START records the escalation only after it succeeded (`escalationForStart`), bound to the identity the START froze.
import { lstatSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { acquireLock, releaseOwnedLock } from "../lib/lock.js";
import { findLineage } from "./lineage.js";
import type { RiskAssessor, StartOutcome } from "./start.js";
import { writeAtomic } from "./store.js";

export const ESCALATION_SCHEMA = "odd-claude.review-escalations/v1";
/** The reason cap, in UTF-8 bytes (native assess measures bytes, not characters). */
export const ESCALATION_REASON_MAX_BYTES = 500;
const MAX_ENTRIES = 16;
const MAX_FILE_BYTES = 64 * 1024;
const LOCK_WAIT_MS = 1500;
const LOCK_STALE_MS = 2000;
const SHA_RE = /^sha256:[0-9a-f]{64}$/;
/** Only a line break breaks the consent decode: tabs and other characters are accepted. */
const LINE_BREAK = /[\n\v\f\r\u0085\u2028\u2029]/;

/** The escalation store cannot be written (a non-regular file in its place, an unusable odd-plugin directory, an I/O error). Nothing is written. */
export class EscalationStoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message.slice(0, 300), options);
    this.name = "EscalationStoreError";
  }
}

export interface AgentEscalation {
  /** The Task Size high-risk item, 1-6. */
  item: number;
  reason: string;
}

/** Schema of the `escalate` tool argument (shared by review_assess, review_start and review_run). */
export const ESCALATE_SCHEMA_DESCRIPTION =
  'Agent risk escalation {"item": 1-6 (the Task Size high-risk item), "reason": one line, non-empty, at most 500 UTF-8 bytes}. Makes a review due whatever the tier (Stop reminder and delivery notice included) and, on a fresh START, freezes the tier as high. It can only raise the tier, never lower it, and it applies to this exact candidate only. The response says what happened in `escalation`: "recorded", "ignored_existing_lineage" (the candidate already has a review lineage, or the run resumes one) or "not_recorded" (no candidate, a refused START, or an unusable/busy store), with a short `escalation_detail`.';

/** Validates the `escalate` argument. A string is the reason it is invalid. */
export function decodeEscalation(value: unknown): AgentEscalation | string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "escalate must be an object with item and reason";
  const o = value as Record<string, unknown>;
  const unexpected = Object.keys(o).find((k) => k !== "item" && k !== "reason");
  if (unexpected !== undefined) return `escalate does not accept ${unexpected}`;
  const { item, reason } = o;
  if (typeof item !== "number" || !Number.isInteger(item) || item < 1 || item > 6) return "escalate item must be an integer from 1 to 6 naming a high-risk item";
  if (typeof reason !== "string" || reason.trim() === "" || Buffer.byteLength(reason, "utf8") > ESCALATION_REASON_MAX_BYTES) {
    return `escalate reason must be a non-empty string of at most ${ESCALATION_REASON_MAX_BYTES} UTF-8 bytes`;
  }
  if (LINE_BREAK.test(reason)) return "escalate reason must be one line: no line breaks";
  return { item, reason };
}

const pathFor = (commonDir: string): string => join(commonDir, "odd-plugin", "review-escalations.json");

interface Entry extends AgentEscalation {
  target_identity: string;
}

type Loaded = { kind: "absent" } | { kind: "ok"; entries: Entry[] } | { kind: "corrupt" };

/** Never throws: an I/O error other than "absent" is reported as corrupt (the store cannot be trusted). */
function loadStore(commonDir: string): Loaded {
  const path = pathFor(commonDir);
  let size: number;
  try {
    const st = lstatSync(path);
    if (!st.isFile()) return { kind: "corrupt" };
    size = st.size;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "absent" } : { kind: "corrupt" };
  }
  try {
    if (size > MAX_FILE_BYTES) return { kind: "corrupt" };
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { schema?: unknown; entries?: unknown } | null;
    if (parsed === null || typeof parsed !== "object" || parsed.schema !== ESCALATION_SCHEMA || !Array.isArray(parsed.entries)) return { kind: "corrupt" };
    const out: Entry[] = [];
    for (const e of parsed.entries as unknown[]) {
      const o = e as Record<string, unknown>;
      const d = decodeEscalation({ item: o?.item, reason: o?.reason });
      if (typeof d !== "string" && typeof o.target_identity === "string" && SHA_RE.test(o.target_identity)) out.push({ target_identity: o.target_identity, ...d });
    }
    return { kind: "ok", entries: out };
  } catch {
    return { kind: "corrupt" };
  }
}

function readEntries(commonDir: string): Entry[] {
  const loaded = loadStore(commonDir);
  return loaded.kind === "ok" ? loaded.entries : [];
}

/** The escalation recorded for exactly this candidate identity, or undefined. Never throws. */
export function readEscalation(commonDir: string, targetIdentity: string): AgentEscalation | undefined {
  const found = readEntries(commonDir).find((e) => e.target_identity === targetIdentity);
  return found === undefined ? undefined : { item: found.item, reason: found.reason };
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export interface RecordResult {
  /** File name the previous corrupt store was preserved under (in the odd-plugin directory), when there was one. */
  preservedCorrupt?: string;
}

/**
 * Records (replaces) the escalation of one candidate identity; keeps only the newest MAX_ENTRIES. Atomic and serialized across
 * processes. Throws EscalationStoreError and writes nothing when the store is unusable or the lock cannot be taken in time.
 */
export function recordEscalation(commonDir: string, targetIdentity: string, escalation: AgentEscalation): RecordResult {
  if (!SHA_RE.test(targetIdentity)) throw new RangeError("target identity must be sha256:<64 hex>");
  const dir = join(commonDir, "odd-plugin");
  const path = pathFor(commonDir);
  const kind = (p: string): "absent" | "dir" | "file" | "other" => {
    try {
      const st = lstatSync(p);
      return st.isDirectory() ? "dir" : st.isFile() ? "file" : "other";
    } catch {
      return "absent";
    }
  };
  const dirKind = kind(dir);
  if (dirKind === "file" || dirKind === "other") throw new EscalationStoreError("the escalation store cannot be used: the odd-plugin directory of this clone is not a real directory");
  const pathKind = kind(path);
  if (pathKind === "dir" || pathKind === "other") throw new EscalationStoreError("the escalation store cannot be used: review-escalations.json is not a regular file; the escalation was not recorded");
  const lock = `${path}.lock`;
  let locked = false;
  try {
    if (dirKind === "absent") mkdirSync(dir, { recursive: true, mode: 0o700 });
    const deadline = Date.now() + LOCK_WAIT_MS;
    while (!(locked = acquireLock(lock, process.pid, { staleMs: LOCK_STALE_MS, proofOfDeathOnly: true }))) {
      if (Date.now() >= deadline) throw new EscalationStoreError("the escalation store is busy (its lock could not be taken in time); the escalation was not recorded");
      sleepSync(3 + Math.random() * 5);
    }
    const result: RecordResult = {};
    const loaded = loadStore(commonDir);
    if (loaded.kind === "corrupt") {
      const kept = `review-escalations.json.corrupt-${Date.now()}-${process.pid}`;
      renameSync(path, join(dir, kept));
      result.preservedCorrupt = kept;
    }
    const current = loaded.kind === "ok" ? loaded.entries : [];
    const entries = [...current.filter((e) => e.target_identity !== targetIdentity), { target_identity: targetIdentity, item: escalation.item, reason: escalation.reason }].slice(-MAX_ENTRIES);
    writeAtomic(path, `${JSON.stringify({ schema: ESCALATION_SCHEMA, entries })}\n`);
    return result;
  } catch (e) {
    if (e instanceof EscalationStoreError) throw e;
    throw new EscalationStoreError(`the escalation store cannot be written (${(e as NodeJS.ErrnoException).code ?? "error"}); the escalation was not recorded`, { cause: e });
  } finally {
    if (locked) releaseOwnedLock(lock, process.pid);
  }
}

/** What happened to a valid `escalate` of a tool call. Reported as `escalation` (+ a short `escalation_detail`) in the tool response. */
export type EscalationStatus = "recorded" | "ignored_existing_lineage" | "not_recorded";
export interface EscalationReport {
  escalation: EscalationStatus;
  /** At most 300 characters; absent for a plain "recorded". */
  escalation_detail?: string;
}
const report = (escalation: EscalationStatus, detail?: string): EscalationReport => ({ escalation, ...(detail !== undefined ? { escalation_detail: detail.slice(0, 300) } : {}) });

/** Records for a tool call (review_assess) and reports the outcome; never throws. */
export function recordAndReport(commonDir: string, targetIdentity: string, escalation: AgentEscalation): EscalationReport {
  try {
    const r = recordEscalation(commonDir, targetIdentity, escalation);
    return report("recorded", r.preservedCorrupt !== undefined ? `the previous escalation store was corrupt and was preserved as ${r.preservedCorrupt}` : undefined);
  } catch (e) {
    return report("not_recorded", e instanceof EscalationStoreError ? e.message : `the escalation store cannot be written (${(e as NodeJS.ErrnoException).code ?? "error"}); the escalation was not recorded`);
  }
}

export const NO_FRESH_START_DETAIL = "no fresh START was offered for this candidate (a review lineage already exists for it, or the run stopped first): the escalation was ignored";

/**
 * Escalation of one START. `assessor` applies the escalation in memory to the candidate START freezes (a candidate that
 * already has a live or burned lineage is left alone) and remembers that identity; nothing is written. `settle(outcome)`
 * then records it, bound to that exact identity, only when the START succeeded in a way the escalation matters (a consent
 * envelope for the candidate), and reports what happened. A refused START records nothing.
 */
export function escalationForStart(base: RiskAssessor, escalation: AgentEscalation | undefined): { assessor: RiskAssessor; settle: (outcome: StartOutcome) => EscalationReport | undefined } {
  if (escalation === undefined) return { assessor: escalatingAssessor(base), settle: () => undefined };
  let frozen: { identity: string; commonDir: string } | undefined;
  const assessor: RiskAssessor = async (snapshot, repository) => {
    frozen = { identity: snapshot.identity, commonDir: repository.commonDir };
    const existing = findLineage(repository.commonDir, snapshot.identity, snapshot.projection);
    if (existing.live !== undefined || existing.burned !== undefined) return escalatingAssessor(base)(snapshot, repository);
    return escalatingAssessor(base, escalation)(snapshot, repository);
  };
  const settle = (outcome: StartOutcome): EscalationReport => {
    switch (outcome.status) {
      case "not_due":
        return report("not_recorded", "there is no candidate to bind the escalation to (no changes)");
      case "refused":
        return outcome.code === "target_already_acknowledged"
          ? report("ignored_existing_lineage", "this candidate already has a burned review lineage: the escalation was ignored")
          : report("not_recorded", `the START was refused (${outcome.code}); the escalation was not recorded`);
      case "declined":
        return report("not_recorded", "the START ended in a declined consent; the escalation was not recorded");
      case "started":
        return outcome.result.action === "replayed"
          ? report("ignored_existing_lineage", `candidate already has review lineage ${outcome.result.lineage_id}: the escalation was ignored and its frozen tier kept`)
          : report("not_recorded", "the review started without needing the escalation; it was not recorded");
      case "consent_required":
        return frozen === undefined ? report("not_recorded", "the candidate identity was not frozen; the escalation was not recorded") : recordAndReport(frozen.commonDir, frozen.identity, escalation);
    }
  };
  return { assessor, settle };
}

/**
 * Wraps a risk assessor so a candidate with a recorded escalation is high (raise only): a START then reads and freezes the
 * tier as high. The assessed reasons stay, with the agent's escalation named first. `inline` is an escalation applied in
 * memory instead of the recorded one (a START that records it only after it succeeded).
 */
export function escalatingAssessor(base: RiskAssessor, inline?: AgentEscalation): RiskAssessor {
  return async (snapshot, repository) => {
    const assessment = await base(snapshot, repository);
    if (assessment.level === "high") return assessment;
    const escalation = inline ?? readEscalation(repository.commonDir, snapshot.identity);
    if (escalation === undefined) return assessment;
    return {
      ...assessment,
      level: "high",
      reasons: [{ code: "agent_escalation", signal: `item ${escalation.item}` }, ...assessment.reasons],
      evidence: [`agent escalation (high-risk item ${escalation.item}): ${escalation.reason}`, ...assessment.evidence],
    };
  };
}
