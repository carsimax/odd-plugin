// U16 (S4): kill -9 of the REAL MCP server process at every filesystem call of START, of a reviewer capture and of the acknowledgement
// (before each call, plus right after the last one), then a restart. Invariants that must hold after EVERY crash:
//   - the authority is readable: every lineage with a state record decodes; a lineage directory without one is an abandoned START (inert);
//   - the receipt is written first and is inert while the state is unburned: `consumed` only with a burned state AND a valid receipt bound to it;
//   - never two burns, never two lineages for one candidate, never a state that is both burned and receipt-less;
//   - debris is only what a dead writer leaves (`.atomic-*` temp files, dead LOCK directories): the next mutation of the same lineage sweeps
//     the temps and the next lock acquisition reclaims the dead locks; nothing else appears.
// The server is started with kill-preload.testkit.js (node:fs patched in that process only); the world is copied from a template per crash point
// (the real `claude` is never run: a fake first on PATH).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runHook } from "../hooks/run.js";
import { isTargetConsumed, validateReceipt } from "../review/ack.js";
import { setReviewMode } from "../review/mode.js";
import { start } from "../review/state.js";
import { createState, readReceipt, readState, storeRootFor, StoreNotFoundError } from "../review/store.js";
import {
  commitHigh, commitLow, commitMedium, consentArgs, copyWorld, errorCode, good, lineageDirs, lit, makeFakeReviewer, makeWorld, McpClient, RANGE, storeFiles, withClient,
  type FakeReviewer, type World,
} from "./harness.testkit.js";
import { acknowledge, approveThroughCapture, grant, relay, runToOutcome, status, type Ack } from "./scenarios.testkit.js";

// ---- crash driver ----

/** The delivery hook never denies: whatever the review state, the output has no permission decision (a notice at most). */
function assertNeverDenies(stdout: string, why: string): void {
  assert.doesNotMatch(stdout, /permission|"decision"/i, why);
}


interface Crash {
  w: World;
  died: boolean;
  signal: NodeJS.Signals | null;
  /** The call's result when the server survived it. */
  result?: { isError: boolean; body: any };
  n: number;
  labels: string[];
}

/** A tool call with its arguments; `cwd` is filled in per copy. */
interface Call {
  tool: string;
  args: Record<string, unknown>;
}

async function crashAt(template: World, fake: FakeReviewer, call: Call, k: number, phase: "before" | "after", prepare?: (w: World) => Promise<void>): Promise<Crash> {
  const w = copyWorld(template);
  if (prepare) await prepare(w);
  const arm = join(w.dir, "arm");
  const log = join(w.dir, "kill-log.json");
  const c = new McpClient({
    fake, world: w, preload: true,
    env: { ODD_KILL_CD: w.commonDir, ODD_KILL_ARM: arm, ODD_KILL_LOG: log, ODD_KILL_AT: String(k), ODD_KILL_PHASE: phase },
  });
  await c.initialize();
  writeFileSync(arm, ""); // from here every fs call under the common dir counts
  const r = await c.callOrDie(call.tool, { ...call.args, cwd: w.repo });
  let signal: NodeJS.Signals | null = null;
  if (r === "died") signal = (await c.exitInfo()).signal;
  else assert.equal(await c.close(), 0);
  const counted = existsSync(log) ? JSON.parse(readFileSync(log, "utf8")) : { n: 0, labels: [] };
  return { w, died: r === "died", signal, ...(r !== "died" ? { result: r } : {}), n: counted.n, labels: counted.labels };
}

async function pool<T, R>(items: T[], size: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

// ---- invariants ----

const DEBRIS = /(^|\/)(review-state\.json|review-receipt\.json|\.atomic-\d+-[0-9a-f]+|owner\.json|declines\/[0-9a-f]+\.json)$/;

interface Authority {
  /** Lineages that have a decodable state record. */
  lineages: string[];
  abandoned: string[];
  burned: string[];
  receipts: string[];
}

/** Asserts the invariants that hold at ANY instant and returns what is there. */
function assertAuthority(w: World, why: string): Authority {
  const out: Authority = { lineages: [], abandoned: [], burned: [], receipts: [] };
  for (const f of storeFiles(w.commonDir)) assert.match(f, DEBRIS, `${why}: unexpected file ${f}`);
  const targets = new Map<string, number>();
  for (const id of lineageDirs(w.commonDir)) {
    let rec;
    try {
      rec = readState(w.commonDir, id);
    } catch (e) {
      assert.ok(e instanceof StoreNotFoundError, `${why}: ${id} is unreadable: ${(e as Error).message}`);
      assert.equal(existsSync(join(w.commonDir, "odd-plugin", "review-transactions", "v2", id, "review-receipt.json")), false, `${why}: a receipt without a state in ${id}`);
      out.abandoned.push(id);
      continue;
    }
    out.lineages.push(id);
    targets.set(rec.target_identity, (targets.get(rec.target_identity) ?? 0) + 1);
    let receipt: Record<string, unknown> | undefined;
    try {
      receipt = readReceipt(w.commonDir, id);
    } catch {
      receipt = undefined;
    }
    const valid = receipt !== undefined && validateReceipt(receipt).ok;
    if (receipt !== undefined) out.receipts.push(id);
    const consumed = isTargetConsumed(w.commonDir, rec.target_identity).status;
    if (rec.burned === true) {
      out.burned.push(id);
      assert.ok(valid, `${why}: ${id} is burned without a valid receipt`);
      assert.equal(receipt!.target_identity, rec.target_identity, `${why}: the receipt is bound to the burned target`);
      assert.equal(receipt!.approved_revision, rec.approved_revision, `${why}: the receipt is bound to the approved revision`);
      assert.equal(consumed, "consumed", `${why}: burned with a valid receipt is consumed`);
    } else {
      assert.notEqual(consumed, "consumed", `${why}: ${id} is not burned, so it is never consumed (a receipt alone is inert)`);
    }
  }
  assert.ok(out.burned.length <= 1, `${why}: double burn ${out.burned}`);
  for (const [t, n] of targets) assert.equal(n, 1, `${why}: ${n} lineages for ${t}`);
  return out;
}

/**
 * After the recovery step: no temp of a dead writer survives in a lineage that has a state, and a lock left in the store root belongs to a
 * dead process (a read-only restart does not take the lock, so it does not reclaim it; the next mutation does, see lock.spec). With
 * `mutated`, the restart took the store lock and so nothing may be left at all.
 */
function assertSwept(w: World, why: string, mutated: boolean): void {
  const root = join(w.commonDir, "odd-plugin", "review-transactions", "v2");
  for (const id of lineageDirs(w.commonDir)) {
    const files = readdirSync(join(root, id));
    if (files.includes("review-state.json") && mutated) assert.deepEqual(files.filter((f) => f.startsWith(".atomic-")), [], `${why}: temps left in ${id}`);
  }
  assertDeadLocks(root, why, mutated);
}

/** Locks in `dir` (empty when `mustBeEmpty`) are only the leftovers of dead processes. */
function assertDeadLocks(dir: string, why: string, mustBeEmpty: boolean): void {
  const locks = existsSync(dir) ? readdirSync(dir).filter((n) => n.startsWith("LOCK")) : [];
  if (mustBeEmpty) assert.deepEqual(locks, [], `${why}: a lock is left in ${dir}`);
  for (const l of locks) {
    const owner = JSON.parse(readFileSync(join(dir, l, "owner.json"), "utf8")) as { pid: number };
    assert.throws(() => process.kill(owner.pid, 0), /ESRCH|kill/, `${why}: ${l} is held by a live process ${owner.pid}`);
  }
}

// ---- templates ----

interface Template {
  w: World;
  fake: FakeReviewer;
  call: Call;
  ack?: Ack;
  /** Runs on every copied world before the server starts (copies lose mtimes, so backdating happens here). */
  prepare?: (w: World) => Promise<void>;
}

const cleanups: (() => void)[] = [];
const keep = <T extends { cleanup: () => void }>(t: T): T => {
  cleanups.push(() => t.cleanup());
  return t;
};

/** A candidate with a consent envelope relayed: the call that answers it. */
async function startTemplate(): Promise<Template> {
  const w = keep(makeWorld());
  const fake = keep(makeFakeReviewer());
  commitHigh(w);
  let args: Record<string, unknown> = {};
  await withClient({ fake, world: w }, async (c) => {
    args = { ...RANGE, ...consentArgs(await relay(c), "granted") };
  });
  return { w, fake, call: { tool: "review_answer_consent", args } };
}

/** A medium-risk lineage under review, its one reviewer slot forecast: the call that runs and admits it. */
async function captureTemplate(): Promise<Template> {
  const w = keep(makeWorld());
  const fake = keep(makeFakeReviewer());
  commitMedium(w);
  let call: Call = { tool: "", args: {} };
  await withClient({ fake, world: w }, async (c) => {
    await grant(c, w, await relay(c));
    const t = (await status(c)).next_transition;
    const args = lit(t.collect.arguments);
    const forecast = good(await c.call(t.collect.command, args));
    call = { tool: t.collect.command, args: { ...args, reviewer_run_acknowledged: true, reviewer_run_binding: forecast.reviewer_run_binding } };
  });
  return { w, fake, call };
}

/** A low-risk lineage approved and waiting for its acknowledgement. */
async function ackTemplate(): Promise<Template> {
  const w = keep(makeWorld());
  const fake = keep(makeFakeReviewer());
  commitLow(w);
  let ack: Ack | undefined;
  await withClient({ fake, world: w }, async (c) => {
    ack = (await relay(c)).acknowledgement;
  });
  return { w, fake, call: { tool: "review_acknowledge_approved", args: { ...ack } }, ack: ack! };
}

const POINTS_CAP = 80;

/** Every `before` point 1..n and `after` the last call, run four at a time. */
async function sweep(t: Template, check: (c: Crash, k: number, phase: string) => Promise<void>): Promise<{ n: number; killed: number; labels: string[] }> {
  const count = await crashAt(t.w, t.fake, t.call, 0, "before", t.prepare);
  try {
    assert.equal(count.died, false);
    assert.equal(count.result?.isError, false, JSON.stringify(count.result));
    assert.ok(count.n >= 3 && count.n <= POINTS_CAP, `fs calls under the common dir: ${count.n}`);
    const points: [number, "before" | "after"][] = [...Array.from({ length: count.n }, (_, i) => [i + 1, "before"] as [number, "before"]), [count.n, "after"]];
    let killed = 0;
    await pool(points, 4, async ([k, phase]) => {
      const c = await crashAt(t.w, t.fake, t.call, k, phase, t.prepare);
      try {
        assert.equal(c.died, true, `k=${k} ${phase} (${count.labels[k - 1]}): the server was not killed`);
        assert.equal(c.signal, "SIGKILL");
        killed++;
        await check(c, k, `${phase} #${k} ${count.labels[k - 1]}`);
      } finally {
        c.w.cleanup();
      }
    });
    return { n: count.n, killed, labels: count.labels };
  } finally {
    count.w.cleanup();
  }
}

test.after(() => {
  for (const f of cleanups) f();
});

// ---- the sweeps ----

test("kill -9 mid-START at every fs call: the authority stays readable, the restart converges on exactly one lineage", { timeout: 120_000 }, async () => {
  const t = await startTemplate();
  const r = await sweep(t, async (c, k, why) => {
    const before = assertAuthority(c.w, why);
    assert.ok(before.lineages.length <= 1, `${why}: ${before.lineages.length} lineages after one START`);
    assert.deepEqual(before.burned, []);
    // restart: the same answer again
    await withClient({ fake: t.fake, world: c.w }, async (cl) => {
      const again = good(await cl.call(t.call.tool, { ...t.call.args, cwd: c.w.repo }));
      assert.ok(["created", "replayed"].includes(again.action), `${why}: ${again.action}`);
      assert.equal(again.state, "reviewing");
      assert.equal(again.selected_lenses.length, 4);
      const st = await status(cl);
      assert.equal(st.next_transition.reason_code, "reviewer_results_required");
      // an abandoned directory is reported, never hidden and never mistaken for a lineage
      const inspected = good(await cl.call("review_inspect", { cwd: c.w.repo }));
      assert.equal(inspected.lineages.length, 1, `${why}: inspect lists the one real lineage`);
      assert.equal(inspected.unreadable.length, before.abandoned.length, `${why}: inspect reports each abandoned directory`);
    });
    const after = assertAuthority(c.w, `${why} (restarted)`);
    assert.equal(after.lineages.length, 1, `${why}: exactly one lineage after the restart`);
    assert.equal(after.abandoned.length, before.abandoned.length, `${why}: the restart does not multiply abandoned directories`);
    assertSwept(c.w, why, false);
    assertDeadLocks(join(c.w.commonDir, "odd-plugin", "start"), `${why} (start lock)`, false);
    // an abandoned directory holds at most the temp file of the dead writer, never a state
    for (const id of after.abandoned) {
      const files = readdirSync(join(c.w.commonDir, "odd-plugin", "review-transactions", "v2", id));
      assert.ok(files.every((f) => f.startsWith(".atomic-")), `${why}: ${id} holds ${files}`);
    }
  });
  assert.equal(r.killed, r.n + 1);
});

// ---- the abandoned-lineage sweep ----

const OLD_AT = new Date(Date.now() - 2 * 3_600_000);
const SWEEP_ID = (n: number): string => `review-${n.toString(16).padStart(16, "0")}`;
const SWEEP_TEMP = ".atomic-4242-0123456789abcdef";
const SWEPT = { empty: [SWEEP_ID(1), SWEEP_ID(2)], temps: [SWEEP_ID(3), SWEEP_ID(4)] };
const LIVE = SWEEP_ID(0xfeed);

/** A live lineage plus four old abandoned directories (two empty, two with a temp), everything backdated two hours. */
async function plantAbandoned(w: World): Promise<void> {
  const out = start({
    lineageId: LIVE, targetIdentity: `sha256:${"7".repeat(64)}`, projection: "workspace", baseTree: "b".repeat(40), candidateTree: "c".repeat(40),
    riskLevel: "medium", selectedLenses: ["reliability"], originalChangedLines: 8, now: "2026-11-19T10:00:00.000Z",
  });
  assert.equal(out.ok, true);
  await createState(w.commonDir, (out as { ok: true; record: Parameters<typeof createState>[1] }).record);
  const root = storeRootFor(w.commonDir);
  for (const id of [...SWEPT.empty, ...SWEPT.temps]) mkdirSync(join(root, id), { mode: 0o700 });
  for (const id of SWEPT.temps) writeFileSync(join(root, id, SWEEP_TEMP), "x");
  for (const id of [...SWEPT.empty, ...SWEPT.temps, LIVE]) {
    for (const f of readdirSync(join(root, id))) utimesSync(join(root, id, f), OLD_AT, OLD_AT);
    utimesSync(join(root, id), OLD_AT, OLD_AT);
  }
}

test("kill -9 mid-sweep at every fs call of START: no live lineage is lost, abandoned dirs are only ever removed whole or left as they were, the restart completes", { timeout: 140_000 }, async () => {
  const t = await startTemplate();
  t.prepare = plantAbandoned;
  const liveBytes = new Map<string, string>();
  const r = await sweep(t, async (c, k, why) => {
    const root = join(c.w.commonDir, "odd-plugin", "review-transactions", "v2");
    const before = assertAuthority(c.w, why);
    assert.ok(before.lineages.includes(LIVE), `${why}: the live lineage is gone`);
    const live = readFileSync(join(root, LIVE, "review-state.json"), "utf8");
    liveBytes.set(live, why);
    assert.equal(liveBytes.size, 1, `${why}: the live state changed`);
    for (const id of SWEPT.empty) assert.deepEqual(existsSync(join(root, id)) ? readdirSync(join(root, id)) : [], [], `${why}: ${id}`);
    for (const id of SWEPT.temps) {
      const files = existsSync(join(root, id)) ? readdirSync(join(root, id)) : [];
      assert.ok(files.every((f) => f === SWEEP_TEMP), `${why}: ${id} holds ${files}`);
    }
    await withClient({ fake: t.fake, world: c.w }, async (cl) => {
      const again = good(await cl.call(t.call.tool, { ...t.call.args, cwd: c.w.repo }));
      assert.ok(["created", "replayed"].includes(again.action), `${why}: ${again.action}`);
      assert.equal(again.state, "reviewing");
    });
    const after = assertAuthority(c.w, `${why} (restarted)`);
    assert.equal(after.lineages.length, 2, `${why}: the live lineage and exactly one new one`);
    assert.ok(after.lineages.includes(LIVE));
    assert.equal(readFileSync(join(root, LIVE, "review-state.json"), "utf8"), live, `${why}: the live state is untouched by the restart`);
    // the restart may only REPLAY the lineage the crashed START already made (no createState, so no sweep): leftovers are as before
    for (const id of SWEPT.empty) assert.deepEqual(existsSync(join(root, id)) ? readdirSync(join(root, id)) : [], [], `${why}: ${id} after the restart`);
    for (const id of SWEPT.temps) assert.ok((existsSync(join(root, id)) ? readdirSync(join(root, id)) : []).every((f) => f === SWEEP_TEMP), `${why}: ${id} after the restart`);
  });
  assert.equal(r.killed, r.n + 1);
  assert.ok(r.labels.some((l) => l.startsWith("unlink ")) && r.labels.some((l) => l.startsWith("rmdir ")), `the sweep's unlink/rmdir were crashed: ${r.labels}`);
});

test("kill -9 mid-capture at every fs call: no burn, no receipt, the restart reaches approval (or an explicit lost-token stop) and never consumes twice", { timeout: 140_000 }, async () => {
  const t = await captureTemplate();
  const outcomes = new Set<string>();
  const r = await sweep(t, async (c, k, why) => {
    const before = assertAuthority(c.w, why);
    assert.deepEqual([before.burned, before.receipts], [[], []], `${why}: a capture never burns nor writes a receipt`);
    assert.equal(before.lineages.length, 1);
    let closed = false;
    await withClient({ fake: t.fake, world: c.w }, async (cl) => {
      const out = await runToOutcome(cl, { lineage_id: before.lineages[0], cwd: c.w.repo });
      closed = out.outcome === "closed";
      outcomes.add(out.outcome === "stopped" ? `stopped:${out.reason_code}` : out.outcome);
      if (out.outcome === "closed") assert.equal(out.acknowledgement.burned, true);
      else assert.deepEqual([out.outcome, out.reason_code], ["stopped", "acknowledgement_token_unavailable"], `${why}: ${JSON.stringify(out).slice(0, 300)}`);
    });
    const after = assertAuthority(c.w, `${why} (restarted)`);
    assert.equal(after.lineages.length, 1);
    assert.deepEqual(after.burned.length, closed ? 1 : 0, `${why}: burned exactly when the restart closed the review`);
    assertSwept(c.w, why, closed); // a lost-token stop is read-only: the dead lock stays until the next mutation
  });
  assert.equal(r.killed, r.n + 1);
  assert.ok(outcomes.has("closed"), `no crash point restarted to a closed review (${[...outcomes]})`);
  assert.ok(outcomes.has("stopped:acknowledgement_token_unavailable"), `no crash point landed after the approval commit (${[...outcomes]})`);
});

test("kill -9 mid-acknowledge at every fs call: receipt first, burn second; a retry with the same token completes; never two burns", { timeout: 120_000 }, async () => {
  const t = await ackTemplate();
  const states = new Set<string>();
  const r = await sweep(t, async (c, k, why) => {
    const before = assertAuthority(c.w, why);
    assert.equal(before.lineages.length, 1);
    states.add(`${before.receipts.length ? "receipt" : "no-receipt"}/${before.burned.length ? "burned" : "unburned"}`);
    assert.ok(!(before.burned.length > 0 && before.receipts.length === 0));
    await withClient({ fake: t.fake, world: c.w }, async (cl) => {
      const retry = await cl.call(t.call.tool, { ...t.call.args, cwd: c.w.repo });
      if (before.burned.length === 0) assert.equal(retry.isError, false, `${why}: ${JSON.stringify(retry.body)}`);
      else assert.equal(errorCode(retry), "target_already_acknowledged", `${why}: an already burned lineage is refused`);
    });
    const after = assertAuthority(c.w, `${why} (retried)`);
    assert.deepEqual([after.lineages.length, after.burned.length, after.receipts.length], [1, 1, 1], `${why}: exactly one burn and one receipt`);
    assertSwept(c.w, why, true);
  });
  assert.equal(r.killed, r.n + 1);
  // the sweep crossed every phase of the ordering
  assert.deepEqual([...states].sort(), ["no-receipt/unburned", "receipt/burned", "receipt/unburned"]);
});

test("kill -9 BETWEEN the receipt write and the burn: the receipt is inert (not consumed, the delivery hook never denies), the same-token retry completes", { timeout: 120_000 }, async () => {
  const w = keep(makeWorld());
  const fake = keep(makeFakeReviewer());
  commitHigh(w);
  let ack: Ack | undefined;
  let target = "";
  await withClient({ fake, world: w }, async (c) => {
    const a = await approveThroughCapture(c, w);
    ack = a.ack;
    target = a.started.target_identity;
  });
  const call: Call = { tool: "review_acknowledge_approved", args: { ...ack } };
  const count = await crashAt(w, fake, call, 0, "before");
  count.w.cleanup();
  const renames = count.labels.flatMap((l, i) => (l.startsWith("rename ") ? [i + 1] : []));
  assert.equal(renames.length, 2, `the acknowledgement renames twice (receipt, then state): ${count.labels.join(" | ")}`);
  const crashed = await crashAt(w, fake, call, renames[0]!, "after"); // right after the receipt reached its final name
  try {
    assert.equal(crashed.died, true);
    const a = assertAuthority(crashed.w, "between receipt and burn");
    assert.deepEqual([a.receipts.length, a.burned.length], [1, 0], "the receipt is there, the state is not burned");
    assert.equal(isTargetConsumed(crashed.w.commonDir, target).status, "not_consumed");
    setReviewMode("enable", "global", crashed.w.repo, { dataDir: crashed.w.data });
    const push = () => runHook("PreToolUse", JSON.stringify({ session_id: "s", cwd: crashed.w.repo, tool_name: "Bash", tool_input: { command: "git push" } }), { dataDir: crashed.w.data });
    assertNeverDenies(push().stdout, "an inert receipt never makes the delivery hook deny");
    await withClient({ fake, world: crashed.w }, async (c) => {
      const done = await acknowledge(c, crashed.w, ack!);
      assert.equal(done.burned, true);
    });
    assert.equal(isTargetConsumed(crashed.w.commonDir, target).status, "consumed");
    assert.deepEqual(push(), { exitCode: 0, stdout: "" }, "the completed acknowledgement silences the notice");
    const end = assertAuthority(crashed.w, "completed");
    assert.deepEqual([end.lineages.length, end.burned.length, end.receipts.length], [1, 1, 1]);
  } finally {
    crashed.w.cleanup();
  }
});

test("the receipt check is what makes `consumed`: a burned lineage whose receipt was removed or altered is never consumed (the delivery hook never denies)", async () => {
  const w = keep(makeWorld());
  const fake = keep(makeFakeReviewer());
  commitHigh(w);
  let target = "";
  let lineage = "";
  await withClient({ fake, world: w }, async (c) => {
    const a = await approveThroughCapture(c, w);
    await acknowledge(c, w, a.ack);
    target = a.started.target_identity;
    lineage = a.started.lineage_id;
  });
  const d = copyWorld(w);
  try {
    setReviewMode("enable", "global", d.repo, { dataDir: d.data });
    const push = () => runHook("PreToolUse", JSON.stringify({ session_id: "s", cwd: d.repo, tool_name: "Bash", tool_input: { command: "git push" } }), { dataDir: d.data });
    assert.deepEqual(push(), { exitCode: 0, stdout: "" });
    const receiptFile = join(d.commonDir, "odd-plugin", "review-transactions", "v2", lineage, "review-receipt.json");
    const original = readFileSync(receiptFile, "utf8");
    writeFileSync(receiptFile, original.replace(/"candidate_tree":"[0-9a-f]{40}"/, `"candidate_tree":"${"e".repeat(40)}"`));
    assert.notEqual(isTargetConsumed(d.commonDir, target).status, "consumed", "an altered receipt does not verify");
    assertNeverDenies(push().stdout, "altered receipt");
    rmSync(receiptFile);
    assert.notEqual(isTargetConsumed(d.commonDir, target).status, "consumed", "no receipt, no consumption");
    assertNeverDenies(push().stdout, "no receipt");
  } finally {
    d.cleanup();
  }
});
