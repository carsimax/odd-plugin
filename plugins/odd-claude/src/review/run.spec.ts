import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, linkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isTargetConsumed } from "./ack.js";
import { lensArtifactSubject, treeDiffPaths } from "./artifact.js";
import { beginCorrectionValidation, captureLensResult, captureValidatorResult, planCorrection } from "./capture.js";
import { readDecline } from "./consent.js";
import { REVIEWER_ARGUMENTS, reviewerArguments, type RunOutcome, type RunReviewerOptions } from "./runner.js";
import { useProfile } from "../lib/profiles.js";
import { makeFakeClaude, type FakeRecord } from "./runner-fake.testkit.js";
import { runReview, validateReviewerOptions, MAX_TRANSITIONS, type ReviewRunInput, type ReviewRunOutcome, type RunDeps } from "./run.js";
import { startReview, type RiskAssessment, type RiskAssessor } from "./start.js";
import { listLineages, readReceipt, readState } from "./store.js";
import { reviewStatus } from "./status.js";
import { digestPaths, freezeSnapshot, resolveRepository, snapshotIdentity } from "./snapshot.js";
import { createHash } from "node:crypto";
import { beginValidation, stateRevision, type StateRecord } from "./state.js";
import { storeRootFor, updateState } from "./store.js";

// ---- helpers: real temp git repos, removed in teardown ----

const ENV = (() => {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.toUpperCase().startsWith("GIT_")) env[k] = v;
  env.GIT_CONFIG_NOSYSTEM = "1";
  return env;
})();

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.invalid", "-c", "commit.gpgsign=false", "-C", cwd, ...args], { env: ENV, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

interface Repo {
  repo: string;
  commonDir: string;
  cleanup: () => void;
}

function makeRepo(opts: { dirty?: boolean } = {}): Repo {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "odd-run-")));
  const repo = join(dir, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "one\ntwo\nthree\n");
  writeFileSync(join(repo, "b.txt"), "bee\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  if (opts.dirty !== false) writeFileSync(join(repo, "a.txt"), "one\nTWO\nthree\nfour\nfive\n");
  return { repo, commonDir: realpathSync(join(repo, ".git")), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function withRepo(fn: (r: Repo) => Promise<void>, opts: { dirty?: boolean } = {}): Promise<void> {
  const r = makeRepo(opts);
  try {
    await fn(r);
  } finally {
    r.cleanup();
  }
}

const assess = (level: RiskAssessment["level"]): RiskAssessor => () => ({
  level,
  reasons: [{ code: level === "low" ? "non_executable_only" : "shell_source", ...(level === "low" ? {} : { signal: "shell_process", path: "a.txt" }) }],
  evidence: level === "low" ? [] : ["shell scripting in a.txt"],
});

const SEVERE = {
  location: "a.txt:1",
  severity: "CRITICAL",
  claim: "a.txt breaks on empty input",
  proof_refs: ["a.txt:1 reads the first line unchecked"],
  evidence_class: "deterministic",
  causal_disposition: "introduced",
};

// ---- a fake reviewer: answers from the prompt's own echo line, records every call ----

interface Calls {
  prompts: string[];
  opts: RunReviewerOptions[];
  roles: string[];
  finished: string[];
  active: number;
  maxActive: number;
}
interface FakeCfg {
  /** Findings returned per lens (default none). */
  findings?: Record<string, unknown[]>;
  delayMs?: Record<string, number>;
  /** Raw stdout override per lens/role key. */
  raw?: Record<string, string>;
  /** Typed runner failure per key. */
  fail?: Record<string, RunOutcome>;
  /** Runs inside the reviewer call, before it answers. */
  during?: () => void;
  /** The targeted validator finds the blocking findings unresolved. */
  validatorFails?: boolean;
}

function section(prompt: string, name: string): string {
  const m = new RegExp(`<<<ODD-DATA-\\w+ ${name}>>>\\n([\\s\\S]*?)\\n<<<END-ODD-DATA-\\w+ ${name}>>>`).exec(prompt);
  assert.ok(m, `prompt has a ${name} section`);
  return m[1]!;
}

function fakeRunner(cfg: FakeCfg = {}): { calls: Calls; runner: NonNullable<RunDeps["runner"]> } {
  const calls: Calls = { prompts: [], opts: [], roles: [], finished: [], active: 0, maxActive: 0 };
  const runner: NonNullable<RunDeps["runner"]> = async (prompt, opts) => {
    calls.prompts.push(prompt);
    calls.opts.push(opts);
    const head = /Role: (\w+)(?:, lens: (\w+))?\./.exec(prompt)!;
    const role = head[1]!;
    const lens = head[2];
    const key = lens ?? role;
    calls.roles.push(key);
    calls.active++;
    calls.maxActive = Math.max(calls.maxActive, calls.active);
    try {
      cfg.during?.();
      const delay = cfg.delayMs?.[key];
      if (delay !== undefined) await new Promise((r) => setTimeout(r, delay));
      if (cfg.fail?.[key]) return cfg.fail[key]!;
      if (cfg.raw?.[key] !== undefined) return { ok: true, stdout: cfg.raw[key]!, elapsedMs: 1 };
      const echo = JSON.parse(/Echo these fields verbatim in the result: (\{.*\})/.exec(prompt)![1]!) as Record<string, unknown>;
      let result: Record<string, unknown>;
      if (role === "lens") {
        result = { ...echo, inspection: { status: "completed", paths: section(prompt, "changed-path-manifest").split("\n") }, findings: cfg.findings?.[lens!] ?? [], evidence: ["reviewed the complete candidate scope"] };
      } else if (role === "refuter") {
        const ids = (JSON.parse(section(prompt, "findings")) as Array<{ id: string }>).map((f) => f.id);
        result = { ...echo, results: ids.map((id) => ({ finding_id: id, outcome: "refuted", proof_refs: ["a.txt:1 handles the empty input"] })) };
      } else {
        result = { ...echo, original_criteria: { passed: cfg.validatorFails !== true, evidence: ["a.txt:1 now guards the empty input"] }, correction_regression: { passed: true, evidence: ["the regression test passes"] }, follow_ups: [] };
      }
      return { ok: true, stdout: `\`\`\`json\n${JSON.stringify(result)}\n\`\`\`\n`, elapsedMs: 1 };
    } finally {
      calls.active--;
      calls.finished.push(key);
    }
  };
  return { calls, runner };
}

function is<K extends ReviewRunOutcome["outcome"]>(o: ReviewRunOutcome, kind: K): Extract<ReviewRunOutcome, { outcome: K }> {
  assert.equal(o.outcome, kind, JSON.stringify(o).slice(0, 800));
  return o as Extract<ReviewRunOutcome, { outcome: K }>;
}

const input = (r: Repo, over: Partial<ReviewRunInput> = {}): ReviewRunInput => ({ cwd: r.repo, ...over });

/** The user's own consent answer: only a direct START call (never the run loop) can grant it. */
async function grant(r: Repo, level: RiskAssessment["level"]): Promise<string> {
  const s = await startReview({ cwd: r.repo, target: { kind: "current-changes" }, consent: "granted", riskAssessor: assess(level) });
  assert.equal(s.status, "started");
  return (s as Extract<typeof s, { status: "started" }>).result.lineage_id;
}

/** forecast, then the acknowledged run for exactly that binding. */
async function forecastThenRun(r: Repo, lineageId: string, deps: RunDeps, over: Partial<ReviewRunInput> = {}): Promise<{ forecast: Extract<ReviewRunOutcome, { outcome: "forecast" }>; done: ReviewRunOutcome }> {
  const forecast = is(await runReview(input(r, { lineageId, ...over }), deps), "forecast");
  const done = await runReview(input(r, { lineageId, ...over, reviewerRunAcknowledged: true, reviewerRunBinding: forecast.reviewer_run_binding }), deps);
  return { forecast, done };
}

const stateOf = (r: Repo, lineage: string) => readState(r.commonDir, lineage);

// ---- low risk, not due, already acknowledged ----

test("low risk: approved immediately with 0 lenses, acknowledged, no reviewer runs", async () => {
  await withRepo(async (r) => {
    const { calls, runner } = fakeRunner();
    const out = is(await runReview(input(r), { riskAssessor: assess("low"), runner }), "closed");
    assert.equal(out.risk_level, "low");
    assert.equal(calls.prompts.length, 0);
    const rec = stateOf(r, out.lineage_id!);
    assert.deepEqual(rec.selected_lenses, []);
    assert.equal(rec.burned, true);
    assert.equal(isTargetConsumed(r.commonDir, out.target_identity!).consumed, true);
    assert.equal((out.acknowledgement as { outcome: string }).outcome, "acknowledged");
    // a second run on the same candidate is a typed stop, never a second review
    const again = is(await runReview(input(r), { riskAssessor: assess("low"), runner }), "stopped");
    assert.equal(again.reason_code, "target_already_acknowledged");
    assert.equal(again.terminal, true);
    assert.equal(listLineages(r.commonDir).lineages.length, 1);
  });
});

test("not-due: nothing changed, nothing created", async () => {
  await withRepo(async (r) => {
    const { calls, runner } = fakeRunner();
    const out = is(await runReview(input(r), { riskAssessor: assess("high"), runner }), "not-due");
    assert.equal(calls.prompts.length, 0);
    assert.deepEqual(listLineages(r.commonDir).lineages, []);
    assert.equal(out.lineage_id, undefined);
  }, { dirty: false });
});

// ---- consent ----

test("consent-required: the envelope comes back untouched; the run never answers it", async () => {
  await withRepo(async (r) => {
    const { calls, runner } = fakeRunner();
    const out = is(await runReview(input(r), { riskAssessor: assess("medium"), runner }), "consent-required");
    const expected = await startReview({ cwd: r.repo, target: { kind: "current-changes" }, consent: "relay", riskAssessor: assess("medium") });
    assert.equal(expected.status, "consent_required");
    assert.deepEqual(out.envelope, (expected as { envelope: unknown }).envelope);
    assert.equal(calls.prompts.length, 0);
    assert.deepEqual(listLineages(r.commonDir).lineages, []);
    assert.equal(readDecline(r.commonDir, out.envelope.target_identity), undefined);
  });
});

test("resume by lineageId after consent was GRANTED: forecast first, then the acknowledged run closes it", async () => {
  await withRepo(async (r) => {
    const lineage = await grant(r, "medium");
    const { calls, runner } = fakeRunner();
    const deps: RunDeps = { riskAssessor: assess("medium"), runner };
    const before = stateOf(r, lineage);
    const forecast = is(await runReview(input(r, { lineageId: lineage }), deps), "forecast");
    assert.equal(forecast.lineage_id, lineage);
    assert.deepEqual(forecast.reviewers.map((s) => [s.role, s.lens]), [["lens", "risk"]]);
    assert.match(forecast.reviewer_run_binding, /^sha256:[0-9a-f]{64}$/);
    assert.equal(forecast.forecast.steps[0].reason_code, "reviewer_results_required");
    assert.equal(stateOf(r, lineage).revision, before.revision, "the forecast changed nothing");
    assert.equal(calls.prompts.length, 0);
    const done = await runReview(input(r, { lineageId: lineage, reviewerRunAcknowledged: true, reviewerRunBinding: forecast.reviewer_run_binding }), deps);
    const closed = is(done, "closed");
    assert.equal(closed.lineage_id, lineage);
    assert.equal(calls.prompts.length, 1, "exactly one reviewer ran, once");
    assert.equal(stateOf(r, lineage).burned, true);
  });
});

test("resume after consent DECLINED: a typed stop, nothing runs", async () => {
  await withRepo(async (r) => {
    const s = await startReview({ cwd: r.repo, target: { kind: "current-changes" }, consent: "declined", riskAssessor: assess("medium") });
    assert.equal(s.status, "declined");
    const { calls, runner } = fakeRunner();
    const out = is(await runReview(input(r), { riskAssessor: assess("medium"), runner }), "stopped");
    assert.equal(out.reason_code, "consent_declined");
    assert.equal(out.terminal, false);
    assert.equal(calls.prompts.length, 0);
    const unknown = is(await runReview(input(r, { lineageId: "review-0123456789abcdef" }), { riskAssessor: assess("medium"), runner }), "blocked");
    assert.equal(unknown.code, "unknown_lineage");
  });
});

// ---- forecast gate ----

test("forecast: reviewers run only for the acknowledged binding; a missing or different binding runs nothing", async () => {
  await withRepo(async (r) => {
    const lineage = await grant(r, "medium");
    const { calls, runner } = fakeRunner();
    const deps: RunDeps = { riskAssessor: assess("medium"), runner };
    const rev = stateOf(r, lineage).revision;
    const noBinding = is(await runReview(input(r, { lineageId: lineage, reviewerRunAcknowledged: true }), deps), "blocked");
    assert.equal(noBinding.code, "invalid_input");
    const wrong = is(await runReview(input(r, { lineageId: lineage, reviewerRunAcknowledged: true, reviewerRunBinding: `sha256:${"0".repeat(64)}` }), deps), "binding-drift");
    assert.equal(wrong.field, "forecast");
    const unackWithBinding = is(await runReview(input(r, { lineageId: lineage, reviewerRunBinding: `sha256:${"0".repeat(64)}` }), deps), "forecast");
    assert.ok(unackWithBinding.reviewer_run_binding);
    assert.equal(calls.prompts.length, 0);
    assert.equal(stateOf(r, lineage).revision, rev);
  });
});

test("forecast carries the validated model and effort", async () => {
  await withRepo(async (r) => {
    const lineage = await grant(r, "medium");
    const { calls, runner } = fakeRunner();
    const deps: RunDeps = { riskAssessor: assess("medium"), runner };
    const { forecast, done } = await forecastThenRun(r, lineage, deps, { model: "sonnet", effort: "high", timeoutMs: 12345 });
    assert.equal(forecast.model, "sonnet");
    assert.equal(forecast.effort, "high");
    is(done, "closed");
    assert.equal(calls.opts[0]!.model, "sonnet");
    assert.equal(calls.opts[0]!.effort, "high");
    assert.equal(calls.opts[0]!.timeoutMs, 12345);
  });
});

// ---- model / effort validation ----

test("validateReviewerOptions: only the families and efforts the runner forwards", () => {
  assert.equal(validateReviewerOptions({}), null);
  assert.equal(validateReviewerOptions({ model: "opus", effort: "max" }), null);
  assert.equal(validateReviewerOptions({ model: "haiku" }), null);
  assert.equal(validateReviewerOptions({ model: "sonnet", effort: "" }), null);
  for (const bad of [{ model: "gpt-4" }, { model: "" }, { model: "claude-sonnet-5-5" }, { effort: "high" }, { model: "sonnet", effort: "ultra" }, { model: "haiku", effort: "high" }, { model: "sonnet; rm", effort: "low" }]) {
    assert.equal(typeof validateReviewerOptions(bad), "string", JSON.stringify(bad));
  }
});

test("an invalid model or effort is refused before anything starts or runs", async () => {
  await withRepo(async (r) => {
    const { calls, runner } = fakeRunner();
    for (const bad of [{ model: "gpt-4" }, { model: "sonnet", effort: "ultra" }, { effort: "high" }, { model: "haiku", effort: "low" }]) {
      const out = is(await runReview(input(r, bad), { riskAssessor: assess("low"), runner }), "blocked");
      assert.equal(out.code, "invalid_option", JSON.stringify(bad));
    }
    assert.equal(calls.prompts.length, 0);
    assert.deepEqual(listLineages(r.commonDir).lineages, [], "no lineage was created");
  });
});

// ---- group: ordering and concurrency ----

test("group: out-of-order completion is admitted in provider (canonical) order; concurrency is bounded", async () => {
  await withRepo(async (r) => {
    const lineage = await grant(r, "high");
    const { calls, runner } = fakeRunner({ delayMs: { risk: 120, resilience: 80, readability: 40, reliability: 1 } });
    const deps: RunDeps = { riskAssessor: assess("high"), runner, concurrency: 4 };
    const { forecast, done } = await forecastThenRun(r, lineage, deps);
    assert.deepEqual(forecast.reviewers.map((s) => s.lens), ["risk", "resilience", "readability", "reliability"]);
    is(done, "closed");
    assert.deepEqual(calls.finished, ["reliability", "readability", "resilience", "risk"], "the reviewers really finished in reverse");
    assert.deepEqual(stateOf(r, lineage).admitted_role_results.map((e) => e.lens), ["risk", "resilience", "readability", "reliability"]);
    assert.equal(calls.maxActive, 4);
  });
  await withRepo(async (r) => {
    const lineage = await grant(r, "high");
    const { calls, runner } = fakeRunner({ delayMs: { risk: 30, resilience: 30, readability: 30, reliability: 30 } });
    const { done } = await forecastThenRun(r, lineage, { riskAssessor: assess("high"), runner });
    is(done, "closed");
    assert.equal(calls.maxActive, 2, "default bound is 2");
  });
});

// ---- failed / malformed reviewer output never reaches acknowledgement ----

test("malformed reviewer output: blocked, no acknowledgement, no replay; earlier slots stay admitted", async () => {
  await withRepo(async (r) => {
    const lineage = await grant(r, "high");
    const { calls, runner } = fakeRunner({ raw: { resilience: "I could not review this, sorry" } });
    const { done } = await forecastThenRun(r, lineage, { riskAssessor: assess("high"), runner, concurrency: 4 });
    const out = is(done, "blocked");
    assert.equal(out.code, "reviewer_output_invalid");
    assert.equal(out.slot?.lens, "resilience");
    assert.equal(out.detail, "no_json");
    assert.equal(out.status_after?.kind, "collect", "status was re-checked once");
    assert.deepEqual([...calls.roles].sort(), ["readability", "reliability", "resilience", "risk"], "each slot ran once: no replay");
    const rec = stateOf(r, lineage);
    assert.deepEqual(rec.admitted_role_results.map((e) => e.lens), ["risk"], "only the slot before the failure was admitted");
    assert.equal(rec.state, "reviewing");
    assert.equal(rec.burned, false);
    assert.equal(existsSync(join(r.commonDir, "odd-plugin", "review-transactions", "v2", lineage, "review-receipt.json")), false);
    assert.equal(isTargetConsumed(r.commonDir, rec.target_identity).consumed, false);
  });
});

test("a typed runner failure is blocked as reviewer_failed; nothing is admitted or acknowledged", async () => {
  await withRepo(async (r) => {
    const lineage = await grant(r, "medium");
    const fail: RunOutcome = { ok: false, code: "timeout", message: "the reviewer exceeded its bound", elapsedMs: 5 };
    const { calls, runner } = fakeRunner({ fail: { risk: fail } });
    const { done } = await forecastThenRun(r, lineage, { riskAssessor: assess("medium"), runner });
    const out = is(done, "blocked");
    assert.equal(out.code, "reviewer_failed");
    assert.equal(out.detail, "timeout");
    assert.equal(calls.prompts.length, 1);
    const rec = stateOf(r, lineage);
    assert.equal(rec.admitted_role_results.length, 0);
    assert.equal(rec.burned, false);
  });
});

test("an output that echoes another subject is refused at capture: blocked capture_refused, no acknowledgement", async () => {
  await withRepo(async (r) => {
    const lineage = await grant(r, "medium");
    const wrong = JSON.stringify({ subject_hash: `sha256:${"1".repeat(64)}`, inspection: { status: "completed", paths: ["a.txt"] }, findings: [], evidence: ["x"] });
    const { runner } = fakeRunner({ raw: { risk: wrong } });
    const { done } = await forecastThenRun(r, lineage, { riskAssessor: assess("medium"), runner });
    const out = is(done, "blocked");
    assert.equal(out.code, "reviewer_output_invalid");
    assert.equal(out.detail, "binding_mismatch");
    assert.equal(stateOf(r, lineage).burned, false);
  });
});

// ---- binding drift ----

test("binding-drift mid-run: the candidate changes during the reviewer call", async () => {
  await withRepo(async (r) => {
    const { calls, runner } = fakeRunner({ during: () => writeFileSync(join(r.repo, "a.txt"), "completely\ndifferent\n") });
    const deps: RunDeps = { riskAssessor: assess("low"), runner };
    // low risk never runs a reviewer, so use a granted lineage and drive it with the same candidate
    const lineage = await grant(r, "medium");
    const rev = stateOf(r, lineage).revision;
    const forecast = is(await runReview(input(r, { lineageId: lineage }), deps), "forecast");
    const out = is(await runReview(input(r, { lineageId: lineage, reviewerRunAcknowledged: true, reviewerRunBinding: forecast.reviewer_run_binding }), deps), "binding-drift");
    assert.equal(calls.prompts.length, 1, "the reviewer did run on the frozen trees");
    assert.equal(out.field, "target");
    const rec = stateOf(r, lineage);
    assert.equal(rec.revision, rev, "nothing captured");
    assert.equal(rec.admitted_role_results.length, 0);
    assert.equal(rec.burned, false);
  });
});

test("a lineage whose candidate moved before the run is a binding-drift (not a fresh review)", async () => {
  await withRepo(async (r) => {
    const lineage = await grant(r, "medium");
    writeFileSync(join(r.repo, "a.txt"), "moved\non\n");
    const { calls, runner } = fakeRunner();
    const out = is(await runReview(input(r, { lineageId: lineage }), { riskAssessor: assess("medium"), runner }), "binding-drift");
    assert.equal(out.field, "target");
    assert.equal(calls.prompts.length, 0);
  });
});

// ---- bounded loop and cancellation ----

test("transition-limit: the loop is bounded", async () => {
  assert.equal(MAX_TRANSITIONS, 24);
  await withRepo(async (r) => {
    const { runner } = fakeRunner();
    const out = is(await runReview(input(r), { riskAssessor: assess("low"), runner, maxTransitions: 1 }), "transition-limit");
    assert.equal(out.limit, 1);
    assert.equal(out.transitions, 1);
  });
});

test("cancelled: before the run, and while a reviewer is running; nothing is captured", async () => {
  await withRepo(async (r) => {
    const { calls, runner } = fakeRunner();
    const ac = new AbortController();
    ac.abort();
    const early = is(await runReview(input(r, { signal: ac.signal }), { riskAssessor: assess("low"), runner }), "cancelled");
    assert.equal(early.lineage_id, undefined);
    assert.deepEqual(listLineages(r.commonDir).lineages, []);
    assert.equal(calls.prompts.length, 0);

    const lineage = await grant(r, "medium");
    const ac2 = new AbortController();
    const mid = fakeRunner({ during: () => ac2.abort(), delayMs: { risk: 20 } });
    const deps: RunDeps = { riskAssessor: assess("medium"), runner: mid.runner };
    const forecast = is(await runReview(input(r, { lineageId: lineage }), deps), "forecast");
    const out = is(await runReview(input(r, { lineageId: lineage, signal: ac2.signal, reviewerRunAcknowledged: true, reviewerRunBinding: forecast.reviewer_run_binding }), deps), "cancelled");
    assert.equal(out.lineage_id, lineage);
    const rec = stateOf(r, lineage);
    assert.equal(rec.admitted_role_results.length, 0);
    assert.equal(rec.burned, false);
  });
});

// ---- input-required and resume after the correction ----

test("input-required: severe finding opens the correction plan; resume after the correction validates and closes", async () => {
  await withRepo(async (r) => {
    const lineage = await grant(r, "medium");
    const { calls, runner } = fakeRunner({ findings: { risk: [SEVERE] } });
    const deps: RunDeps = { riskAssessor: assess("medium"), runner };
    const first = await forecastThenRun(r, lineage, deps);
    const plan = is(first.done, "input-required");
    assert.equal(plan.lineage_id, lineage);
    assert.deepEqual(plan.correction.findings.map((f) => f.id), ["R1-1"]);
    assert.deepEqual(plan.correction.allowed_paths, ["a.txt"]);
    assert.equal(stateOf(r, lineage).state, "correction_required");
    assert.equal(stateOf(r, lineage).burned, false);

    // nothing corrected yet: the same plan again
    assert.equal(is(await runReview(input(r, { lineageId: lineage }), deps), "input-required").correction.revision, plan.correction.revision);

    // the parent corrects the candidate; the resume validates it
    writeFileSync(join(r.repo, "a.txt"), "ONE\nTWO\nthree\nfour\nfive\n");
    const forecast = is(await runReview(input(r, { lineageId: lineage }), deps), "forecast");
    assert.equal(forecast.reviewers[0]!.role, "validator");
    assert.equal(stateOf(r, lineage).state, "correction_required", "the forecast wrote nothing");
    assert.equal(calls.prompts.length, 1, "the forecast ran no reviewer");
    const closed = is(await runReview(input(r, { lineageId: lineage, reviewerRunAcknowledged: true, reviewerRunBinding: forecast.reviewer_run_binding }), deps), "closed");
    assert.equal(closed.lineage_id, lineage);
    assert.deepEqual(calls.roles, ["risk", "validator"]);
    assert.equal(stateOf(r, lineage).burned, true);
  });
});

test("a correction outside the frozen findings is refused; the lineage stays in correction_required", async () => {
  await withRepo(async (r) => {
    const lineage = await grant(r, "medium");
    const { calls, runner } = fakeRunner({ findings: { risk: [SEVERE] } });
    const deps: RunDeps = { riskAssessor: assess("medium"), runner };
    is((await forecastThenRun(r, lineage, deps)).done, "input-required");
    const rev = stateOf(r, lineage).revision;
    writeFileSync(join(r.repo, "b.txt"), "changed elsewhere\n");
    const out = is(await runReview(input(r, { lineageId: lineage }), deps), "blocked");
    assert.equal(out.code, "correction_refused");
    assert.equal(out.detail, "correction_out_of_scope");
    assert.equal(stateOf(r, lineage).revision, rev);
    assert.equal(stateOf(r, lineage).state, "correction_required");
    assert.equal(calls.prompts.length, 1);
  });
});

test("an optional refuter that status offers is run, admitted, and the review settles", async () => {
  await withRepo(async (r) => {
    const lineage = await grant(r, "medium");
    const rec = stateOf(r, lineage);
    const subject = lensArtifactSubject(r.commonDir, rec, "risk")!;
    const held = await captureLensResult(
      r.commonDir, lineage, rec.revision,
      { lens: "risk", subject, result: { subject_hash: subject.subject_hash, inspection: { status: "completed", paths: treeDiffPaths(r.commonDir, rec.base_tree, rec.candidate_tree) }, findings: [{ ...SEVERE, evidence_class: "inferential" }], evidence: ["x"] } },
      { awaitRefuter: true },
    );
    assert.equal(held.ok && held.state, "reviewing");
    const { calls, runner } = fakeRunner();
    const { forecast, done } = await forecastThenRun(r, lineage, { riskAssessor: assess("medium"), runner });
    assert.deepEqual(forecast.reviewers.map((s) => s.role), ["refuter"]);
    is(done, "closed");
    assert.deepEqual(calls.roles, ["refuter"]);
    assert.equal(stateOf(r, lineage).burned, true);
  });
});

// ---- request context and unknown lineage ----

test("a request context needs a fresh review: resuming a lineage with one is blocked", async () => {
  await withRepo(async (r) => {
    const lineage = await grant(r, "medium");
    const { runner } = fakeRunner();
    const out = is(await runReview(input(r, { lineageId: lineage, requestContextPath: join(r.repo, "ctx.md") }), { riskAssessor: assess("medium"), runner }), "blocked");
    assert.equal(out.code, "request_context_requires_fresh_review");
  });
});

// ---- integration with the fake claude binary (the real claude is never called) ----

function fakeFor(r: Repo, lineage: string, stdout: string | ((subjectHash: string, paths: string[]) => string)) {
  const rec = stateOf(r, lineage);
  const subject = lensArtifactSubject(r.commonDir, rec, "risk")!;
  const paths = treeDiffPaths(r.commonDir, rec.base_tree, rec.candidate_tree);
  return makeFakeClaude({ stdout: typeof stdout === "string" ? stdout : stdout(subject.subject_hash, paths) });
}

test("integration (fake claude binary): a granted medium review closes; the child got the isolated flags and the model", async () => {
  await withRepo(async (r) => {
    const lineage = await grant(r, "medium");
    const fake = fakeFor(r, lineage, (hash, paths) => JSON.stringify({ subject_hash: hash, inspection: { status: "completed", paths }, findings: [], evidence: ["read it all"] }));
    try {
      const { done } = await forecastThenRun(r, lineage, {}, { claudePath: fake.binary, model: "opus", effort: "high" });
      is(done, "closed");
      const rec = JSON.parse(readFileSync(fake.recordFile, "utf8")) as FakeRecord;
      assert.ok(rec.args.includes("--print") && !rec.args.includes("--bare"));
      assert.deepEqual(rec.args.slice(rec.args.indexOf("--model"), rec.args.indexOf("--model") + 4), ["--model", "opus", "--effort", "high"]);
      assert.match(rec.stdin, /Role: lens, lens: risk\./);
      assert.equal(stateOf(r, lineage).burned, true);
    } finally {
      rmSync(fake.dir, { recursive: true, force: true });
    }
  });
});

test("integration (fake claude binary): garbage on stdout is never admitted or acknowledged", async () => {
  await withRepo(async (r) => {
    const lineage = await grant(r, "medium");
    const fake = fakeFor(r, lineage, "this is not json at all");
    try {
      const { done } = await forecastThenRun(r, lineage, {}, { claudePath: fake.binary });
      const out = is(done, "blocked");
      assert.equal(out.code, "reviewer_output_invalid");
      const rec = stateOf(r, lineage);
      assert.equal(rec.admitted_role_results.length, 0);
      assert.equal(rec.burned, false);
    } finally {
      rmSync(fake.dir, { recursive: true, force: true });
    }
  });
});

// ---- B1/B2/B3 + A2/A3 (verification of ea05430) ----

const ORIGINAL_A = "one\nTWO\nthree\nfour\nfive\n";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Grants a medium review whose lens finds one severe finding: leaves the lineage in correction_required. */
async function toCorrectionRequired(r: Repo, deps: RunDeps): Promise<string> {
  const lineage = await grant(r, "medium");
  is((await forecastThenRun(r, lineage, deps)).done, "input-required");
  assert.equal(stateOf(r, lineage).state, "correction_required");
  return lineage;
}

test("correction close consumes the CORRECTED candidate, never the original", async () => {
  await withRepo(async (r) => {
    const { runner } = fakeRunner({ findings: { risk: [SEVERE] } });
    const deps: RunDeps = { riskAssessor: assess("medium"), runner };
    const lineage = await toCorrectionRequired(r, deps);
    const original = stateOf(r, lineage).target_identity;
    writeFileSync(join(r.repo, "a.txt"), "ONE\nTWO\nthree\nfour\nfive\n");
    const forecast = is(await runReview(input(r, { lineageId: lineage }), deps), "forecast");
    const closed = is(await runReview(input(r, { lineageId: lineage, reviewerRunAcknowledged: true, reviewerRunBinding: forecast.reviewer_run_binding }), deps), "closed");

    assert.notEqual(closed.target_identity, original);
    assert.equal((closed.acknowledgement as { target_identity?: string }).target_identity, closed.target_identity);
    const rec = stateOf(r, lineage);
    assert.equal(rec.burned, true);
    assert.equal(rec.target_identity, closed.target_identity, "the lineage's current candidate is the corrected one");
    assert.equal(rec.original_target_identity, original, "the reviewed original is kept as history");
    assert.equal((readReceipt(r.commonDir, lineage) as { target_identity: string }).target_identity, closed.target_identity);

    assert.equal(isTargetConsumed(r.commonDir, closed.target_identity!).status, "consumed");
    assert.equal(isTargetConsumed(r.commonDir, original).status, "not_consumed");
    assert.equal(isTargetConsumed(r.commonDir, original).consumed, false);

    // status on the corrected candidate: consumed; the initial identity shown is the reviewed original
    const onCorrected = reviewStatus(r.repo, {});
    assert.equal(onCorrected.target_identity, closed.target_identity);
    assert.equal(onCorrected.next_transition.reason_code, "target_already_acknowledged");
    assert.equal(onCorrected.consumed.status, "consumed");
    assert.equal(onCorrected.projection.initial_snapshot_identity, original);

    // status on the original (defective) candidate: NOT consumed
    writeFileSync(join(r.repo, "a.txt"), ORIGINAL_A);
    const onOriginal = reviewStatus(r.repo, {});
    assert.equal(onOriginal.target_identity, original);
    assert.notEqual(onOriginal.next_transition.reason_code, "target_already_acknowledged");
    assert.equal(onOriginal.consumed.status, "not_consumed");
  });
});

test("validator forecast changes nothing; a refined correction stays plannable", async () => {
  await withRepo(async (r) => {
    const { calls, runner } = fakeRunner({ findings: { risk: [SEVERE] } });
    const deps: RunDeps = { riskAssessor: assess("medium"), runner };
    const lineage = await toCorrectionRequired(r, deps);
    const before = stateOf(r, lineage);

    writeFileSync(join(r.repo, "a.txt"), "ONE\nTWO\nthree\nfour\nfive\n");
    const f1 = is(await runReview(input(r, { lineageId: lineage }), deps), "forecast");
    const after = stateOf(r, lineage);
    assert.equal(after.revision, before.revision, "a forecast writes nothing");
    assert.equal(after.state, "correction_required");
    assert.equal(after.correction_attempts, 0, "a forecast does not spend the single correction attempt");

    // the parent refines the correction before accepting the forecast
    writeFileSync(join(r.repo, "a.txt"), "UNO\nTWO\nthree\nfour\nfive\n");
    const f2 = is(await runReview(input(r, { lineageId: lineage }), deps), "forecast");
    assert.notEqual(f2.reviewer_run_binding, f1.reviewer_run_binding);
    assert.equal(stateOf(r, lineage).revision, before.revision);
    assert.equal(planCorrection(r.commonDir, lineage).ok, true, "the correction is still plannable");

    // the stale forecast no longer authorizes the refined candidate; nothing is spent
    const stale = is(await runReview(input(r, { lineageId: lineage, reviewerRunAcknowledged: true, reviewerRunBinding: f1.reviewer_run_binding }), deps), "binding-drift");
    assert.equal(stale.field, "forecast");
    assert.equal(stateOf(r, lineage).revision, before.revision);
    assert.equal(calls.prompts.length, 1, "no validator ran");

    const closed = is(await runReview(input(r, { lineageId: lineage, reviewerRunAcknowledged: true, reviewerRunBinding: f2.reviewer_run_binding }), deps), "closed");
    assert.equal(closed.lineage_id, lineage);
    assert.deepEqual(calls.roles, ["risk", "validator"]);
    assert.equal(stateOf(r, lineage).correction_attempts, 1);
    assert.equal(stateOf(r, lineage).burned, true);
  });
});

test("cancelled: no queued reviewer is spawned after the run returns", async () => {
  await withRepo(async (r) => {
    const lineage = await grant(r, "high");
    const ac = new AbortController();
    const { calls, runner } = fakeRunner({ delayMs: { risk: 30, resilience: 30 }, during: () => ac.abort() });
    const deps: RunDeps = { riskAssessor: assess("high"), runner, concurrency: 2 };
    const forecast = is(await runReview(input(r, { lineageId: lineage }), deps), "forecast");
    const out = is(await runReview(input(r, { lineageId: lineage, signal: ac.signal, reviewerRunAcknowledged: true, reviewerRunBinding: forecast.reviewer_run_binding }), deps), "cancelled");
    assert.equal(out.lineage_id, lineage);
    const atReturn = calls.prompts.length;
    assert.ok(atReturn >= 1 && atReturn <= 2, "at most the reviewers of the first two slots were spawned");
    await sleep(200);
    assert.equal(calls.prompts.length, atReturn, "nothing was spawned after the run returned");
    assert.equal(stateOf(r, lineage).admitted_role_results.length, 0);
  });
});

test("blocked: once a slot fails, no queued reviewer is spawned", async () => {
  await withRepo(async (r) => {
    const lineage = await grant(r, "high");
    const fail: RunOutcome = { ok: false, code: "nonzero_exit", message: "boom", elapsedMs: 1 };
    const { calls, runner } = fakeRunner({ fail: { risk: fail }, delayMs: { resilience: 40 } });
    const deps: RunDeps = { riskAssessor: assess("high"), runner, concurrency: 2 };
    const { done } = await forecastThenRun(r, lineage, deps);
    assert.equal(is(done, "blocked").code, "reviewer_failed");
    await sleep(200);
    assert.equal(calls.prompts.length, 2, "readability and reliability never started");
    assert.equal(stateOf(r, lineage).admitted_role_results.length, 0);
  });
});

test("a forecast for one model/effort does not authorize a run with another", async () => {
  await withRepo(async (r) => {
    const lineage = await grant(r, "medium");
    const { calls, runner } = fakeRunner();
    const deps: RunDeps = { riskAssessor: assess("medium"), runner };
    const forecast = is(await runReview(input(r, { lineageId: lineage, model: "haiku" }), deps), "forecast");
    for (const other of [{ model: "opus", effort: "max" }, { model: "sonnet" }, {}]) {
      const out = is(await runReview(input(r, { lineageId: lineage, ...other, reviewerRunAcknowledged: true, reviewerRunBinding: forecast.reviewer_run_binding }), deps), "binding-drift");
      assert.equal(out.field, "forecast");
    }
    assert.equal(calls.prompts.length, 0);
    is(await runReview(input(r, { lineageId: lineage, model: "haiku", reviewerRunAcknowledged: true, reviewerRunBinding: forecast.reviewer_run_binding }), deps), "closed");
    assert.equal(calls.opts[0]!.model, "haiku");
  });
});

test("without lineageId, a corrected candidate of a lineage in correction_required reports that lineage instead of opening a new review", async () => {
  await withRepo(async (r) => {
    const { calls, runner } = fakeRunner({ findings: { risk: [SEVERE] } });
    const deps: RunDeps = { riskAssessor: assess("medium"), runner };
    const lineage = await toCorrectionRequired(r, deps);
    const rev = stateOf(r, lineage).revision;
    writeFileSync(join(r.repo, "a.txt"), "ONE\nTWO\nthree\nfour\nfive\n");
    const out = is(await runReview(input(r), deps), "blocked");
    assert.equal(out.code, "correction_lineage_pending");
    assert.equal(out.lineage_id, lineage);
    assert.deepEqual(listLineages(r.commonDir).lineages, [lineage], "no new lineage was opened");
    assert.equal(stateOf(r, lineage).revision, rev);
    assert.equal(calls.prompts.length, 1);
    // resuming with the reported lineage works
    const f = is(await runReview(input(r, { lineageId: out.lineage_id }), deps), "forecast");
    is(await runReview(input(r, { lineageId: lineage, reviewerRunAcknowledged: true, reviewerRunBinding: f.reviewer_run_binding }), deps), "closed");
  });
});

// ---- legacy validating records, escalation binding, abort seams (re-verification of 4863518) ----

test("legacy validating record (no correction_candidate_tree) never consumes the original", async () => {
  await withRepo(async (r) => {
    const { runner } = fakeRunner({ findings: { risk: [SEVERE] } });
    const deps: RunDeps = { riskAssessor: assess("medium"), runner };
    const lineage = await toCorrectionRequired(r, deps);
    const original = stateOf(r, lineage).target_identity;
    writeFileSync(join(r.repo, "a.txt"), "ONE\nTWO\nthree\nfour\nfive\n");
    const frozen = freezeSnapshot(r.repo, { kind: "current-changes", projection: "workspace" });
    assert.equal(frozen.status, "frozen");
    if (frozen.status !== "frozen") return;
    // the shape an older forecast left behind: validating, with the corrected identity but NO corrected tree
    const rev = stateOf(r, lineage).revision;
    await updateState(r.commonDir, lineage, rev, (rec) => beginValidation(rec, { now: new Date().toISOString(), actualCorrectionLines: 1, correctionTargetIdentity: frozen.snapshot.identity }));
    assert.equal("correction_candidate_tree" in stateOf(r, lineage), false);

    const forecast = is(await runReview(input(r, { lineageId: lineage }), deps), "forecast");
    const closed = is(await runReview(input(r, { lineageId: lineage, reviewerRunAcknowledged: true, reviewerRunBinding: forecast.reviewer_run_binding }), deps), "closed");
    assert.equal(closed.target_identity, frozen.snapshot.identity);
    assert.equal(isTargetConsumed(r.commonDir, frozen.snapshot.identity).status, "consumed");
    assert.equal(isTargetConsumed(r.commonDir, original).status, "not_consumed");
    assert.equal(stateOf(r, lineage).original_target_identity, original);
  });
});

test("an escalated correction binds the corrected candidate: a run without lineageId reports the escalated lineage, not a new review", async () => {
  await withRepo(async (r) => {
    const { calls, runner } = fakeRunner({ findings: { risk: [SEVERE] }, validatorFails: true });
    const deps: RunDeps = { riskAssessor: assess("medium"), runner };
    const lineage = await toCorrectionRequired(r, deps);
    const original = stateOf(r, lineage).target_identity;
    writeFileSync(join(r.repo, "a.txt"), "ONE\nTWO\nthree\nfour\nfive\n");
    const f = is(await runReview(input(r, { lineageId: lineage }), deps), "forecast");
    const esc = is(await runReview(input(r, { lineageId: lineage, reviewerRunAcknowledged: true, reviewerRunBinding: f.reviewer_run_binding }), deps), "stopped");
    assert.equal(esc.reason_code, "escalated");
    const rec = stateOf(r, lineage);
    assert.equal(rec.state, "escalated");
    assert.notEqual(rec.target_identity, original);
    assert.equal(rec.original_target_identity, original);

    const again = is(await runReview(input(r), deps), "stopped");
    assert.equal(again.reason_code, "escalated");
    assert.equal(again.lineage_id, lineage);
    assert.deepEqual(listLineages(r.commonDir).lineages, [lineage], "no new review was offered");
    assert.equal(calls.prompts.length, 2);
    assert.equal(isTargetConsumed(r.commonDir, rec.target_identity).consumed, false);
  });
});

test("abort recheck before capture: an abort that lands after the reviewer answered captures nothing", async () => {
  await withRepo(async (r) => {
    const lineage = await grant(r, "medium");
    const { runner } = fakeRunner();
    const ac = new AbortController();
    const deps: RunDeps = { riskAssessor: assess("medium"), runner, hooks: { beforeCapture: () => ac.abort() } };
    const f = is(await runReview(input(r, { lineageId: lineage }), deps), "forecast");
    const out = is(await runReview(input(r, { lineageId: lineage, signal: ac.signal, reviewerRunAcknowledged: true, reviewerRunBinding: f.reviewer_run_binding }), deps), "cancelled");
    assert.equal(out.lineage_id, lineage);
    const rec = stateOf(r, lineage);
    assert.equal(rec.admitted_role_results.length, 0, "nothing was captured after the abort");
    assert.equal(rec.burned, false);
  });
});

test("abort recheck before acknowledge: an abort that lands after approval burns nothing", async () => {
  await withRepo(async (r) => {
    const { runner } = fakeRunner();
    const ac = new AbortController();
    const deps: RunDeps = { riskAssessor: assess("low"), runner, hooks: { beforeAcknowledge: () => ac.abort() } };
    const out = is(await runReview(input(r, { signal: ac.signal }), deps), "cancelled");
    const rec = stateOf(r, out.lineage_id!);
    assert.equal(rec.state, "approved");
    assert.equal(rec.burned, false, "an aborted run never acknowledges");
    assert.equal(isTargetConsumed(r.commonDir, rec.target_identity).consumed, false);
  });
});

// ---- unchanged correction, residual shape, pre-963094d records (verification of 963094d) ----

const stateFileOf = (r: Repo, l: string) => join(storeRootFor(r.commonDir), l, "review-state.json");
const sha256File = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

test("an unchanged corrected candidate never opens validation; the original is not consumed and the state is byte-identical", async () => {
  await withRepo(async (r) => {
    const { runner } = fakeRunner({ findings: { risk: [SEVERE] } });
    const deps: RunDeps = { riskAssessor: assess("medium"), runner };
    const lineage = await toCorrectionRequired(r, deps);
    const original = stateOf(r, lineage).target_identity;
    const frozen = freezeSnapshot(r.repo, { kind: "current-changes", projection: "workspace" });
    if (frozen.status !== "frozen") throw new Error("not frozen");
    assert.equal(frozen.snapshot.identity, original, "nothing was corrected");
    const before = sha256File(stateFileOf(r, lineage));

    const began = await beginCorrectionValidation(resolveRepository(r.repo), lineage, stateOf(r, lineage).revision, { candidateTree: frozen.snapshot.candidateTree, identity: frozen.snapshot.identity });
    assert.equal(began.ok, false, "an unchanged candidate is not a correction");
    assert.equal((began as { code?: string }).code, "correction_unavailable");
    // same tree under another identity, and same identity under another tree, are both refused
    const other = `sha256:${"3".repeat(64)}`;
    const sameTree = await beginCorrectionValidation(resolveRepository(r.repo), lineage, stateOf(r, lineage).revision, { candidateTree: frozen.snapshot.candidateTree, identity: other });
    assert.equal((sameTree as { code?: string }).code, "correction_unavailable");
    const sameIdentity = await beginCorrectionValidation(resolveRepository(r.repo), lineage, stateOf(r, lineage).revision, { candidateTree: stateOf(r, lineage).base_tree, identity: frozen.snapshot.identity });
    assert.equal((sameIdentity as { code?: string }).code, "correction_unavailable");
    assert.equal(sha256File(stateFileOf(r, lineage)), before, "state unchanged byte for byte");

    // through the run: still the correction plan, never a validator forecast or a close
    const out = is(await runReview(input(r, { lineageId: lineage }), deps), "input-required");
    assert.equal(out.lineage_id, lineage);
    assert.equal(sha256File(stateFileOf(r, lineage)), before);
    assert.equal(isTargetConsumed(r.commonDir, original).status, "not_consumed");
  });
});

test("residual shape: validating without correction_target_identity never approves; no run closes; state byte-identical; original not consumed", async () => {
  await withRepo(async (r) => {
    const { runner } = fakeRunner({ findings: { risk: [SEVERE] } });
    const deps: RunDeps = { riskAssessor: assess("medium"), runner };
    const lineage = await toCorrectionRequired(r, deps);
    const original = stateOf(r, lineage).target_identity;
    await updateState(r.commonDir, lineage, stateOf(r, lineage).revision, (rec) => beginValidation(rec, { now: new Date().toISOString(), actualCorrectionLines: 1 }));
    const h0 = sha256File(stateFileOf(r, lineage));
    const rec = stateOf(r, lineage);
    const res = { targeted_validation_request_hash: `sha256:${"0".repeat(64)}`, correction_target_identity: original, original_criteria: { passed: true, evidence: ["x"] }, correction_regression: { passed: true, evidence: ["y"] }, follow_ups: [] };
    const cap = await captureValidatorResult(r.commonDir, lineage, rec.revision, { result: res, correctionCandidateTree: rec.candidate_tree });
    assert.equal(cap.ok, false);

    const a = await runReview(input(r, { lineageId: lineage }), deps);
    const b = await runReview(input(r), deps);
    writeFileSync(join(r.repo, "a.txt"), "ONE\nTWO\nthree\nfour\nfive\n");
    const c = await runReview(input(r, { lineageId: lineage }), deps);
    const d = await runReview(input(r), deps);
    for (const o of [a, b, c, d]) assert.notEqual(o.outcome, "closed", JSON.stringify(o).slice(0, 300));
    assert.equal(is(c, "binding-drift").field, "target");
    assert.equal(sha256File(stateFileOf(r, lineage)), h0, "refusals leave the state byte-identical");
    assert.equal(isTargetConsumed(r.commonDir, original).status, "not_consumed");
  });
});

test("a pre-963094d approved record (correction target, no corrected tree, no original_*) is unreadable: unknown for gates, authority_error for a run", async () => {
  await withRepo(async (r) => {
    const { runner } = fakeRunner({ findings: { risk: [SEVERE] } });
    const deps: RunDeps = { riskAssessor: assess("medium"), runner };
    const lineage = await toCorrectionRequired(r, deps);
    writeFileSync(join(r.repo, "a.txt"), "ONE\nTWO\nthree\nfour\nfive\n");
    const cur = stateOf(r, lineage);
    const corr = freezeSnapshot(r.repo, { kind: "current-changes", projection: "workspace" });
    if (corr.status !== "frozen") throw new Error("not frozen");
    const legacy = {
      ...cur, state: "approved", correction_attempts: 1, actual_correction_lines: 1, correction_target_identity: corr.snapshot.identity,
      admitted_role_results: [...cur.admitted_role_results, { role: "validator", result_hash: `sha256:${"7".repeat(64)}` }],
      approved_ack_token_hash: `sha256:${"8".repeat(64)}`, evidence_hash: `sha256:${"9".repeat(64)}`,
    } as unknown as StateRecord;
    legacy.revision = stateRevision(legacy);
    writeFileSync(stateFileOf(r, lineage), JSON.stringify(legacy));

    assert.throws(() => readState(r.commonDir, lineage), (e: Error) => e.name === "StoreCorruptError");
    const scan = isTargetConsumed(r.commonDir, cur.target_identity);
    assert.equal(scan.status, "unknown");
    assert.equal(scan.consumed, false);
    assert.deepEqual(scan.problems.map((p) => p.code), ["state_unreadable"]);
    const out = is(await runReview(input(r, { lineageId: lineage }), deps), "blocked");
    assert.equal(out.code, "authority_error");
  });
});

// ---- defense in depth: store rejects an unchanged-correction record; a run checks the corrected snapshot's projection and base ----

test("a hand-crafted validating record whose correction candidate equals the reviewed one is unreadable (fail closed)", async () => {
  for (const shape of ["identity", "tree"] as const) {
    await withRepo(async (r) => {
      const { runner } = fakeRunner({ findings: { risk: [SEVERE] } });
      const deps: RunDeps = { riskAssessor: assess("medium"), runner };
      const lineage = await toCorrectionRequired(r, deps);
      const cur = stateOf(r, lineage);
      const forged = {
        ...cur, state: "validating", correction_attempts: 1, actual_correction_lines: 1,
        correction_target_identity: shape === "identity" ? cur.target_identity : `sha256:${"4".repeat(64)}`,
        correction_candidate_tree: shape === "tree" ? cur.candidate_tree : "d".repeat(40),
      } as unknown as StateRecord;
      forged.revision = stateRevision(forged);
      writeFileSync(stateFileOf(r, lineage), JSON.stringify(forged));
      assert.throws(() => readState(r.commonDir, lineage), (e: Error) => e.name === "StoreCorruptError", shape);
    });
  }
});

test("afterCorrection: a corrected snapshot with another projection or base is binding-drift and captures nothing", async () => {
  for (const variant of ["projection", "base"] as const) {
    await withRepo(async (r) => {
      const { runner, calls } = fakeRunner({ findings: { risk: [SEVERE] } });
      const deps: RunDeps = { riskAssessor: assess("medium"), runner };
      const lineage = await toCorrectionRequired(r, deps);
      const before = sha256File(stateFileOf(r, lineage));
      const spawned = calls.prompts.length;
      writeFileSync(join(r.repo, "a.txt"), "ONE\nTWO\nthree\nfour\nfive\n");
      let over: Partial<ReviewRunInput> = {};
      if (variant === "projection") {
        git(r.repo, "add", "a.txt");
        over = { projection: "staged" };
      } else {
        writeFileSync(join(r.repo, "b.txt"), "bee\nmoved base\n");
        git(r.repo, "add", "b.txt");
        git(r.repo, "commit", "-q", "-m", "move the base");
      }
      const out = is(await runReview(input(r, { lineageId: lineage, ...over }), { riskAssessor: assess("medium"), runner }), "binding-drift");
      assert.match(out.field ?? "", variant === "projection" ? /projection/ : /base/);
      assert.equal(sha256File(stateFileOf(r, lineage)), before, "nothing captured");
      assert.equal(calls.prompts.length, spawned, "no reviewer ran");
    });
  }
});

// ---- A2 accepts the upstream correction shapes (base == reviewed base OR reviewed candidate); A1 fails closed (verification of da3943b) ----

const FIXED_A = "ONE\nTWO\nthree\nfour\nfive\n";

test("A2: commit the reviewed work, then correct in the worktree (base == reviewed candidate tree) validates and closes; the lineage keeps its base_tree", async () => {
  await withRepo(async (r) => {
    const { runner } = fakeRunner({ findings: { risk: [SEVERE] } });
    const deps: RunDeps = { riskAssessor: assess("medium"), runner };
    const lineage = await toCorrectionRequired(r, deps);
    const rec = stateOf(r, lineage);
    git(r.repo, "commit", "-q", "-am", "reviewed work");
    assert.equal(git(r.repo, "rev-parse", "HEAD^{tree}").trim(), rec.candidate_tree, "the new base is exactly the reviewed tree");
    writeFileSync(join(r.repo, "a.txt"), FIXED_A);
    const done = await forecastThenRun(r, lineage, deps);
    const closed = is(done.done, "closed");
    assert.notEqual(closed.target_identity, rec.target_identity);
    const after = stateOf(r, lineage);
    assert.equal(after.state, "approved");
    assert.equal(after.burned, true);
    assert.equal(after.base_tree, rec.base_tree, "the lineage keeps its original base_tree");
    assert.equal(after.original_target_identity, rec.target_identity);
    assert.equal(isTargetConsumed(r.commonDir, closed.target_identity!).status, "consumed");
    assert.equal(isTargetConsumed(r.commonDir, rec.target_identity).status, "not_consumed");
  });
});

test("A2: a base that is neither the reviewed base nor the reviewed candidate is binding-drift base, nothing written (committed-only, base branch moved)", async () => {
  await withRepo(async (r) => {
    git(r.repo, "checkout", "-q", "-b", "feat");
    git(r.repo, "commit", "-q", "-am", "feature");
    const target = { kind: "base-diff" as const, baseRef: "main", committedOnly: true };
    const s = await startReview({ cwd: r.repo, target, consent: "granted", riskAssessor: assess("medium") });
    assert.equal(s.status, "started");
    const lineage = (s as Extract<typeof s, { status: "started" }>).result.lineage_id;
    const { runner, calls } = fakeRunner({ findings: { risk: [SEVERE] } });
    const deps: RunDeps = { riskAssessor: assess("medium"), runner };
    is((await forecastThenRun(r, lineage, deps, { target })).done, "input-required");
    git(r.repo, "checkout", "-q", "main");
    writeFileSync(join(r.repo, "c.txt"), "sea\n");
    git(r.repo, "add", "c.txt");
    git(r.repo, "commit", "-q", "-m", "main moves");
    git(r.repo, "checkout", "-q", "feat");
    writeFileSync(join(r.repo, "a.txt"), FIXED_A);
    git(r.repo, "commit", "-q", "-am", "fix");
    const h0 = sha256File(stateFileOf(r, lineage));
    const n0 = calls.prompts.length;
    const out = is(await runReview(input(r, { lineageId: lineage, target }), deps), "binding-drift");
    assert.match(out.field ?? "", /base/);
    assert.equal(sha256File(stateFileOf(r, lineage)), h0, "nothing written");
    assert.equal(calls.prompts.length, n0, "no reviewer ran");
  });
});

test("A2: a workspace lineage resumed with projection staged is binding-drift projection, nothing written", async () => {
  await withRepo(async (r) => {
    const { runner, calls } = fakeRunner({ findings: { risk: [SEVERE] } });
    const deps: RunDeps = { riskAssessor: assess("medium"), runner };
    const lineage = await toCorrectionRequired(r, deps);
    writeFileSync(join(r.repo, "a.txt"), FIXED_A);
    git(r.repo, "add", "a.txt");
    const h0 = sha256File(stateFileOf(r, lineage));
    const n0 = calls.prompts.length;
    const out = is(await runReview(input(r, { lineageId: lineage, projection: "staged" }), deps), "binding-drift");
    assert.match(out.field ?? "", /projection/);
    assert.equal(sha256File(stateFileOf(r, lineage)), h0);
    assert.equal(calls.prompts.length, n0);
  });
});

test("A2 does not drift legitimate corrections: staged lineage + staged fix, committed-only + committed fix (S1)", async () => {
  // staged lineage, staged fix, resumed with projection staged
  await withRepo(async (r) => {
    git(r.repo, "add", "a.txt");
    const s = await startReview({ cwd: r.repo, target: { kind: "current-changes" }, projection: "staged", consent: "granted", riskAssessor: assess("medium") });
    assert.equal(s.status, "started");
    const lineage = (s as Extract<typeof s, { status: "started" }>).result.lineage_id;
    const { runner } = fakeRunner({ findings: { risk: [SEVERE] } });
    const deps: RunDeps = { riskAssessor: assess("medium"), runner };
    is((await forecastThenRun(r, lineage, deps, { projection: "staged" })).done, "input-required");
    writeFileSync(join(r.repo, "a.txt"), FIXED_A);
    git(r.repo, "add", "a.txt");
    is((await forecastThenRun(r, lineage, deps, { projection: "staged" })).done, "closed");
    assert.equal(stateOf(r, lineage).state, "approved");
  });
  // committed-only base-diff lineage, fix committed on the branch (base ref unchanged)
  await withRepo(async (r) => {
    git(r.repo, "checkout", "-q", "-b", "feat");
    git(r.repo, "commit", "-q", "-am", "feature");
    const target = { kind: "base-diff" as const, baseRef: "main", committedOnly: true };
    const s = await startReview({ cwd: r.repo, target, consent: "granted", riskAssessor: assess("medium") });
    assert.equal(s.status, "started");
    const lineage = (s as Extract<typeof s, { status: "started" }>).result.lineage_id;
    const { runner } = fakeRunner({ findings: { risk: [SEVERE] } });
    const deps: RunDeps = { riskAssessor: assess("medium"), runner };
    is((await forecastThenRun(r, lineage, deps, { target })).done, "input-required");
    writeFileSync(join(r.repo, "a.txt"), FIXED_A);
    git(r.repo, "commit", "-q", "-am", "fix");
    is((await forecastThenRun(r, lineage, deps, { target })).done, "closed");
    assert.equal(stateOf(r, lineage).state, "approved");
  });
});

function forgeValidating(r: Repo, lineage: string, shape: "identity" | "tree"): StateRecord {
  const cur = stateOf(r, lineage);
  const forged = {
    ...cur, state: "validating", correction_attempts: 1, actual_correction_lines: 1,
    correction_target_identity: shape === "identity" ? cur.target_identity : `sha256:${"4".repeat(64)}`,
    correction_candidate_tree: shape === "tree" ? cur.candidate_tree : "d".repeat(40),
  } as unknown as StateRecord;
  forged.revision = stateRevision(forged);
  writeFileSync(stateFileOf(r, lineage), JSON.stringify(forged));
  return cur;
}

test("forged unchanged-correction validating: gates read unknown and a resumed run is blocked (S1)", async () => {
  for (const shape of ["identity", "tree"] as const) {
    await withRepo(async (r) => {
      const { runner, calls } = fakeRunner({ findings: { risk: [SEVERE] } });
      const deps: RunDeps = { riskAssessor: assess("medium"), runner };
      const lineage = await toCorrectionRequired(r, deps);
      const cur = forgeValidating(r, lineage, shape);
      const h0 = sha256File(stateFileOf(r, lineage));
      const n0 = calls.prompts.length;
      assert.throws(() => readState(r.commonDir, lineage), (e: Error) => e.name === "StoreCorruptError", shape);
      const scan = isTargetConsumed(r.commonDir, cur.target_identity);
      assert.equal(scan.status, "unknown", shape);
      assert.equal(scan.consumed, false);
      assert.deepEqual(scan.problems.map((p) => p.code), ["state_unreadable"]);
      const a = is(await runReview(input(r, { lineageId: lineage }), deps), "blocked");
      assert.equal(a.code, "authority_error", shape);
      writeFileSync(join(r.repo, "a.txt"), FIXED_A);
      const b = is(await runReview(input(r, { lineageId: lineage }), deps), "blocked");
      assert.equal(b.code, "authority_error", shape);
      assert.equal(sha256File(stateFileOf(r, lineage)), h0, "refusals leave the file byte-identical");
      assert.equal(calls.prompts.length, n0, "no reviewer ran");
    });
  }
});

test("A1: a run without lineageId over an unreadable correction lineage with the same base/projection is blocked, never a new review", async () => {
  for (const shape of ["identity", "tree"] as const) {
    await withRepo(async (r) => {
      const { runner } = fakeRunner({ findings: { risk: [SEVERE] } });
      const deps: RunDeps = { riskAssessor: assess("medium"), runner };
      const lineage = await toCorrectionRequired(r, deps);
      forgeValidating(r, lineage, shape);
      const h0 = sha256File(stateFileOf(r, lineage));
      const before = listLineages(r.commonDir).lineages.length;
      writeFileSync(join(r.repo, "a.txt"), FIXED_A);
      const out = is(await runReview(input(r), deps), "blocked");
      assert.ok(out.code === "authority_error" || out.code === "correction_lineage_pending", `${shape}: ${out.code}`);
      assert.equal(out.lineage_id, lineage, shape);
      assert.equal(listLineages(r.commonDir).lineages.length, before, "no new lineage");
      assert.equal(sha256File(stateFileOf(r, lineage)), h0);
    });
  }
});

// ---- U12d: scope probes P1/P1b/P1c, candidate-as-base reporting (P4), secure raw read (B1), corrected identity (A1) ----

test("P1: reviewed work committed, then an unrelated file + the fix in the worktree: refused out of scope, nothing written", async () => {
  await withRepo(async (r) => {
    const { runner, calls } = fakeRunner({ findings: { risk: [SEVERE] } });
    const deps: RunDeps = { riskAssessor: assess("medium"), runner };
    const lineage = await toCorrectionRequired(r, deps);
    git(r.repo, "commit", "-q", "-am", "reviewed work");
    writeFileSync(join(r.repo, "a.txt"), FIXED_A);
    writeFileSync(join(r.repo, "b.txt"), "unrelated big change\n".repeat(50));
    writeFileSync(join(r.repo, "z.txt"), "new unrelated\n");
    git(r.repo, "add", "z.txt");
    const h0 = sha256File(stateFileOf(r, lineage));
    const n0 = calls.prompts.length;
    const out = is(await runReview(input(r, { lineageId: lineage }), deps), "blocked");
    assert.equal(out.code, "correction_refused");
    assert.equal((out as { detail?: string }).detail, "correction_out_of_scope");
    assert.equal(sha256File(stateFileOf(r, lineage)), h0);
    assert.equal(calls.prompts.length, n0);
  });
});

test("P1b: reviewed work + an unrelated change both committed, fix in the worktree: binding-drift base, nothing written", async () => {
  await withRepo(async (r) => {
    const { runner, calls } = fakeRunner({ findings: { risk: [SEVERE] } });
    const deps: RunDeps = { riskAssessor: assess("medium"), runner };
    const lineage = await toCorrectionRequired(r, deps);
    writeFileSync(join(r.repo, "b.txt"), "unrelated\n");
    git(r.repo, "commit", "-q", "-am", "reviewed work + unrelated");
    writeFileSync(join(r.repo, "a.txt"), FIXED_A);
    const h0 = sha256File(stateFileOf(r, lineage));
    const n0 = calls.prompts.length;
    const out = is(await runReview(input(r, { lineageId: lineage }), deps), "binding-drift");
    assert.match(out.field ?? "", /base/);
    assert.equal(sha256File(stateFileOf(r, lineage)), h0);
    assert.equal(calls.prompts.length, n0);
  });
});

test("P1c: reviewed work committed, the fix in the finding file over the correction budget: refused, nothing written", async () => {
  await withRepo(async (r) => {
    const { runner, calls } = fakeRunner({ findings: { risk: [SEVERE] } });
    const deps: RunDeps = { riskAssessor: assess("medium"), runner };
    const lineage = await toCorrectionRequired(r, deps);
    git(r.repo, "commit", "-q", "-am", "reviewed work");
    writeFileSync(join(r.repo, "a.txt"), FIXED_A + "x\n".repeat(400));
    const h0 = sha256File(stateFileOf(r, lineage));
    const n0 = calls.prompts.length;
    const out = is(await runReview(input(r, { lineageId: lineage }), deps), "blocked");
    assert.equal(out.code, "correction_refused", JSON.stringify(out));
    assert.equal(sha256File(stateFileOf(r, lineage)), h0);
    assert.equal(calls.prompts.length, n0);
  });
});

test("P4: a run without lineageId on a candidate-as-base correction is reported as pending, never a new review", async () => {
  await withRepo(async (r) => {
    const { runner, calls } = fakeRunner({ findings: { risk: [SEVERE] } });
    const deps: RunDeps = { riskAssessor: assess("medium"), runner };
    const lineage = await toCorrectionRequired(r, deps);
    git(r.repo, "commit", "-q", "-am", "reviewed work");
    writeFileSync(join(r.repo, "a.txt"), FIXED_A);
    const before = listLineages(r.commonDir).lineages.length;
    const n0 = calls.prompts.length;
    const b = is(await runReview(input(r), deps), "blocked");
    assert.equal(b.code, "correction_lineage_pending");
    assert.equal(b.lineage_id, lineage);
    assert.equal(listLineages(r.commonDir).lineages.length, before, "no new lineage");
    assert.equal(calls.prompts.length, n0);
  });
});

test("P4b: the same shape over a forged (unreadable) lineage is reported too, never a new review", async () => {
  await withRepo(async (r) => {
    const { runner } = fakeRunner({ findings: { risk: [SEVERE] } });
    const deps: RunDeps = { riskAssessor: assess("medium"), runner };
    const lineage = await toCorrectionRequired(r, deps);
    forgeValidating(r, lineage, "tree");
    git(r.repo, "commit", "-q", "-am", "reviewed work");
    writeFileSync(join(r.repo, "a.txt"), FIXED_A);
    const before = listLineages(r.commonDir).lineages.length;
    const b = is(await runReview(input(r), deps), "blocked");
    assert.equal(b.lineage_id, lineage);
    assert.equal(listLineages(r.commonDir).lineages.length, before);
  });
});

/** Runs `runReview` (no lineageId) in a child with a hard timeout; the repo is prepared by the caller. */
function runInChild(cwd: string): { status: number | null; signal: NodeJS.Signals | null; stdout: string } {
  const runUrl = pathToFileURL(join(fileURLToPath(new URL(".", import.meta.url)), "run.js")).href;
  const script = `import(${JSON.stringify(runUrl)}).then(async (m) => { const o = await m.runReview({ cwd: ${JSON.stringify(cwd)} }, { riskAssessor: () => ({ level: "medium", reasons: [{ code: "shell_source", signal: "shell_process", path: "a.txt" }], evidence: ["x"] }) }); console.log(JSON.stringify(o)); });`;
  const res = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL", env: ENV });
  return { status: res.status, signal: res.signal, stdout: res.stdout };
}

test("pendingCorrectionLineage never blocks on a FIFO review-state.json (S1/S4)", async () => {
  await withRepo(async (r) => {
    const { runner } = fakeRunner({ findings: { risk: [SEVERE] } });
    const deps: RunDeps = { riskAssessor: assess("medium"), runner };
    const lineage = await toCorrectionRequired(r, deps);
    const file = stateFileOf(r, lineage);
    rmSync(file);
    const mk = spawnSync("mkfifo", [file]);
    assert.equal(mk.status, 0, "mkfifo");
    writeFileSync(join(r.repo, "a.txt"), FIXED_A);
    const res = runInChild(r.repo);
    assert.equal(res.signal, null, "the run returned (no hang)");
    assert.equal(res.status, 0);
    const out = JSON.parse(res.stdout) as { outcome: string; code?: string; lineage_id?: string };
    assert.equal(out.outcome, "blocked", res.stdout);
    assert.equal(out.lineage_id, lineage, "an unreadable lineage fails closed, never a new review");
  });
});

test("pendingCorrectionLineage never follows a symlinked review-state.json to a file outside the store", async () => {
  await withRepo(async (r) => {
    const { runner } = fakeRunner({ findings: { risk: [SEVERE] } });
    const deps: RunDeps = { riskAssessor: assess("medium"), runner };
    const lineage = await toCorrectionRequired(r, deps);
    const file = stateFileOf(r, lineage);
    const outside = join(r.repo, "..", "outside.json");
    writeFileSync(outside, "{}");
    rmSync(file);
    symlinkSync(outside, file);
    const zero = join(r.repo, "..", "zero-link");
    symlinkSync("/dev/zero", zero);
    writeFileSync(join(r.repo, "a.txt"), FIXED_A);
    const res = runInChild(r.repo);
    assert.equal(res.signal, null);
    assert.equal(res.status, 0);
    const out = JSON.parse(res.stdout) as { outcome: string; lineage_id?: string };
    assert.equal(out.outcome, "blocked", res.stdout);
    assert.equal(out.lineage_id, lineage);
    assert.equal(readFileSync(outside, "utf8"), "{}", "the external file is untouched");
    // a symlink to /dev/zero does not exhaust memory or hang either
    rmSync(file);
    symlinkSync("/dev/zero", file);
    const z = runInChild(r.repo);
    assert.equal(z.signal, null);
    assert.equal(z.status, 0);
    assert.equal((JSON.parse(z.stdout) as { lineage_id?: string }).lineage_id, lineage);
  });
});

test("A1: after a candidate-as-base correction the adopted identity is (original base, corrected tree, its paths): receipt self-consistent", async () => {
  await withRepo(async (r) => {
    const { runner } = fakeRunner({ findings: { risk: [SEVERE] } });
    const deps: RunDeps = { riskAssessor: assess("medium"), runner };
    const lineage = await toCorrectionRequired(r, deps);
    const rec = stateOf(r, lineage);
    git(r.repo, "commit", "-q", "-am", "reviewed work");
    writeFileSync(join(r.repo, "a.txt"), FIXED_A);
    const closed = is((await forecastThenRun(r, lineage, deps)).done, "closed");
    const rc = readReceipt(r.commonDir, lineage) as unknown as Record<string, string>;
    const after = stateOf(r, lineage);
    assert.equal(rc.base_tree, rec.base_tree);
    assert.equal(rc.target_identity, closed.target_identity);
    const paths = treeDiffPaths(r.commonDir, rc.base_tree!, rc.candidate_tree!);
    const expected = snapshotIdentity("current-changes", after.projection, rc.base_tree!, rc.candidate_tree!, digestPaths(paths));
    assert.equal(rc.target_identity, expected, "identity recomputes from the receipt's own base/candidate");
    assert.equal(after.target_identity, expected);
    assert.equal(isTargetConsumed(r.commonDir, expected).status, "consumed");
    assert.equal(isTargetConsumed(r.commonDir, rec.target_identity).status, "not_consumed");
    // the snapshot kind is part of the identity: a committed-range (base-diff) view is another target than this
    // current-changes lineage, as it was before any correction (it never matches the defective original either)
    git(r.repo, "commit", "-q", "-am", "fix");
    const first = git(r.repo, "rev-list", "--max-parents=0", "HEAD").trim();
    const view = reviewStatus(r.repo, { target: { kind: "base-diff", baseRef: first, committedOnly: true } });
    assert.notEqual(view.target_identity, expected);
    assert.equal(view.consumed.status, "not_consumed");
  });
});

test("A1: a committed-only lineage corrected on the branch: a fresh status over the committed range from the original base is consumed", async () => {
  await withRepo(async (r) => {
    git(r.repo, "checkout", "-q", "-b", "feat");
    git(r.repo, "commit", "-q", "-am", "feature");
    const target = { kind: "base-diff" as const, baseRef: "main", committedOnly: true };
    const s = await startReview({ cwd: r.repo, target, consent: "granted", riskAssessor: assess("medium") });
    assert.equal(s.status, "started");
    const lineage = (s as Extract<typeof s, { status: "started" }>).result.lineage_id;
    const { runner } = fakeRunner({ findings: { risk: [SEVERE] } });
    const deps: RunDeps = { riskAssessor: assess("medium"), runner };
    is((await forecastThenRun(r, lineage, deps, { target })).done, "input-required");
    const original = stateOf(r, lineage).target_identity;
    writeFileSync(join(r.repo, "a.txt"), FIXED_A);
    git(r.repo, "commit", "-q", "-am", "fix");
    const closed = is((await forecastThenRun(r, lineage, deps, { target })).done, "closed");
    const view = reviewStatus(r.repo, { target });
    assert.equal(view.target_identity, closed.target_identity);
    assert.equal(view.consumed.status, "consumed");
    assert.equal(view.next_transition.reason_code, "target_already_acknowledged");
    assert.notEqual(view.target_identity, original);
  });
});

// ---- U12e: unsafe vs skipped raw state files, other-candidate skip, corrected tree back on the original base ----

/** A correction_required lineage, then an UNRELATED candidate (another base, another changed file). */
async function unrelatedSetup(r: Repo, deps: RunDeps): Promise<string> {
  const lineage = await toCorrectionRequired(r, deps);
  git(r.repo, "commit", "-q", "-am", "x");
  writeFileSync(join(r.repo, "b.txt"), "bee\ny\n");
  git(r.repo, "commit", "-q", "-am", "y");
  writeFileSync(join(r.repo, "b.txt"), "bee\ny\nz\n");
  return lineage;
}

test("an unsafe state file of an UNRELATED lineage (hardlink, symlink) blocks a lineage-less run: nothing written, no reviewer, no new lineage", async () => {
  for (const shape of ["hardlink", "symlink"] as const) {
    await withRepo(async (r) => {
      const { runner, calls } = fakeRunner({ findings: { risk: [SEVERE] } });
      const deps: RunDeps = { riskAssessor: assess("medium"), runner };
      const lineage = await unrelatedSetup(r, deps);
      const file = stateFileOf(r, lineage);
      const alias = join(r.repo, "..", "alias.json");
      if (shape === "hardlink") linkSync(file, alias);
      else {
        writeFileSync(alias, readFileSync(file));
        rmSync(file);
        symlinkSync(alias, file);
      }
      const h0 = sha256File(alias);
      const before = listLineages(r.commonDir).lineages.length;
      const n0 = calls.prompts.length;
      const out = is(await runReview(input(r), deps), "blocked");
      assert.equal(out.lineage_id, lineage, shape);
      assert.doesNotMatch(out.message, /is a pending correction/, shape);
      assert.match(out.message, /cannot be read safely; no new review is opened until it is repaired/, shape);
      assert.ok(out.message.includes(lineage), shape);
      assert.equal(calls.prompts.length, n0);
      assert.equal(listLineages(r.commonDir).lineages.length, before, "no new lineage");
      assert.equal(sha256File(alias), h0, "state bytes unchanged");
    });
  }
});

test("an oversized (>1 MiB) regular state file is skipped like any content error: a fresh review is offered", async () => {
  await withRepo(async (r) => {
    const { runner } = fakeRunner({ findings: { risk: [SEVERE] } });
    const deps: RunDeps = { riskAssessor: assess("medium"), runner };
    const lineage = await toCorrectionRequired(r, deps);
    const file = stateFileOf(r, lineage);
    // valid JSON that WOULD match this candidate if it were read: only the size cap keeps it out
    const cur = stateOf(r, lineage);
    writeFileSync(file, JSON.stringify({ state: "correction_required", base_tree: cur.base_tree, projection: cur.projection }) + " ".repeat((1 << 20) + 16));
    writeFileSync(join(r.repo, "a.txt"), FIXED_A);
    const h0 = sha256File(file);
    const out = await runReview(input(r), deps);
    assert.equal(out.outcome, "consent-required", JSON.stringify(out).slice(0, 300));
    assert.equal(sha256File(file), h0);
  });
});

test("an unreadable lineage about another candidate is skipped: a fresh review is offered", async () => {
  await withRepo(async (r) => {
    const { runner } = fakeRunner({ findings: { risk: [SEVERE] } });
    const deps: RunDeps = { riskAssessor: assess("medium"), runner };
    const lineage = await unrelatedSetup(r, deps);
    const cur = stateOf(r, lineage);
    const bogus = { ...cur, revision: `sha256:${"0".repeat(64)}` };
    writeFileSync(stateFileOf(r, lineage), JSON.stringify(bogus));
    assert.throws(() => readState(r.commonDir, lineage), (e: Error) => e.name === "StoreCorruptError");
    const out = await runReview(input(r), deps);
    assert.equal(out.outcome, "consent-required", JSON.stringify(out).slice(0, 300));
  });
});

test("A1: after a candidate-as-base correction, HEAD back on the original base with the corrected tree is target_already_acknowledged", async () => {
  await withRepo(async (r) => {
    const { runner } = fakeRunner({ findings: { risk: [SEVERE] } });
    const deps: RunDeps = { riskAssessor: assess("medium"), runner };
    const lineage = await toCorrectionRequired(r, deps);
    git(r.repo, "commit", "-q", "-am", "reviewed work");
    writeFileSync(join(r.repo, "a.txt"), FIXED_A);
    const closed = is((await forecastThenRun(r, lineage, deps)).done, "closed");
    git(r.repo, "commit", "-q", "-am", "fix");
    git(r.repo, "reset", "-q", "--soft", "HEAD~2");
    const view = reviewStatus(r.repo, {});
    assert.equal(view.target_identity, closed.target_identity, "same identity: original base + corrected tree");
    assert.equal(view.consumed.status, "consumed");
    assert.equal(view.next_transition.reason_code, "target_already_acknowledged");
  });
});

// ---- T2 / S3: reviewer runs follow the active profile route of their role ----

const routeOf = (calls: Calls): Record<string, string> =>
  Object.fromEntries(calls.roles.map((key, i) => [key, `${calls.opts[i]!.model ?? "-"}/${calls.opts[i]!.effort ?? "-"}`]));

async function withProfile(choose: ((dataDir: string) => void) | undefined, fn: (profileState: { dataDir: string }) => Promise<void>): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), "odd-run-profile-"));
  try {
    choose?.(dataDir);
    await fn({ dataDir });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

const CAPTURED_REFUTER_HELD = async (r: Repo, lineage: string): Promise<void> => {
  const rec = stateOf(r, lineage);
  const subject = lensArtifactSubject(r.commonDir, rec, "risk")!;
  const held = await captureLensResult(
    r.commonDir, lineage, rec.revision,
    { lens: "risk", subject, result: { subject_hash: subject.subject_hash, inspection: { status: "completed", paths: treeDiffPaths(r.commonDir, rec.base_tree, rec.candidate_tree) }, findings: [{ ...SEVERE, evidence_class: "inferential" }], evidence: ["x"] } },
    { awaitRefuter: true },
  );
  assert.equal(held.ok && held.state, "reviewing");
};

test("S3 balanced by default (no profile state): risk lens opus/medium, the other three lenses sonnet/medium", async () => {
  await withProfile(undefined, async (profileState) => {
    await withRepo(async (r) => {
      const lineage = await grant(r, "high");
      const { calls, runner } = fakeRunner();
      const { done } = await forecastThenRun(r, lineage, { riskAssessor: assess("high"), runner, profileState });
      is(done, "closed");
      assert.deepEqual(routeOf(calls), { risk: "opus/medium", resilience: "sonnet/medium", readability: "sonnet/medium", reliability: "sonnet/medium" });
    });
  });
});

test("S3 balanced by default: the refuter and the targeted validator run opus/medium", async () => {
  await withProfile(undefined, async (profileState) => {
    await withRepo(async (r) => {
      const lineage = await grant(r, "medium");
      await CAPTURED_REFUTER_HELD(r, lineage);
      const { calls, runner } = fakeRunner();
      is((await forecastThenRun(r, lineage, { riskAssessor: assess("medium"), runner, profileState })).done, "closed");
      assert.deepEqual(routeOf(calls), { refuter: "opus/medium" });
    });
    await withRepo(async (r) => {
      const lineage = await grant(r, "medium");
      const { calls, runner } = fakeRunner({ findings: { risk: [SEVERE] } });
      const deps: RunDeps = { riskAssessor: assess("medium"), runner, profileState };
      is((await forecastThenRun(r, lineage, deps)).done, "input-required");
      writeFileSync(join(r.repo, "a.txt"), "ONE\nTWO\nthree\nfour\nfive\n");
      const forecast = is(await runReview(input(r, { lineageId: lineage }), deps), "forecast");
      is(await runReview(input(r, { lineageId: lineage, reviewerRunAcknowledged: true, reviewerRunBinding: forecast.reviewer_run_binding }), deps), "closed");
      assert.deepEqual(routeOf(calls), { risk: "opus/medium", validator: "opus/medium" });
    });
  });
});

test("S3 economy stored: lenses haiku without effort, refuter and validator sonnet/medium", async () => {
  await withProfile((dataDir) => useProfile("economy", { dataDir }), async (profileState) => {
    await withRepo(async (r) => {
      const lineage = await grant(r, "high");
      const { calls, runner } = fakeRunner();
      is((await forecastThenRun(r, lineage, { riskAssessor: assess("high"), runner, profileState })).done, "closed");
      assert.deepEqual(routeOf(calls), { risk: "haiku/-", resilience: "haiku/-", readability: "haiku/-", reliability: "haiku/-" });
    });
    await withRepo(async (r) => {
      const lineage = await grant(r, "medium");
      await CAPTURED_REFUTER_HELD(r, lineage);
      const { calls, runner } = fakeRunner();
      is((await forecastThenRun(r, lineage, { riskAssessor: assess("medium"), runner, profileState })).done, "closed");
      assert.deepEqual(routeOf(calls), { refuter: "sonnet/medium" });
    });
    await withRepo(async (r) => {
      const lineage = await grant(r, "medium");
      const { calls, runner } = fakeRunner({ findings: { risk: [SEVERE] } });
      const deps: RunDeps = { riskAssessor: assess("medium"), runner, profileState };
      is((await forecastThenRun(r, lineage, deps)).done, "input-required");
      writeFileSync(join(r.repo, "a.txt"), "ONE\nTWO\nthree\nfour\nfive\n");
      const forecast = is(await runReview(input(r, { lineageId: lineage }), deps), "forecast");
      is(await runReview(input(r, { lineageId: lineage, reviewerRunAcknowledged: true, reviewerRunBinding: forecast.reviewer_run_binding }), deps), "closed");
      assert.deepEqual(routeOf(calls), { risk: "haiku/-", validator: "sonnet/medium" });
    });
  });
});

test("S3 an explicit caller model wins for every role (and keeps the caller's effort handling)", async () => {
  await withProfile(undefined, async (profileState) => {
    await withRepo(async (r) => {
      const lineage = await grant(r, "high");
      const { calls, runner } = fakeRunner();
      is((await forecastThenRun(r, lineage, { riskAssessor: assess("high"), runner, profileState }, { model: "haiku" })).done, "closed");
      assert.deepEqual(routeOf(calls), { risk: "haiku/-", resilience: "haiku/-", readability: "haiku/-", reliability: "haiku/-" });
    });
    await withRepo(async (r) => {
      const lineage = await grant(r, "medium");
      await CAPTURED_REFUTER_HELD(r, lineage);
      const { calls, runner } = fakeRunner();
      is((await forecastThenRun(r, lineage, { riskAssessor: assess("medium"), runner, profileState }, { model: "sonnet", effort: "high" })).done, "closed");
      assert.deepEqual(routeOf(calls), { refuter: "sonnet/high" });
    });
  });
});

test("S3 an unreadable profile state never throws: the review runs with the balanced route", async () => {
  await withProfile(undefined, async () => {
    await withRepo(async (r) => {
      const lineage = await grant(r, "medium");
      const { calls, runner } = fakeRunner();
      const profileState = { dataDir: "relative/not/absolute" };
      is((await forecastThenRun(r, lineage, { riskAssessor: assess("medium"), runner, profileState })).done, "closed");
      assert.deepEqual(routeOf(calls), { risk: "opus/medium" });
    });
  });
});

test("S3 integration (fake claude binary): the argument vector differs from the explicit-model one only by --model/--effort", async () => {
  await withProfile(undefined, async (profileState) => {
    await withRepo(async (r) => {
      const lineage = await grant(r, "medium");
      const fake = fakeFor(r, lineage, (hash, paths) => JSON.stringify({ subject_hash: hash, inspection: { status: "completed", paths }, findings: [], evidence: ["read it all"] }));
      try {
        is((await forecastThenRun(r, lineage, { profileState }, { claudePath: fake.binary })).done, "closed");
        const rec = JSON.parse(readFileSync(fake.recordFile, "utf8")) as FakeRecord;
        assert.deepEqual(rec.args, [...REVIEWER_ARGUMENTS, "--model", "opus", "--effort", "medium"]);
        assert.equal(reviewerArguments({ model: "opus", effort: "medium" }).join("\0"), rec.args.join("\0"));
      } finally {
        rmSync(fake.dir, { recursive: true, force: true });
      }
    });
  });
});
