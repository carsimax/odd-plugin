// Test-only, read-only view of the persisted review store, as files on disk: <git-common-dir>/odd-plugin/review-transactions/v2/<lineage>/
// {review-state.json, review-receipt.json}. It re-derives what the contract says about those files (state revision, receipt hash,
// consumption = burned state + a valid matching receipt) without importing any product module.
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson, domainHash } from "./canonical.testkit.js";

const LINEAGE_RE = /^review-[0-9a-f]{16}$/;
const SHA_RE = /^sha256:[0-9a-f]{64}$/;
const TREE_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const LENSES = ["risk", "resilience", "readability", "reliability"];
export const RECEIPT_SCHEMA = "odd-claude.review-receipt/v1";

export class StoreNotFoundError extends Error {}

export const storeRootFor = (commonDir: string): string => join(commonDir, "odd-plugin", "review-transactions", "v2");

export type StateRecord = Record<string, any>;

/** The decoded state of a lineage; throws StoreNotFoundError when it has none, a plain Error when the record does not verify. */
export function readState(commonDir: string, lineage: string): StateRecord {
  const file = join(storeRootFor(commonDir), lineage, "review-state.json");
  if (!existsSync(file)) throw new StoreNotFoundError(file);
  const record = JSON.parse(readFileSync(file, "utf8")) as StateRecord;
  if (record.lineage_id !== lineage) throw new Error(`${file}: record belongs to ${record.lineage_id}`);
  const { revision, ...rest } = record;
  if (revision !== domainHash("review-state", 2, rest)) throw new Error(`${file}: revision does not match the record content`);
  return record;
}

export function readReceipt(commonDir: string, lineage: string): Record<string, unknown> {
  const file = join(storeRootFor(commonDir), lineage, "review-receipt.json");
  if (!existsSync(file)) throw new StoreNotFoundError(file);
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}

export function listLineages(commonDir: string): { lineages: string[] } {
  const root = storeRootFor(commonDir);
  if (!existsSync(root)) return { lineages: [] };
  return { lineages: readdirSync(root).filter((n) => LINEAGE_RE.test(n) && lstatSync(join(root, n)).isDirectory()).sort() };
}

const RECEIPT_KEYS = [
  "schema", "lineage_id", "target_identity", "projection", "base_tree", "candidate_tree", "approved_revision",
  "burned_at", "selected_lenses", "risk_level", "ledger_hash", "evidence_hash", "burn_receipt", "receipt_hash",
];

export type ReceiptValidation = { ok: true; receipt: Record<string, any> } | { ok: false; errors: string[] };

/** Strict structural validation plus recomputation of `receipt_hash`. */
export function validateReceipt(input: unknown): ReceiptValidation {
  const errors: string[] = [];
  if (typeof input !== "object" || input === null || Array.isArray(input)) return { ok: false, errors: ["receipt must be an object"] };
  const o = input as Record<string, any>;
  for (const k of Object.keys(o)) if (!RECEIPT_KEYS.includes(k)) errors.push(`unknown field ${k}`);
  for (const k of RECEIPT_KEYS) if (!(k in o)) errors.push(`missing field ${k}`);
  if (errors.length > 0) return { ok: false, errors };
  const sha = (k: string): boolean => typeof o[k] === "string" && SHA_RE.test(o[k]);
  if (o.schema !== RECEIPT_SCHEMA) errors.push(`schema must be ${RECEIPT_SCHEMA}`);
  if (typeof o.lineage_id !== "string" || !LINEAGE_RE.test(o.lineage_id)) errors.push("lineage_id must match review-<16 hex>");
  for (const k of ["target_identity", "approved_revision", "ledger_hash", "evidence_hash", "burn_receipt", "receipt_hash"]) {
    if (!sha(k)) errors.push(`${k} must be sha256:<64 hex>`);
  }
  if (o.projection !== "workspace" && o.projection !== "staged") errors.push("projection must be workspace or staged");
  for (const k of ["base_tree", "candidate_tree"]) if (typeof o[k] !== "string" || !TREE_RE.test(o[k])) errors.push(`${k} must be a tree id`);
  if (typeof o.burned_at !== "string" || !TIME_RE.test(o.burned_at) || !Number.isFinite(Date.parse(o.burned_at))) errors.push("burned_at must be a UTC RFC 3339 timestamp");
  if (o.risk_level !== "low" && o.risk_level !== "medium" && o.risk_level !== "high") errors.push("risk_level must be low, medium or high");
  if (!Array.isArray(o.selected_lenses) || !o.selected_lenses.every((l) => typeof l === "string" && LENSES.includes(l))) errors.push("selected_lenses must be a list of known lenses");
  if (errors.length === 0) {
    const { receipt_hash: _h, ...body } = o;
    void _h;
    if (o.receipt_hash !== domainHash("review-receipt", 1, body)) errors.push("receipt_hash does not match the receipt content");
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, receipt: o };
}

export type ConsumptionStatus = "consumed" | "not_consumed" | "unknown";

/**
 * `consumed`: a burned, approved lineage for the target has a valid receipt matching its burned state. `unknown`: no such receipt, and
 * some lineage could not be proven. A receipt alone, without a burned state, never counts.
 */
export function isTargetConsumed(commonDir: string, targetIdentity: string): { status: ConsumptionStatus } {
  let receipts = 0;
  let problems = 0;
  for (const lineage of listLineages(commonDir).lineages) {
    let state: StateRecord;
    try {
      state = readState(commonDir, lineage);
    } catch (e) {
      if (!(e instanceof StoreNotFoundError)) problems++;
      continue;
    }
    if (state.target_identity !== targetIdentity || state.state !== "approved" || !state.burned) continue;
    let raw: Record<string, unknown>;
    try {
      raw = readReceipt(commonDir, lineage);
    } catch {
      problems++;
      continue;
    }
    const v = validateReceipt(raw);
    if (!v.ok) {
      problems++;
      continue;
    }
    const r = v.receipt;
    const same =
      r.lineage_id === lineage && r.target_identity === state.target_identity && r.burn_receipt === state.burn_receipt &&
      r.burned_at === state.updated_at && r.candidate_tree === state.candidate_tree && r.base_tree === state.base_tree &&
      r.projection === state.projection && r.risk_level === state.risk_level && canonicalJson(r.selected_lenses) === canonicalJson(state.selected_lenses) &&
      r.ledger_hash === state.ledger_hash && r.evidence_hash === state.evidence_hash && r.approved_revision === state.approved_revision;
    if (same) receipts++;
    else problems++;
  }
  return { status: receipts > 0 ? "consumed" : problems > 0 ? "unknown" : "not_consumed" };
}

// ---- planting (crash sweep fixtures) ----

/** `review-state.json` of a medium-risk `reviewing` lineage `review-000000000000feed`, byte for byte what the store writes (captured from the TS implementation). */
export const LIVE_LINEAGE = "review-000000000000feed";
const LIVE_STATE =
  '{"admitted_role_results":[],"base_tree":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","burned":false,"candidate_tree":"cccccccccccccccccccccccccccccccccccccccc","correction_attempts":0,"correction_budget":4,"correction_budget_policy":"floor_two","created_at":"2026-11-19T10:00:00.000Z","findings":[],"fix_finding_ids":[],"lineage_id":"review-000000000000feed","original_changed_lines":8,"projection":"workspace","revision":"sha256:402a9e3e167bccfd234188bc234eb19f88a5ad786e0745a0aed19555f4bdc91f","risk_level":"medium","schema":"odd-claude.review-state/v2","selected_lenses":["reliability"],"state":"reviewing","target_identity":"sha256:7777777777777777777777777777777777777777777777777777777777777777","updated_at":"2026-11-19T10:00:00.000Z"}\n';

/** Creates the store directories (0700) and the live lineage as the store lays them out. */
export function plantLiveLineage(commonDir: string): void {
  let path = commonDir;
  for (const part of ["odd-plugin", "review-transactions", "v2"]) {
    path = join(path, part);
    if (!existsSync(path)) mkdirSync(path, { mode: 0o700 });
  }
  const dir = join(path, LIVE_LINEAGE);
  mkdirSync(dir, { mode: 0o700 });
  writeFileSync(join(dir, "review-state.json"), LIVE_STATE, { mode: 0o600 });
}

export const backdate = (path: string, at: Date): void => utimesSync(path, at, at);
