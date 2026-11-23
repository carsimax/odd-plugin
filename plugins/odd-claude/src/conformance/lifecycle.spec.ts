// U16 (S1, S4): the review lifecycle end to end over the REAL stdio MCP server (`dist-test/mcp/review-server.js` as a child process) with a FAKE
// `claude` first on its PATH (the real binary is never run), and the delivery gate / Stop reminder of every final state with RDD on and off.
// The risk tiers come from the real classifier: a dependency change is high (4 lenses), a deletion medium (1 lens), documentation low (0).
// Every tool result the server returns is checked by the envelope conformance (envelopes.testkit.ts) as it goes by.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runHook } from "../hooks/run.js";
import { isTargetConsumed } from "../review/ack.js";
import { REVIEW_TOOL_NAMES } from "../review/consent.js";
import { UNREVIEWED_DELIVERY_NOTICE } from "../review/gate.js";
import { setReviewMode } from "../review/mode.js";
import { listLineages, readState } from "../review/store.js";
import { conformToolBody } from "./envelopes.testkit.js";
import {
  commitHigh, commitLow, commitMedium, errorCode, good, lineageDirs, makeFakeReviewer, makeWorld, RANGE, SEVERE, withClient, type FakeReviewer, type McpClient, type World,
} from "./harness.testkit.js";
import { acknowledge, approveThroughCapture, correctAndCommit, decline, relay, runToOutcome, status, takeCollect, grant } from "./scenarios.testkit.js";

const seen = new Set<string>();
const toolsUsed = new Set<string>();

async function scenario(
  prep: (w: World) => void,
  findings: Record<string, unknown[]> | undefined,
  fn: (c: McpClient, w: World, fake: FakeReviewer) => Promise<void>,
): Promise<void> {
  const w = makeWorld();
  const fake = makeFakeReviewer(findings !== undefined ? { findings } : {});
  try {
    prep(w);
    await withClient({ fake, world: w }, async (c) => {
      c.observe = (tool, r) => {
        toolsUsed.add(tool);
        seen.add(conformToolBody(tool, r.isError, r.body));
      };
      await fn(c, w, fake);
    });
  } finally {
    w.cleanup();
    fake.cleanup();
  }
}

// ---- the delivery notice and the Stop reminder, as Claude Code would invoke them ----

const on = (w: World): void => void setReviewMode("enable", "global", w.repo, { dataDir: w.data });
const off = (w: World): void => void setReviewMode("disable", "global", w.repo, { dataDir: w.data });
const SILENT = { exitCode: 0, stdout: "" };
const gate = (w: World, command = "git push") => runHook("PreToolUse", JSON.stringify({ session_id: "s1", cwd: w.repo, tool_name: "Bash", tool_input: { command } }), { dataDir: w.data });
const stop = (w: World, session = "s1") => runHook("Stop", JSON.stringify({ session_id: session, cwd: w.repo, stop_hook_active: false }), { dataDir: w.data });

/** The delivery hook never denies: an unreviewed candidate yields the one advisory notice and nothing else. */
function noticed(r: { exitCode: number; stdout: string }, why: string): void {
  assert.equal(r.exitCode, 0, why);
  assert.deepEqual(JSON.parse(r.stdout), { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: UNREVIEWED_DELIVERY_NOTICE } }, why);
  assert.doesNotMatch(r.stdout, /permission|"decision"/i, why);
}
/** Nothing is shown (the command just runs). */
const allowed = (r: { exitCode: number; stdout: string }, why: string): void => assert.deepEqual(r, SILENT, why);

const consumed = (w: World, target: string) => isTargetConsumed(w.commonDir, target).status;

// ---------------------------------------------------------------------------------------------

test("low risk (0 lenses): approved at once, acknowledged once, consumed; no reviewer ever runs", async () => {
  await scenario(commitLow, undefined, async (c, w, fake) => {
    on(w);
    allowed(gate(w), "a low-risk range is not due: nothing to review");
    const s = await relay(c);
    assert.deepEqual([s.action, s.state, s.risk_level, s.lenses_required, s.selected_lenses], ["closed", "approved", "low", false, []]);
    assert.equal(consumed(w, s.target_identity), "not_consumed", "approved is not consumed until acknowledged");

    // a client that lost the token can only stop
    const lost = await status(c);
    assert.deepEqual([lost.next_transition.kind, lost.next_transition.reason_code], ["stop", "acknowledgement_token_unavailable"]);
    const offered = await status(c, { acknowledgement: s.acknowledgement });
    assert.deepEqual([offered.next_transition.kind, offered.next_transition.reason_code], ["execute", "approved_acknowledgement_required"]);

    const ack = await acknowledge(c, w, s.acknowledgement);
    assert.equal(ack.receipt.risk_level, "low");
    assert.deepEqual(ack.receipt.selected_lenses, []);
    assert.equal(consumed(w, s.target_identity), "consumed");
    const done = await status(c);
    assert.deepEqual([done.next_transition.kind, done.next_transition.reason_code], ["stop", "target_already_acknowledged"]);
    // a second acknowledgement of the burned lineage is refused and burns nothing
    assert.equal(errorCode(await c.call("review_acknowledge_approved", { cwd: w.repo, ...s.acknowledgement })), "target_already_acknowledged");
    assert.equal(lineageDirs(w.commonDir).length, 1);
    assert.equal(fake.calls().length, 0, "low risk spawns no reviewer");
    allowed(gate(w), "consumed");
    off(w);
    allowed(gate(w), "RDD off");
  });
});

test("medium risk (1 lens): consent, capture of the single slot, acknowledge; the notice does not need it", async () => {
  await scenario(commitMedium, undefined, async (c, w, fake) => {
    on(w);
    const consent = await relay(c);
    assert.deepEqual([consent.action, consent.risk_level], ["consent_required", "medium"]);
    assert.equal(lineageDirs(w.commonDir).length, 0, "relaying consent creates no authority");
    const started = await grant(c, w, consent);
    assert.deepEqual([started.action, started.state, started.selected_lenses.length], ["created", "reviewing", 1]);

    const st = await status(c);
    assert.equal(st.next_transition.collect.command, "review_capture", "a single slot is admitted by review_capture");
    assert.equal(st.next_transition.collect.inputs.length, 1);
    const { forecast, captured } = await takeCollect(c, st.next_transition);
    assert.equal(forecast.reviewers.length, 1);
    assert.equal(fake.calls().length, 1, "only the acknowledged call ran a reviewer (the forecast ran none)");
    assert.equal(captured.capture.state, "approved");
    assert.equal(consumed(w, consent.target_identity), "not_consumed");
    allowed(gate(w), "medium risk is not due for delivery review");

    const ack = await acknowledge(c, w, captured.capture.acknowledgement);
    assert.equal(ack.receipt.risk_level, "medium");
    assert.equal(consumed(w, consent.target_identity), "consumed");
    assert.equal(readState(w.commonDir, started.lineage_id).burned, true);
    allowed(gate(w), "consumed");
  });
});

test("high risk (4 lenses): group capture; the notice shows until the review is acknowledged, then not; a new commit is a new candidate", async () => {
  await scenario(commitHigh, undefined, async (c, w, fake) => {
    // RDD off (default): silent whatever the review state is
    allowed(gate(w), "RDD off, unreviewed high risk");
    allowed(stop(w), "RDD off: no Stop reminder");
    on(w);
    noticed(gate(w), "unreviewed high risk");
    assert.equal(gate(w, "git status").stdout, "", "only deliveries show the notice");
    const reminder = stop(w);
    assert.equal(reminder.exitCode, 0);
    const block = JSON.parse(reminder.stdout);
    assert.deepEqual(Object.keys(block).sort(), ["decision", "reason"]);
    assert.equal(block.decision, "block");
    for (const t of block.reason.match(/\breview_[a-z_]+\b/g) ?? []) assert.ok((REVIEW_TOOL_NAMES as readonly string[]).includes(t), `the Stop reason names ${t}`);
    allowed(stop(w), "the Stop reminder fires once per session and candidate");

    const { consent, started, collect, captured, ack } = await approveThroughCapture(c, w);
    assert.equal(started.selected_lenses.length, 4);
    assert.equal(collect.collect.command, "review_capture_group");
    assert.equal(collect.collect.inputs.length, 4);
    assert.deepEqual(fake.calls().map((x) => x.lens).sort(), ["readability", "reliability", "resilience", "risk"]);
    assert.ok(fake.calls().every((x) => x.role === "lens" && x.args.includes("--tools") && !x.args.includes("--bare")), "isolated reviewer arguments");
    assert.equal(captured.capture.pending_lenses.length, 0);
    assert.doesNotMatch(gate(w).stdout, /permission/, "approved but not yet acknowledged never denies");

    await acknowledge(c, w, ack);
    assert.equal(consumed(w, consent.target_identity), "consumed");
    allowed(gate(w), "acknowledged");
    allowed(gate(w, "gh pr create --fill"), "acknowledged, gh pr create");
    allowed(stop(w, "s2"), "consumed: nothing to remind");

    commitHigh(w, "9.9.9");
    noticed(gate(w), "a new commit is a new candidate");
    off(w);
    allowed(gate(w), "RDD off again");
    assert.equal(lineageDirs(w.commonDir).length, 1);
  });
});

test("correction: a severe finding asks for a fix; the validator approves the CORRECTED identity; the original is never consumed", async () => {
  await scenario(commitHigh, { risk: [SEVERE] }, async (c, w, fake) => {
    on(w);
    const consent = await relay(c);
    const started = await grant(c, w, consent);
    const original = started.target_identity;
    const asked = await runToOutcome(c, { lineage_id: started.lineage_id });
    assert.equal(asked.outcome, "input-required");
    assert.deepEqual(asked.correction.allowed_paths, ["a.txt"]);
    assert.equal(asked.correction.attempts_remaining, 1);
    assert.equal(readState(w.commonDir, started.lineage_id).state, "correction_required");
    assert.doesNotMatch(gate(w).stdout, /permission/, "a severe finding never denies a delivery");

    // a second START of the same candidate while the correction is pending must not open another lineage
    assert.equal(errorCode(await c.call("review_start", { ...RANGE })), "correction_lineage_pending");
    assert.equal(lineageDirs(w.commonDir).length, 1);

    correctAndCommit(w);
    assert.doesNotMatch(gate(w).stdout, /permission/, "corrected but not yet validated never denies");
    const closed = await runToOutcome(c, { lineage_id: started.lineage_id });
    assert.equal(closed.outcome, "closed");
    assert.notEqual(closed.target_identity, original);
    assert.equal(closed.acknowledgement.target_identity, closed.target_identity);
    assert.equal(fake.calls().filter((x) => x.role === "validator").length, 1);
    assert.equal(consumed(w, closed.target_identity), "consumed");
    assert.equal(consumed(w, original), "not_consumed");
    allowed(gate(w), "the corrected range is the approved identity");
    assert.equal(lineageDirs(w.commonDir).length, 1);
    const lineage = readState(w.commonDir, started.lineage_id);
    assert.equal(lineage.target_identity, closed.target_identity);
    assert.equal(lineage.burned, true);
    // the history is unchanged: going back to the reviewed (uncorrected) range is not consumed
    const after = await status(c);
    assert.deepEqual([after.next_transition.kind, after.next_transition.reason_code], ["stop", "target_already_acknowledged"]);
  });
});

test("decline: the explicit decline of that exact candidate silences the notice; the next candidate asks again", async () => {
  await scenario(commitHigh, undefined, async (c, w) => {
    on(w);
    noticed(gate(w), "unreviewed");
    const consent = await relay(c);
    const out = await decline(c, w, consent);
    assert.deepEqual([out.outcome, out.reason_code, out.risk_level], ["declined", "consent_declined", "high"]);
    assert.equal(lineageDirs(w.commonDir).length, 0, "a decline creates no lineage");
    const st = await status(c);
    assert.deepEqual([st.next_transition.kind, st.next_transition.reason_code], ["stop", "consent_declined"]);
    assert.equal(consumed(w, consent.target_identity), "not_consumed");
    allowed(gate(w), "declined");
    allowed(stop(w), "declined: no reminder");

    commitHigh(w, "5.5.5");
    noticed(gate(w), "a new candidate is not covered by the old decline");
    const again = await relay(c);
    assert.equal(again.action, "consent_required");
    assert.notEqual(again.target_identity, consent.target_identity);
    off(w);
    allowed(gate(w), "RDD off");
  });
});

test("consent is the human's: relaying twice, a wrong binding or a moved candidate never grants anything", async () => {
  await scenario(commitHigh, undefined, async (c, w) => {
    const consent = await relay(c);
    const again = await relay(c);
    assert.deepEqual(again, consent, "the consent envelope is stable");
    // a granted answer whose binding belongs to another candidate is refused and records nothing
    const bad = await c.call("review_answer_consent", { cwd: w.repo, ...RANGE, target_identity: consent.target_identity, consent: "granted", consent_binding: `sha256:${"0".repeat(64)}` });
    assert.equal(errorCode(bad), "binding_drift");
    assert.equal(lineageDirs(w.commonDir).length, 0);
    // review_run only relays consent; it never answers it
    const r = good(await c.call("review_run", { ...RANGE }));
    assert.equal(r.outcome, "consent-required");
    assert.equal(lineageDirs(w.commonDir).length, 0);
    assert.deepEqual(listLineages(w.commonDir).lineages, []);
  });
});

test("coverage: every tool of the server and every envelope family was exercised and conformed", () => {
  assert.deepEqual([...toolsUsed].sort(), ["review_acknowledge_approved", "review_answer_consent", "review_capture", "review_capture_group", "review_run", "review_start", "review_status"]);
  for (const k of ["consent", "start", "start-outcome", "status", "ack", "run:captured", "run:forecast", "run:closed", "run:input-required", "run:consent-required", "error"]) {
    assert.ok(seen.has(k), `no ${k} envelope was conformance-checked (saw ${[...seen].sort().join(", ")})`);
  }
  assert.ok(REVIEW_TOOL_NAMES.length >= 10);
});
