import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AckRefusedError,
  RECEIPT_SCHEMA,
  acknowledgeApproved,
  budgetStatus,
  findReceiptForTarget,
  isTargetConsumed,
  validateReceipt,
  type AckRefusalCode,
} from "./ack.js";
import { canonicalJson, domainHash } from "./canonical.js";
import { admitLensResult, admitValidatorResult, approve, beginValidation, requireCorrection, start, type StateRecord } from "./state.js";
import { createState, readReceipt, readState, storeRootFor, writeReceipt } from "./store.js";

const KIT = fileURLToPath(new URL("./ack-child.testkit.js", import.meta.url));
const LOCK = { lock: { timeoutMs: 30_000, pollMs: 5 } };
const NOW = "2026-11-19T10:00:00.000Z";
const BURN_AT = "2026-11-19T10:05:00.000Z";
const hex = (c: string, len: number) => c.repeat(len).slice(0, len);
const lineageOf = (n: number) => `review-${n.toString(16).padStart(16, "0")}`;
const targetOf = (n: number) => `sha256:${n.toString(16).padStart(64, "0")}`;

function scratch(): { dir: string; cleanup: () => void } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "odd-ack-")));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

interface Approved {
  lineage: string;
  target: string;
  revision: string;
  token: string;
  record: StateRecord;
}

/** Low risk: approved at start with the token (no lenses). */
async function seedLow(dir: string, n: number): Promise<Approved> {
  const out = start({
    lineageId: lineageOf(n), targetIdentity: targetOf(n), projection: "workspace", baseTree: hex("b", 40), candidateTree: hex("c", 40),
    riskLevel: "low", selectedLenses: [], originalChangedLines: 6, now: NOW,
  });
  assert.ok(out.ok && out.ackToken);
  await createState(dir, out.record, LOCK);
  return { lineage: lineageOf(n), target: targetOf(n), revision: out.record.revision, token: out.ackToken, record: out.record };
}

/** Medium risk: one lens admitted, then approved. */
async function seedMedium(dir: string, n: number): Promise<Approved> {
  const s = start({
    lineageId: lineageOf(n), targetIdentity: targetOf(n), projection: "staged", baseTree: hex("b", 40), candidateTree: hex("d", 40),
    riskLevel: "medium", selectedLenses: ["reliability"], originalChangedLines: 30, now: NOW,
  });
  assert.ok(s.ok);
  const a = admitLensResult(s.record, { now: NOW, lens: "reliability", findings: [], resultHash: `sha256:${hex("e", 64)}` });
  assert.ok(a.ok);
  const ap = approve(a.record, { now: NOW });
  assert.ok(ap.ok);
  await createState(dir, ap.record, LOCK);
  return { lineage: lineageOf(n), target: targetOf(n), revision: ap.record.revision, token: ap.ackToken, record: ap.record };
}

const stateFile = (dir: string, lineage: string) => join(storeRootFor(dir), lineage, "review-state.json");
const receiptFile = (dir: string, lineage: string) => join(storeRootFor(dir), lineage, "review-receipt.json");

async function refusal(p: Promise<unknown>): Promise<AckRefusalCode> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof AckRefusedError, `expected AckRefusedError, got ${(e as Error).stack}`);
    return e.code;
  }
  assert.fail("expected a refusal");
}

const ack = (dir: string, a: Approved, over: Record<string, unknown> = {}) =>
  acknowledgeApproved(dir, { lineage: a.lineage, target: a.target, expectedRevision: a.revision, token: a.token, ...over } as never, { ...LOCK, now: () => BURN_AT });

interface ChildResult {
  ok: boolean;
  code?: string;
  n: number;
  labels: string[];
  signal: NodeJS.Signals | null;
}

function runChildSync(dir: string, a: Approved, killAt: number, phase: "before" | "after"): ChildResult {
  const r = spawnSync(process.execPath, [KIT, dir, a.lineage, a.revision, a.target, a.token, String(killAt), phase], { encoding: "utf8" });
  const line = r.stdout.trim().split("\n").filter(Boolean).pop();
  return { ...(line ? JSON.parse(line) : { ok: false, n: 0, labels: [] }), signal: r.signal };
}

function runChild(dir: string, a: Approved): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [KIT, dir, a.lineage, a.revision, a.target, a.token, "0", "before"], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    c.stdout.on("data", (d: Buffer) => (out += d));
    c.on("error", reject);
    c.on("close", (_code, signal) => {
      const line = out.trim().split("\n").filter(Boolean).pop();
      resolve({ ...(line ? JSON.parse(line) : { ok: false, n: 0, labels: [] }), signal });
    });
  });
}

// ---- happy path ----

test("low-risk lineage approved at start burns and leaves a valid receipt", async () => {
  const s = scratch();
  try {
    const a = await seedLow(s.dir, 1);
    assert.equal(a.record.state, "approved");
    const out = await ack(s.dir, a);
    assert.equal(out.ok, true);
    const state = readState(s.dir, a.lineage);
    assert.equal(state.burned, true);
    assert.equal(state.burn_receipt, out.receipt.burn_receipt);
    const stored = readReceipt(s.dir, a.lineage);
    const v = validateReceipt(stored);
    assert.ok(v.ok, JSON.stringify(v));
    assert.deepEqual(stored, out.receipt);
    assert.equal(out.receipt.schema, RECEIPT_SCHEMA);
    assert.equal(out.receipt.lineage_id, a.lineage);
    assert.equal(out.receipt.target_identity, a.target);
    assert.equal(out.receipt.base_tree, hex("b", 40));
    assert.equal(out.receipt.candidate_tree, hex("c", 40));
    assert.equal(out.receipt.approved_revision, a.revision);
    assert.equal(out.receipt.burned_at, BURN_AT);
    assert.equal(state.updated_at, BURN_AT);
    assert.deepEqual(out.receipt.selected_lenses, []);
    assert.equal(out.receipt.risk_level, "low");
    assert.equal("paths_digest" in out.receipt, false); // not bound to the state, so not part of the receipt
    assert.equal(out.receipt.ledger_hash, a.record.ledger_hash);
    assert.equal(out.receipt.evidence_hash, a.record.evidence_hash);
    assert.deepEqual(findReceiptForTarget(s.dir, a.target), { receipt: out.receipt, truncated: false, problems: [] });
    assert.deepEqual(isTargetConsumed(s.dir, a.target), { status: "consumed", consumed: true, truncated: false, problems: [] });
  } finally {
    s.cleanup();
  }
});

test("medium-risk lineage records its lenses, projection and trees", async () => {
  const s = scratch();
  try {
    const a = await seedMedium(s.dir, 2);
    const out = await ack(s.dir, a);
    assert.deepEqual(out.receipt.selected_lenses, ["reliability"]);
    assert.equal(out.receipt.risk_level, "medium");
    assert.equal(out.receipt.projection, "staged");
    assert.equal(out.receipt.candidate_tree, hex("d", 40));
    assert.ok(validateReceipt(readReceipt(s.dir, a.lineage)).ok);
  } finally {
    s.cleanup();
  }
});

// ---- typed refusals leave state and store unchanged ----

function snapshot(dir: string, a: Approved): { state: string; receipt: boolean; files: string[] } {
  return {
    state: readFileSync(stateFile(dir, a.lineage), "utf8"),
    receipt: existsSync(receiptFile(dir, a.lineage)),
    files: readdirSync(join(storeRootFor(dir), a.lineage)).sort(),
  };
}

test("refusals: wrong token, malformed token, wrong target, stale revision change nothing", async () => {
  const s = scratch();
  try {
    const a = await seedLow(s.dir, 3);
    const before = snapshot(s.dir, a);
    assert.equal(await refusal(ack(s.dir, a, { token: hex("a", 64) })), "wrong_token");
    assert.equal(await refusal(ack(s.dir, a, { token: "nope" })), "wrong_token");
    assert.equal(await refusal(ack(s.dir, a, { token: a.token.toUpperCase() })), "wrong_token");
    assert.equal(await refusal(ack(s.dir, a, { target: targetOf(99) })), "wrong_target");
    assert.equal(await refusal(ack(s.dir, a, { expectedRevision: `sha256:${hex("1", 64)}` })), "concurrent_update");
    assert.equal(await refusal(ack(s.dir, a, { target: "x" })), "invalid_input");
    assert.deepEqual(snapshot(s.dir, a), before);
    assert.equal(isTargetConsumed(s.dir, a.target).consumed, false);
    // the genuine token still works afterwards
    assert.equal((await ack(s.dir, a)).ok, true);
  } finally {
    s.cleanup();
  }
});

test("refusal: a lineage that is not approved is not acknowledged", async () => {
  const s = scratch();
  try {
    const out = start({
      lineageId: lineageOf(4), targetIdentity: targetOf(4), projection: "workspace", baseTree: hex("b", 40), candidateTree: hex("c", 40),
      riskLevel: "medium", selectedLenses: ["risk"], originalChangedLines: 6, now: NOW,
    });
    assert.ok(out.ok);
    await createState(s.dir, out.record, LOCK);
    const a: Approved = { lineage: lineageOf(4), target: targetOf(4), revision: out.record.revision, token: hex("a", 64), record: out.record };
    const before = snapshot(s.dir, a);
    assert.equal(await refusal(ack(s.dir, a)), "not_approved");
    assert.deepEqual(snapshot(s.dir, a), before);
  } finally {
    s.cleanup();
  }
});

test("refusal: a second acknowledge is target_already_acknowledged (old or new revision) and changes nothing", async () => {
  const s = scratch();
  try {
    const a = await seedLow(s.dir, 5);
    await ack(s.dir, a);
    const before = snapshot(s.dir, a);
    const receiptBefore = readFileSync(receiptFile(s.dir, a.lineage), "utf8");
    assert.equal(await refusal(ack(s.dir, a)), "target_already_acknowledged"); // stale (pre-burn) revision
    const live = readState(s.dir, a.lineage).revision;
    assert.equal(await refusal(ack(s.dir, a, { expectedRevision: live })), "target_already_acknowledged");
    assert.equal(await refusal(ack(s.dir, a, { expectedRevision: live, token: hex("a", 64) })), "target_already_acknowledged");
    assert.deepEqual(snapshot(s.dir, a), before);
    assert.equal(readFileSync(receiptFile(s.dir, a.lineage), "utf8"), receiptBefore);
  } finally {
    s.cleanup();
  }
});

test("refusal: a corrupt pre-existing receipt blocks the burn and nothing changes", async () => {
  const s = scratch();
  try {
    const a = await seedLow(s.dir, 6);
    writeFileSync(receiptFile(s.dir, a.lineage), "{not json");
    const before = snapshot(s.dir, a);
    assert.equal(await refusal(ack(s.dir, a)), "corrupt_receipt");
    assert.deepEqual(snapshot(s.dir, a), before);
    assert.equal(readState(s.dir, a.lineage).burned, false);
  } finally {
    s.cleanup();
  }
});

test("refusal: a valid-looking receipt that disagrees with the approval is corrupt_receipt", async () => {
  const s = scratch();
  try {
    const a = await seedLow(s.dir, 7);
    const other = await seedLow(s.dir, 8);
    await ack(s.dir, other); // its receipt is valid, but for another lineage
    writeFileSync(receiptFile(s.dir, a.lineage), readFileSync(receiptFile(s.dir, other.lineage)));
    const before = snapshot(s.dir, a);
    assert.equal(await refusal(ack(s.dir, a)), "corrupt_receipt");
    assert.deepEqual(snapshot(s.dir, a), before);
  } finally {
    s.cleanup();
  }
});

// ---- receipt validation ----

test("validateReceipt rejects tampering, unknown and missing fields", async () => {
  const s = scratch();
  try {
    const a = await seedLow(s.dir, 9);
    const { receipt } = await ack(s.dir, a);
    assert.ok(validateReceipt(receipt).ok);
    assert.equal(validateReceipt({ ...receipt, risk_level: "high" }).ok, false); // hash no longer matches
    assert.equal(validateReceipt({ ...receipt, extra: 1 }).ok, false);
    const { burned_at: _b, ...missing } = receipt;
    void _b;
    assert.equal(validateReceipt(missing).ok, false);
    assert.equal(validateReceipt({ ...receipt, schema: "other-tool.review-receipt/v1" }).ok, false);
    assert.equal(validateReceipt(null).ok, false);
  } finally {
    s.cleanup();
  }
});

// ---- gates ----

test("findReceiptForTarget ignores other lineages; unknown targets and unburned approvals are not consumed", async () => {
  const s = scratch();
  try {
    const a = await seedLow(s.dir, 10);
    const b = await seedMedium(s.dir, 11);
    const c = await seedLow(s.dir, 12); // approved, never acknowledged
    const ra = await ack(s.dir, a);
    const rb = await ack(s.dir, b);
    assert.deepEqual(findReceiptForTarget(s.dir, a.target).receipt, ra.receipt);
    assert.deepEqual(findReceiptForTarget(s.dir, b.target).receipt, rb.receipt);
    assert.equal(findReceiptForTarget(s.dir, c.target).receipt, undefined);
    assert.equal(isTargetConsumed(s.dir, c.target).consumed, false);
    assert.equal(findReceiptForTarget(s.dir, targetOf(777)).receipt, undefined);
    assert.equal(isTargetConsumed(s.dir, targetOf(777)).consumed, false);
  } finally {
    s.cleanup();
  }
});

test("a valid receipt next to an UNBURNED approval is never consumption", async () => {
  const s = scratch();
  try {
    const a = await seedLow(s.dir, 13);
    const done = await seedLow(s.dir, 14);
    const { receipt } = await ack(s.dir, done);
    // forge a receipt for `a` that is internally valid (same shape) but whose state is still approved + unburned
    const { receipt_hash: _h, ...body } = { ...receipt, lineage_id: a.lineage, target_identity: a.target };
    void _h;
    await writeReceipt(s.dir, a.lineage, { ...body, receipt_hash: domainHash("review-receipt", 1, body) }, LOCK);
    assert.equal(findReceiptForTarget(s.dir, a.target).receipt, undefined);
    assert.deepEqual(isTargetConsumed(s.dir, a.target), { status: "not_consumed", consumed: false, truncated: false, problems: [] });
  } finally {
    s.cleanup();
  }
});

test("a burned state whose receipt is missing, corrupt or mismatched yields no receipt and is never plain-consumed (fail closed)", async () => {
  const s = scratch();
  try {
    const a = await seedLow(s.dir, 15);
    await ack(s.dir, a);
    writeFileSync(receiptFile(s.dir, a.lineage), "{not json");
    let r = findReceiptForTarget(s.dir, a.target);
    assert.equal(r.receipt, undefined);
    assert.equal(r.problems[0]?.code, "receipt_corrupt");
    assert.equal(isTargetConsumed(s.dir, a.target).status, "unknown");
    const other = await seedLow(s.dir, 16);
    await ack(s.dir, other);
    writeFileSync(receiptFile(s.dir, a.lineage), readFileSync(receiptFile(s.dir, other.lineage)));
    r = findReceiptForTarget(s.dir, a.target);
    assert.equal(r.receipt, undefined);
    assert.equal(r.problems[0]?.code, "receipt_mismatch");
    assert.equal(isTargetConsumed(s.dir, a.target).status, "unknown");
  } finally {
    s.cleanup();
  }
});

test("F1: a burned lineage with a missing/corrupt receipt is not plain-consumed (fail closed)", async () => {
  const s = scratch();
  try {
    const a = await seedLow(s.dir, 40);
    await ack(s.dir, a);
    writeFileSync(receiptFile(s.dir, a.lineage), "{}");
    const r = isTargetConsumed(s.dir, a.target);
    assert.notEqual(r.consumed, true);
    assert.equal(r.status, "unknown");
    assert.equal(r.problems[0]?.code, "receipt_corrupt");
    rmSync(receiptFile(s.dir, a.lineage));
    const m = isTargetConsumed(s.dir, a.target);
    assert.notEqual(m.consumed, true);
    assert.equal(m.problems[0]?.code, "receipt_missing");
  } finally {
    s.cleanup();
  }
});

test("F1: an unreadable state is never reported as plain not-consumed or consumed", async () => {
  const s = scratch();
  try {
    const a = await seedLow(s.dir, 42);
    await ack(s.dir, a);
    writeFileSync(stateFile(s.dir, a.lineage), "{garbage");
    const r = isTargetConsumed(s.dir, a.target);
    assert.equal(r.status, "unknown");
    assert.equal(r.consumed, false);
    assert.equal(r.problems[0]?.code, "state_unreadable");
    assert.equal(findReceiptForTarget(s.dir, a.target).receipt, undefined);
  } finally {
    s.cleanup();
  }
});

test("F1: a valid matching receipt stays consumed even beside an unrelated unreadable lineage", async () => {
  const s = scratch();
  try {
    const a = await seedLow(s.dir, 43);
    const b = await seedLow(s.dir, 48);
    await ack(s.dir, a);
    writeFileSync(stateFile(s.dir, b.lineage), "{garbage");
    const r = isTargetConsumed(s.dir, a.target);
    assert.equal(r.consumed, true);
    assert.equal(r.problems[0]?.code, "state_unreadable"); // still reported
    assert.equal(isTargetConsumed(s.dir, targetOf(555)).status, "unknown"); // nothing proven for another target
  } finally {
    s.cleanup();
  }
});

test("F2: a re-hashed receipt whose risk/lenses/projection/ledger disagree with the burned state is a mismatch", async () => {
  const s = scratch();
  try {
    const a = await seedMedium(s.dir, 41);
    const { receipt } = await ack(s.dir, a);
    const forge = (patch: Record<string, unknown>) => {
      const { receipt_hash: _h, ...body } = receipt;
      void _h;
      const forged = { ...body, ...patch };
      writeFileSync(receiptFile(s.dir, a.lineage), `${canonicalJson({ ...forged, receipt_hash: domainHash("review-receipt", 1, forged) })}\n`);
      return findReceiptForTarget(s.dir, a.target);
    };
    for (const patch of [
      { risk_level: "low", selected_lenses: [] as string[] },
      { risk_level: "high" },
      { selected_lenses: ["risk"] },
      { projection: "workspace" },
      { ledger_hash: `sha256:${hex("7", 64)}` },
      { evidence_hash: `sha256:${hex("7", 64)}` },
    ]) {
      const f = forge(patch);
      assert.equal(f.receipt, undefined, JSON.stringify(patch));
      assert.equal(f.problems[0]?.code, "receipt_mismatch", JSON.stringify(patch));
      assert.equal(isTargetConsumed(s.dir, a.target).status, "unknown", JSON.stringify(patch));
      assert.equal(isTargetConsumed(s.dir, a.target).consumed, false, JSON.stringify(patch));
    }
  } finally {
    s.cleanup();
  }
});

test("G1: an uncertain consumption is never truthy", async () => {
  const s = scratch();
  try {
    const a = await seedLow(s.dir, 50);
    await ack(s.dir, a);
    writeFileSync(receiptFile(s.dir, a.lineage), "{}");
    const r = isTargetConsumed(s.dir, a.target);
    assert.equal(Boolean(r.consumed), false);
    assert.equal(r.status, "unknown");
    assert.equal(r.problems[0]?.code, "receipt_corrupt");
    assert.equal(r.consumed === true, false);
  } finally {
    s.cleanup();
  }
});

test("G2: a re-hashed receipt with a foreign approved_revision is not proof", async () => {
  const s = scratch();
  try {
    const a = await seedMedium(s.dir, 51);
    const { receipt } = await ack(s.dir, a);
    assert.equal(readState(s.dir, a.lineage).approved_revision, a.revision);
    const { receipt_hash: _h, ...body } = receipt;
    void _h;
    const forged = { ...body, approved_revision: `sha256:${hex("f", 64)}` };
    writeFileSync(receiptFile(s.dir, a.lineage), `${canonicalJson({ ...forged, receipt_hash: domainHash("review-receipt", 1, forged) })}\n`);
    const f = findReceiptForTarget(s.dir, a.target);
    assert.equal(f.receipt, undefined);
    assert.equal(f.problems[0]?.code, "receipt_mismatch");
    assert.equal(isTargetConsumed(s.dir, a.target).status, "unknown");
  } finally {
    s.cleanup();
  }
});

test("truncated scan without a match is not consumed; a match inside the window is", async () => {
  const s = scratch();
  try {
    const a = await seedLow(s.dir, 0x22);
    const b = await seedLow(s.dir, 0x30);
    await ack(s.dir, b);
    const t = isTargetConsumed(s.dir, b.target, { limit: 1 });
    assert.equal(t.consumed, false);
    assert.equal(t.status, "not_consumed");
    assert.equal(t.truncated, true);
    await ack(s.dir, a);
    const m = isTargetConsumed(s.dir, a.target, { limit: 1 });
    assert.equal(m.consumed, true);
    assert.equal(m.status, "consumed");
  } finally {
    s.cleanup();
  }
});

test("F4: an invalid or unknown lineage is a typed AckRefusedError", async () => {
  const s = scratch();
  try {
    const a = await seedLow(s.dir, 44);
    assert.equal(await refusal(ack(s.dir, a, { lineage: "not-a-lineage" })), "invalid_input");
    assert.equal(await refusal(ack(s.dir, a, { lineage: lineageOf(999) })), "authority_absent");
    const empty = scratch();
    try {
      assert.equal(await refusal(ack(empty.dir, a)), "authority_absent"); // no store at all
    } finally {
      empty.cleanup();
    }
  } finally {
    s.cleanup();
  }
});

test("token edge cases (NUL, newline, non-string, another lineage's token) are wrong_token with nothing changed", async () => {
  const s = scratch();
  try {
    const a = await seedLow(s.dir, 45);
    const other = await seedLow(s.dir, 46);
    const before = snapshot(s.dir, a);
    for (const token of [`${a.token}\n`, `${a.token}\0`, `\0${a.token.slice(1)}`, `${a.token} `, 12345, null, undefined, {}, [a.token], "", other.token]) {
      assert.equal(await refusal(ack(s.dir, a, { token })), "wrong_token", JSON.stringify(token));
    }
    assert.deepEqual(snapshot(s.dir, a), before);
    assert.equal(snapshot(s.dir, other).receipt, false);
    assert.equal((await ack(s.dir, a)).ok, true);
  } finally {
    s.cleanup();
  }
});

test("the scan is bounded and reports truncation", async () => {
  const s = scratch();
  try {
    const a = await seedLow(s.dir, 17);
    await seedLow(s.dir, 18);
    await ack(s.dir, a);
    const r = findReceiptForTarget(s.dir, a.target, { maxScan: 1 });
    assert.equal(r.truncated, true);
    assert.equal(isTargetConsumed(s.dir, a.target, { limit: 1 }).truncated, true);
    assert.equal(isTargetConsumed(s.dir, a.target).truncated, false);
  } finally {
    s.cleanup();
  }
});

test("an empty store scans clean", () => {
  const s = scratch();
  try {
    assert.deepEqual(isTargetConsumed(s.dir, targetOf(1)), { status: "not_consumed", consumed: false, truncated: false, problems: [] });
  } finally {
    s.cleanup();
  }
});

// ---- budgets ----

test("budgetStatus reuses the state budget and attempt cap", async () => {
  const s = scratch();
  try {
    const a = await seedLow(s.dir, 19);
    assert.deepEqual(budgetStatus(a.record), { correctionBudget: 3, actualCorrectionLines: 0, linesRemaining: 3, attempts: 0, attemptsRemaining: 1 });
    assert.deepEqual(budgetStatus({ ...a.record, correction_attempts: 1, actual_correction_lines: 2 }), {
      correctionBudget: 3, actualCorrectionLines: 2, linesRemaining: 1, attempts: 1, attemptsRemaining: 0,
    });
  } finally {
    s.cleanup();
  }
});

// ---- concurrency ----

test("concurrent acknowledges with the same token: exactly one succeeds, one receipt, one burn", async () => {
  const s = scratch();
  try {
    const a = await seedLow(s.dir, 20);
    const results = await Promise.all(Array.from({ length: 6 }, () => runChild(s.dir, a)));
    assert.equal(results.filter((r) => r.ok).length, 1, JSON.stringify(results));
    for (const r of results.filter((x) => !x.ok)) assert.ok(["target_already_acknowledged", "concurrent_update"].includes(r.code ?? ""), JSON.stringify(r));
    const state = readState(s.dir, a.lineage);
    assert.equal(state.burned, true);
    const v = validateReceipt(readReceipt(s.dir, a.lineage));
    assert.ok(v.ok);
    assert.equal(v.receipt.burn_receipt, state.burn_receipt);
    assert.equal(readdirSync(join(storeRootFor(s.dir), a.lineage)).filter((f) => f.startsWith(".atomic-")).length, 0);
    assert.equal(isTargetConsumed(s.dir, a.target).consumed, true);
  } finally {
    s.cleanup();
  }
});

test("16 parallel processes with the same token: exactly one succeeds", async () => {
  const s = scratch();
  try {
    const a = await seedLow(s.dir, 47);
    const results = await Promise.all(Array.from({ length: 16 }, () => runChild(s.dir, a)));
    assert.equal(results.filter((r) => r.ok).length, 1, JSON.stringify(results));
    for (const r of results.filter((x) => !x.ok)) assert.ok(["target_already_acknowledged", "concurrent_update"].includes(r.code ?? ""), JSON.stringify(r));
    assert.equal(readState(s.dir, a.lineage).burned, true);
    assert.ok(validateReceipt(readReceipt(s.dir, a.lineage)).ok);
  } finally {
    s.cleanup();
  }
});

// ---- crash safety: SIGKILL at every fs call ----

test("crash at every fs call: never burned-without-receipt, never receipt-as-consumption, retry with the same token completes", async () => {
  const probeDir = scratch();
  let total: number;
  let labels: string[];
  try {
    const probe = await seedLow(probeDir.dir, 30);
    const counted = runChildSync(probeDir.dir, probe, 0, "before");
    assert.equal(counted.ok, true, JSON.stringify(counted));
    total = counted.n;
    labels = counted.labels;
  } finally {
    probeDir.cleanup();
  }
  assert.ok(total >= 8, `expected a non-trivial number of fs calls, got ${total}`);
  assert.ok(labels.some((l) => l.includes("review-receipt.json")) || labels.some((l) => l.includes(".atomic-")));

  let sawReceiptUnburned = false;
  let sawFullyBurnedBeforeRetry = false;
  let sawNothingWritten = false;
  for (let k = 1; k <= total; k++) {
    for (const phase of ["before", "after"] as const) {
      const s = scratch();
      try {
        const a = await seedLow(s.dir, 31);
        const child = runChildSync(s.dir, a, k, phase);
        // an "open" that fails (ENOENT probe of an absent receipt) throws before the "after" kill point: nothing to crash
        if (child.signal === null && phase === "after" && (labels[k - 1] ?? "").startsWith("open ")) continue;
        assert.equal(child.signal, "SIGKILL", `k=${k} ${phase} (${labels[k - 1]}): child was not killed: ${JSON.stringify(child)}`);
        const where = `k=${k} ${phase} (${labels[k - 1]})`;

        // invariants right after the crash
        const state = readState(s.dir, a.lineage);
        const hasReceipt = existsSync(receiptFile(s.dir, a.lineage));
        const consumed = isTargetConsumed(s.dir, a.target);
        if (state.burned) {
          assert.ok(hasReceipt, `${where}: burned WITHOUT a receipt`);
          assert.ok(validateReceipt(readReceipt(s.dir, a.lineage)).ok, `${where}: burned with an invalid receipt`);
          assert.equal(consumed.consumed, true, where);
          assert.equal(findReceiptForTarget(s.dir, a.target).receipt?.burn_receipt, state.burn_receipt, where);
          sawFullyBurnedBeforeRetry = true;
        } else {
          assert.equal(consumed.consumed, false, `${where}: unburned approval counted as consumed`);
          assert.equal(findReceiptForTarget(s.dir, a.target).receipt, undefined, where);
          assert.equal(state.revision, a.revision, where);
          if (hasReceipt) sawReceiptUnburned = true;
          else sawNothingWritten = true;
        }

        // retry with the same token and the revision the caller originally held
        let retry: "ok" | AckRefusalCode;
        try {
          await ack(s.dir, a);
          retry = "ok";
        } catch (e) {
          assert.ok(e instanceof AckRefusedError, `${where}: ${(e as Error).stack}`);
          retry = e.code;
        }
        if (state.burned) assert.equal(retry, "target_already_acknowledged", where);
        else assert.equal(retry, "ok", `${where}: retry did not complete`);

        const final = readState(s.dir, a.lineage);
        assert.equal(final.burned, true, where);
        const v = validateReceipt(readReceipt(s.dir, a.lineage));
        assert.ok(v.ok, where);
        assert.equal(v.receipt.burn_receipt, final.burn_receipt, where);
        assert.equal(v.receipt.approved_revision, a.revision, where);
        assert.equal(v.receipt.burned_at, final.updated_at, where);
        assert.equal(isTargetConsumed(s.dir, a.target).consumed, true, where);
        assert.equal(findReceiptForTarget(s.dir, a.target).receipt?.receipt_hash, v.receipt.receipt_hash, where);
        // and a further attempt is refused
        assert.equal(await refusal(ack(s.dir, a)), "target_already_acknowledged", where);
      } finally {
        s.cleanup();
      }
    }
  }
  assert.ok(sawReceiptUnburned, "the receipt/burn boundary was never exercised");
  assert.ok(sawFullyBurnedBeforeRetry, "no crash point landed after the burn commit");
  assert.ok(sawNothingWritten, "no crash point landed before the receipt");
});

// ---- after a correction the acknowledgement binds the validated corrected candidate ----

async function seedCorrected(dir: string, n: number): Promise<Approved & { corrected: string; original: string }> {
  const s = start({
    lineageId: lineageOf(n), targetIdentity: targetOf(n), projection: "workspace", baseTree: hex("b", 40), candidateTree: hex("c", 40),
    riskLevel: "medium", selectedLenses: ["reliability"], originalChangedLines: 8, now: NOW,
  });
  assert.ok(s.ok);
  const finding = { id: "R3-001", lens: "reliability", severity: "CRITICAL", location: "a.ts:1", claim: "boom" } as never;
  const a = admitLensResult(s.record, { now: NOW, lens: "reliability", findings: [finding], resultHash: `sha256:${hex("e", 64)}` });
  assert.ok(a.ok);
  const c = requireCorrection(a.record, { fixFindingIds: ["R3-001"], now: NOW });
  assert.ok(c.ok);
  const corrected = targetOf(n + 1000);
  const v = beginValidation(c.record, { actualCorrectionLines: 2, correctionTargetIdentity: corrected, correctionCandidateTree: hex("d", 40), now: NOW });
  assert.ok(v.ok);
  const adm = admitValidatorResult(v.record, { now: NOW, resultHash: `sha256:${hex("f", 64)}` });
  assert.ok(adm.ok);
  const ap = approve(adm.record, { now: NOW });
  assert.ok(ap.ok);
  await createState(dir, ap.record, LOCK);
  return { lineage: lineageOf(n), target: corrected, original: targetOf(n), corrected, revision: ap.record.revision, token: ap.ackToken, record: ap.record };
}

test("ack refuses an identity that is neither the target nor the validated corrected candidate; binding the corrected one consumes only it", async () => {
  const { dir, cleanup } = scratch();
  try {
    const a = await seedCorrected(dir, 21);
    const rev = a.revision;
    // the ORIGINAL (defective) candidate, and a stranger, are refused: nothing is burned
    assert.equal(await refusal(ack(dir, a, { target: a.original })), "wrong_target");
    assert.equal(await refusal(ack(dir, a, { target: targetOf(999) })), "wrong_target");
    assert.equal(readState(dir, a.lineage).revision, rev);
    assert.equal(readState(dir, a.lineage).burned, false);
    assert.equal(existsSync(receiptFile(dir, a.lineage)), false);

    const done = await ack(dir, a);
    assert.equal(done.receipt.target_identity, a.corrected);
    assert.equal(done.receipt.candidate_tree, hex("d", 40));
    assert.equal(done.record.target_identity, a.corrected);
    assert.equal(isTargetConsumed(dir, a.corrected).status, "consumed");
    assert.equal(isTargetConsumed(dir, a.original).status, "not_consumed");
    assert.equal(isTargetConsumed(dir, a.original).consumed, false);
    assert.equal(findReceiptForTarget(dir, a.original).receipt, undefined);
    assert.equal(findReceiptForTarget(dir, a.corrected).receipt?.lineage_id, a.lineage);
  } finally {
    cleanup();
  }
});
