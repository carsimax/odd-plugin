// Consent v3 envelope and candidate-scoped decline records (U5).
//
// The envelope mirrors the shape of the reference consent-v3 contract under odd-claude schema ids. It is
// a blocking question for ONE frozen candidate: nothing is persisted when it is returned. A decline is
// recorded as a tiny atomic file under `<git-common-dir>/odd-plugin/declines/<target hash>.json`, scoped
// to that candidate only (a later, different candidate asks again).
//
// The invocations name the plugin's review MCP tools (src/mcp/review-server.ts registers exactly `REVIEW_TOOL_NAMES`, and a test
// pins that every name used here exists). The consent choices call `review_answer_consent` with the answer; the off switch is
// the real `node <plugin root>/dist/cli/review-mode.js disable`.
import { lstatSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { oddClaudeRoot } from "../lib/root.js";
import { canonicalJson, domainHash } from "./canonical.js";
import { writeAtomic } from "./store.js";

export const REVIEW_CONTRACT = "odd-claude.review-integration/v2";
export const CONSENT_SCHEMA = "odd-claude.review-integration.consent/v3";
export const DECLINE_SCHEMA = "odd-claude.review-decline/v1";

/**
 * The final names of the review MCP tools, in registration order. The server key in `.mcp.json` is `review`, so Claude Code lists them
 * as `mcp__plugin_odd-claude_review__<name>`. S4 planned an `odd`-prefixed variant; agents-guard.spec.ts forbids that literal in every
 * shipped file, so the names are bare. `review_complete` is the one addition: status offers `review.validate` and needs a tool to name.
 */
export const REVIEW_TOOL_NAMES = [
  "review_assess",
  "review_inspect",
  "review_start",
  "review_status",
  "review_answer_consent",
  "review_capture",
  "review_capture_group",
  "review_acknowledge_approved",
  "review_complete",
  "review_run",
] as const;
export type ReviewToolName = (typeof REVIEW_TOOL_NAMES)[number];

const VERB_TOOL: Readonly<Record<string, ReviewToolName>> = {
  start: "review_start",
  capture: "review_capture",
  "capture-group": "review_capture_group",
  run: "review_run",
  complete: "review_complete",
  "acknowledge-approved": "review_acknowledge_approved",
};
/** The tool a status transition verb (`execute.command`) names. */
export const reviewCommand = (verb: "start" | "capture" | "capture-group" | "run" | "complete" | "acknowledge-approved"): ReviewToolName => VERB_TOOL[verb]!;
/** What a consent choice calls (the human's answer is the trailing `--consent granted|declined`). */
export const INVOCATION_PREFIX: ReviewToolName = "review_answer_consent";

/** Root of the odd-claude install (shared resolution: `CLAUDE_PLUGIN_ROOT`, else module-relative). */
export const pluginRootDir = (env: NodeJS.ProcessEnv = process.env): string => oddClaudeRoot(env);
/** The real off switch (user-wide). */
export function offPathCommand(env: NodeJS.ProcessEnv = process.env): string {
  return `node ${shellQuote(join(pluginRootDir(env), "dist", "cli", "review-mode.js"))} disable`;
}

const SHA_RE = /^sha256:([0-9a-f]{64})$/;

export type ConsentAnswer = "granted" | "declined";

export interface ConsentEnvelopeInput {
  agent?: "claude-code";
  cwd: string;
  targetIdentity: string;
  projection: "workspace" | "staged";
  riskLevel: "medium" | "high";
  changedFiles: number;
  changedLines: number;
  riskEvidence: string[];
  /** Extra flags that reproduce the target kind (e.g. `--target base-diff --base-ref main`). */
  targetArgs: string[];
  /** Explicit lens selection to replay on the answer, already validated. */
  lenses?: { names: string[]; reason: string };
  locale?: string;
}

export interface ConsentChoice {
  answer: ConsentAnswer;
  label: string;
  effect: string;
  invocation: string;
}

export interface ConsentEnvelope {
  schema: typeof CONSENT_SCHEMA;
  contract: typeof REVIEW_CONTRACT;
  operation: "review.start";
  action: "consent_required";
  agent: "claude-code";
  blocking: true;
  target_identity: string;
  projection: "workspace" | "staged";
  risk_level: "medium" | "high";
  changed_files: number;
  changed_lines: number;
  headline: string;
  reason: string;
  value: string;
  risk_evidence: string[];
  choices: [ConsentChoice, ConsentChoice];
  off_path: { note: string; command: string };
}

const TEXT = {
  en: {
    headline: "A review can check this change before you call it done.",
    reason: "Review can help detect execution issues in these changes.",
    value: "Reviewing takes a little longer and makes the result safer.",
    grantedLabel: "Review this change",
    grantedEffect: "Reviews only this change; later medium- or high-risk changes ask again, and delivery needs separate approval.",
    declinedLabel: "Skip this time",
    declinedEffect: "Skips only this change; no review record is created, and future reviews stay enabled.",
    offPath: (c: string) => `To turn reviews off for good, run '${c}'.`,
  },
  es: {
    headline: "Una revisión puede comprobar este cambio antes de darlo por terminado.",
    reason: "La revisión puede ayudar a detectar problemas de ejecución en estos cambios.",
    value: "Revisar tarda un poco más y hace el resultado más seguro.",
    grantedLabel: "Revisar este cambio",
    grantedEffect: "Revisa solo este cambio; los cambios posteriores de riesgo medio o alto preguntan de nuevo, y la entrega necesita aprobación aparte.",
    declinedLabel: "Omitir esta vez",
    declinedEffect: "Omite solo este cambio; no se crea ningún registro de revisión y las revisiones futuras siguen activas.",
    offPath: (c: string) => `Para desactivar las revisiones de forma permanente, ejecuta '${c}'.`,
  },
} as const;

/** POSIX single-quote escaping, so every value survives a shell untouched. */
export function shellQuote(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * What the human's answer is bound to: the candidate and the lens selection the question showed. The invocation carries it as
 * `--consent-binding`; `review_answer_consent` recomputes it from its own arguments, so an answer for another lens subset (or another
 * candidate) than the one asked is refused. Lens names are compared without the `review-` prefix.
 */
export function consentBinding(targetIdentity: string, lenses?: { names: readonly string[]; reason: string }): string {
  return domainHash("consent-binding", 1, {
    target_identity: targetIdentity,
    lenses: lenses === undefined ? null : lenses.names.map((n) => n.replace(/^review-/, "")),
    lenses_reason: lenses === undefined ? null : lenses.reason,
  });
}

export function buildConsentEnvelope(input: ConsentEnvelopeInput): ConsentEnvelope {
  const t = input.locale !== undefined && /^es(?:[-_]|$)/i.test(input.locale) ? TEXT.es : TEXT.en;
  const base = [
    INVOCATION_PREFIX,
    "--contract",
    REVIEW_CONTRACT,
    "--cwd",
    shellQuote(input.cwd),
    "--target-identity",
    input.targetIdentity,
    ...input.targetArgs,
    // projection is a property of current-changes only (a base-diff candidate has none)
    ...(input.targetArgs.includes("base-diff") ? [] : ["--projection", input.projection]),
    ...(input.lenses ? ["--lenses", shellQuote(input.lenses.names.join(",")), "--lenses-reason", shellQuote(input.lenses.reason)] : []),
    ...(input.locale !== undefined ? ["--locale", shellQuote(input.locale)] : []),
    "--consent-binding",
    consentBinding(input.targetIdentity, input.lenses),
  ].join(" ");
  return {
    schema: CONSENT_SCHEMA,
    contract: REVIEW_CONTRACT,
    operation: "review.start",
    action: "consent_required",
    agent: input.agent ?? "claude-code",
    blocking: true,
    target_identity: input.targetIdentity,
    projection: input.projection,
    risk_level: input.riskLevel,
    changed_files: input.changedFiles,
    changed_lines: input.changedLines,
    headline: t.headline,
    reason: t.reason,
    value: t.value,
    risk_evidence: [...input.riskEvidence],
    choices: [
      { answer: "granted", label: t.grantedLabel, effect: t.grantedEffect, invocation: `${base} --consent granted` },
      { answer: "declined", label: t.declinedLabel, effect: t.declinedEffect, invocation: `${base} --consent declined` },
    ],
    off_path: { note: t.offPath(offPathCommand()), command: offPathCommand() },
  };
}

// ---- candidate-scoped decline records ----

export interface DeclineRecord {
  schema: typeof DECLINE_SCHEMA;
  target_identity: string;
  projection: "workspace" | "staged";
  risk_level: "medium" | "high";
  declined_at: string;
}

export function declinesDirFor(commonDir: string): string {
  return join(commonDir, "odd-plugin", "declines");
}

export function declinePathFor(commonDir: string, targetIdentity: string): string {
  const m = SHA_RE.exec(targetIdentity);
  if (!m) throw new RangeError("target identity must be sha256:<64 hex>");
  return join(declinesDirFor(commonDir), `${m[1]}.json`);
}

function ensureDeclinesDir(commonDir: string): void {
  const plugin = join(commonDir, "odd-plugin");
  const dir = declinesDirFor(commonDir);
  mkdirSync(plugin, { recursive: true, mode: 0o700 });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory()) throw new Error(`declines path is not a real directory: ${dir}`);
}

/** Atomically records a decline for one candidate. The first record wins: re-declining leaves it untouched. */
export function recordDecline(commonDir: string, record: Omit<DeclineRecord, "schema">): { path: string; created: boolean } {
  const path = declinePathFor(commonDir, record.target_identity);
  ensureDeclinesDir(commonDir);
  if (readDecline(commonDir, record.target_identity)) return { path, created: false };
  writeAtomic(path, `${canonicalJson({ schema: DECLINE_SCHEMA, ...record })}\n`);
  return { path, created: true };
}

/** The decline recorded for this exact candidate, or undefined. A malformed file reads as absent. */
export function readDecline(commonDir: string, targetIdentity: string): DeclineRecord | undefined {
  const path = declinePathFor(commonDir, targetIdentity);
  let raw: string;
  try {
    if (!lstatSync(path).isFile()) return undefined;
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  try {
    const v = JSON.parse(raw) as DeclineRecord;
    return v && v.schema === DECLINE_SCHEMA && v.target_identity === targetIdentity ? v : undefined;
  } catch {
    return undefined;
  }
}
