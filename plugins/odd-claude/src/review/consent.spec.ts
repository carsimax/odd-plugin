import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildConsentEnvelope, declinePathFor, consentBinding, INVOCATION_PREFIX, offPathCommand, readDecline, recordDecline, REVIEW_TOOL_NAMES, reviewCommand, shellQuote } from "./consent.js";

const ID = `sha256:${"ab".repeat(32)}`;
const tmp = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "odd-consent-")));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};

test("envelope has exactly two ordered choices whose invocations differ only by the answer", () => {
  const e = buildConsentEnvelope({
    cwd: "/my repo",
    targetIdentity: ID,
    projection: "staged",
    riskLevel: "medium",
    changedFiles: 2,
    changedLines: 9,
    riskEvidence: ["x"],
    targetArgs: ["--target", "current-changes"],
  });
  assert.equal(e.choices.length, 2);
  assert.equal(e.choices[0].invocation.replace(/ --consent granted$/, ""), e.choices[1].invocation.replace(/ --consent declined$/, ""));
  assert.match(e.choices[0].invocation, /--cwd '\/my repo' /);
  assert.equal(e.agent, "claude-code");
  assert.match(e.headline, /^A review can check/);
});

test("shellQuote leaves safe words alone and escapes quotes", () => {
  assert.equal(shellQuote("main"), "main");
  assert.equal(shellQuote("a b"), "'a b'");
  assert.equal(shellQuote("it's"), `'it'\\''s'`);
});

test("decline records are keyed by candidate, atomic and first-wins", () => {
  const t = tmp();
  try {
    assert.equal(readDecline(t.dir, ID), undefined);
    const rec = { target_identity: ID, projection: "workspace" as const, risk_level: "high" as const, declined_at: "2026-01-01T00:00:00Z" };
    const first = recordDecline(t.dir, rec);
    assert.equal(first.created, true);
    assert.equal(first.path, declinePathFor(t.dir, ID));
    assert.equal(recordDecline(t.dir, { ...rec, declined_at: "2027-01-01T00:00:00Z" }).created, false);
    assert.equal(readDecline(t.dir, ID)!.declined_at, "2026-01-01T00:00:00Z");
    assert.equal(readDecline(t.dir, `sha256:${"cd".repeat(32)}`), undefined);
    assert.deepEqual(readdirSync(join(t.dir, "odd-plugin", "declines")), [`${"ab".repeat(32)}.json`]);
  } finally {
    t.cleanup();
  }
});

test("a malformed identity is rejected and a symlinked declines dir is refused", () => {
  const t = tmp();
  try {
    assert.throws(() => declinePathFor(t.dir, "../../etc/passwd"), RangeError);
    mkdirSync(join(t.dir, "odd-plugin"));
    mkdirSync(join(t.dir, "elsewhere"));
    symlinkSync(join(t.dir, "elsewhere"), join(t.dir, "odd-plugin", "declines"));
    assert.throws(() => recordDecline(t.dir, { target_identity: ID, projection: "workspace", risk_level: "high", declined_at: "2026-01-01T00:00:00Z" }));
    assert.equal(existsSync(join(t.dir, "elsewhere", `${"ab".repeat(32)}.json`)), false);
  } finally {
    t.cleanup();
  }
});

test("invocations name the final review tools and the real off switch (no placeholders)", () => {
  assert.deepEqual([...REVIEW_TOOL_NAMES], [
    "review_assess", "review_inspect", "review_start", "review_status", "review_answer_consent", "review_capture", "review_capture_group",
    "review_acknowledge_approved", "review_complete", "review_run",
  ]);
  assert.equal(INVOCATION_PREFIX, "review_answer_consent");
  assert.equal(reviewCommand("start"), "review_start");
  assert.equal(reviewCommand("complete"), "review_complete");
  assert.equal(reviewCommand("acknowledge-approved"), "review_acknowledge_approved");
  const e = buildConsentEnvelope({
    cwd: "/r", targetIdentity: ID, projection: "workspace", riskLevel: "high", changedFiles: 1, changedLines: 1, riskEvidence: [], targetArgs: ["--target", "current-changes"],
  });
  for (const c of e.choices) assert.ok(c.invocation.startsWith("review_answer_consent --contract "), c.invocation);
  assert.equal(e.off_path.command, offPathCommand());
  assert.match(e.off_path.command, /^node .*[\\/]dist[\\/]cli[\\/]review-mode\.js disable$/);
  assert.ok(e.off_path.note.includes(e.off_path.command));
  assert.equal(JSON.stringify(e).includes("<plugin>"), false);
  assert.equal(JSON.stringify(e).includes("review.js"), false);
});

test("the off switch honours CLAUDE_PLUGIN_ROOT and quotes it", () => {
  assert.equal(offPathCommand({ CLAUDE_PLUGIN_ROOT: "/opt/odd root" }), "node '/opt/odd root/dist/cli/review-mode.js' disable");
  assert.match(offPathCommand({}), /review-mode\.js disable$/);
});

test("invocations: projection only for current-changes, a consent binding for the target and lens selection, lenses as a comma list", () => {
  const input = { cwd: "/r", targetIdentity: ID, projection: "workspace" as const, riskLevel: "high" as const, changedFiles: 1, changedLines: 1, riskEvidence: [] as string[] };
  const cc = buildConsentEnvelope({ ...input, targetArgs: ["--target", "current-changes"], lenses: { names: ["risk", "reliability"], reason: "why" } });
  const bd = buildConsentEnvelope({ ...input, targetArgs: ["--target", "base-diff", "--base-ref", "main", "--committed-only", "true"] });
  assert.match(cc.choices[0].invocation, / --projection workspace /);
  assert.equal(bd.choices[0].invocation.includes("--projection"), false);
  assert.match(cc.choices[0].invocation, / --lenses risk,reliability --lenses-reason why /);
  const binding = consentBinding(ID, { names: ["risk", "reliability"], reason: "why" });
  assert.match(binding, /^sha256:[0-9a-f]{64}$/);
  assert.ok(cc.choices[0].invocation.includes(` --consent-binding ${binding} --consent granted`));
  assert.equal(consentBinding(ID, { names: ["review-risk", "review-reliability"], reason: "why" }), binding, "the review- prefix is not part of the binding");
  assert.notEqual(consentBinding(ID, { names: ["risk"], reason: "why" }), binding);
  assert.notEqual(consentBinding(ID, { names: ["risk", "reliability"], reason: "other" }), binding);
  assert.notEqual(consentBinding(ID), binding);
  assert.notEqual(consentBinding(`sha256:${"cd".repeat(32)}`, { names: ["risk", "reliability"], reason: "why" }), binding);
});
