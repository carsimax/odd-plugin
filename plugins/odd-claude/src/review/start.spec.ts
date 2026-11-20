import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validate, type Schema } from "./schema.js";
import { burn, correctionBudget } from "./state.js";
import { listLineages, readState, updateState } from "./store.js";
import { offPathCommand, readDecline, REVIEW_CONTRACT } from "./consent.js";
import { startReview, START_SCHEMA, type RiskAssessment, type RiskAssessor, type StartInput, type StartOutcome } from "./start.js";
import { clone, INTEGRATION_ROOT, readJson } from "./fixtures.testkit.js";

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
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "odd-start-")));
  const repo = join(dir, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "one\ntwo\nthree\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  if (opts.dirty !== false) writeFileSync(join(repo, "a.txt"), "one\nTWO\nthree\nfour\nfive\n");
  return { repo, commonDir: realpathSync(join(repo, ".git")), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const assess = (level: RiskAssessment["level"], extra: Partial<RiskAssessment> = {}): RiskAssessor => () => ({
  level,
  reasons: [{ code: level === "low" ? "non_executable_only" : "shell_source", ...(level === "low" ? {} : { signal: "shell_process", path: "a.txt" }) }],
  evidence: level === "low" ? [] : ["shell scripting in a.txt"],
  ...extra,
});

const base = (r: Repo, level: RiskAssessment["level"], over: Partial<StartInput> = {}): StartInput => ({
  cwd: r.repo,
  target: { kind: "current-changes" },
  consent: "granted",
  riskAssessor: assess(level),
  ...over,
});

const stateRoot = (r: Repo) => join(r.commonDir, "odd-plugin", "review-transactions");

// ---- structural validation against the vendored schemas (ids mapped to odd-claude) ----

const V2 = join(INTEGRATION_ROOT, "v2", "schemas");
const load = (id: string): unknown => JSON.parse(readFileSync(id, "utf8"));

function violations(file: string, patch: (s: any) => void, value: unknown): string[] {
  const path = join(V2, file);
  const schema = clone(readJson(path)) as any;
  patch(schema);
  return validate(schema as Schema, value, { base: path, load });
}

const consentViolations = (v: unknown) =>
  violations(
    "consent-v3.schema.json",
    (s) => {
      s.properties.schema.const = "odd-claude.review-integration.consent/v3";
      s.properties.contract.const = REVIEW_CONTRACT;
      s.properties.off_path.properties.command.const = offPathCommand();
      s.$defs.choice.properties.invocation.pattern = "^review_answer_consent --contract odd-claude\\.review-integration/v2 .+ --consent (granted|declined)$";
    },
    v,
  );

// The start schema's conditional blocks demand repository_context, next_transition, the changed-path manifest and the
// transition-execution acknowledgement, which belong to U10/U15; they are dropped here, every other rule is checked.
const startViolations = (v: unknown) =>
  violations(
    "start-v4.schema.json",
    (s) => {
      s.properties.schema.const = START_SCHEMA;
      s.properties.contract.const = REVIEW_CONTRACT;
      delete s.allOf;
      s.properties.acknowledgement = true; // own acknowledgement shape; the schema's one belongs to the transition contract
      delete s.dependentRequired.target_identity; // target_mode is only defined for the overlay kind in the reference schema
      delete s.dependentRequired.target_mode;
    },
    v,
  );

function started(o: StartOutcome) {
  assert.equal(o.status, "started", JSON.stringify(o));
  if (o.status !== "started") throw new Error("unreachable");
  return o.result;
}

test("empty diff is not_due and touches no store", async () => {
  const r = makeRepo({ dirty: false });
  try {
    const o = await startReview(base(r, "high"));
    assert.deepEqual(o, { status: "not_due", reason: "no_changes", kind: "current-changes", projection: "workspace" });
    assert.equal(existsSync(join(r.commonDir, "odd-plugin")), false);
  } finally {
    r.cleanup();
  }
});

test("low risk: approved immediately, token returned once, no consent needed", async () => {
  const r = makeRepo();
  try {
    const result = started(await startReview(base(r, "low", { consent: "relay" })));
    assert.equal(result.action, "closed");
    assert.equal(result.state, "approved");
    assert.deepEqual(result.selected_lenses, []);
    assert.equal(result.lenses_required, false);
    assert.deepEqual(startViolations(result), []);
    const ack = result.acknowledgement!;
    assert.match(ack.token, /^[0-9a-f]{64}$/);
    assert.equal(ack.lineage_id, result.lineage_id);
    assert.equal(ack.target_identity, result.target_identity);
    const rec = readState(r.commonDir, result.lineage_id);
    assert.equal(rec.revision, ack.expected_revision);
    assert.equal(rec.state, "approved");
    assert.equal(JSON.stringify(rec).includes(ack.token), false, "raw token is never stored");
    assert.equal(burn(rec, { now: new Date().toISOString(), token: ack.token }).ok, true);
    // a later replay never reveals the token again
    const again = started(await startReview(base(r, "low")));
    assert.equal(again.action, "replayed");
    assert.equal(again.acknowledgement, undefined);
  } finally {
    r.cleanup();
  }
});

for (const level of ["medium", "high"] as const) {
  test(`${level} risk with relay returns a consent v3 envelope and creates no state`, async () => {
    const r = makeRepo();
    try {
      const o = await startReview(base(r, level, { consent: "relay" }));
      assert.equal(o.status, "consent_required");
      if (o.status !== "consent_required") return;
      const e = o.envelope;
      assert.deepEqual(consentViolations(e), []);
      assert.equal(e.risk_level, level);
      assert.equal(e.blocking, true);
      assert.deepEqual(e.choices.map((c) => c.answer), ["granted", "declined"]);
      assert.deepEqual(e.risk_evidence, ["shell scripting in a.txt"]);
      assert.equal(e.changed_files, 1);
      assert.match(e.choices[0].invocation, /--target current-changes /);
      assert.match(e.choices[0].invocation, new RegExp(`--target-identity ${e.target_identity} `));
      assert.match(e.choices[1].invocation, / --consent declined$/);
      assert.doesNotMatch(JSON.stringify(e), /odd-claude review start|gentle/);
      assert.equal(existsSync(stateRoot(r)), false, "no store created");
      assert.equal(existsSync(join(r.commonDir, "odd-plugin", "declines")), false);
    } finally {
      r.cleanup();
    }
  });
}

test("relay envelope carries the explicit lenses and the base-diff target flags; es locale is localized", async () => {
  const r = makeRepo();
  try {
    git(r.repo, "checkout", "-q", "-b", "feat");
    git(r.repo, "commit", "-q", "-am", "work");
    const o = await startReview(
      base(r, "medium", { consent: "relay", target: { kind: "base-diff", baseRef: "main", committedOnly: true }, lenses: ["review-reliability"], lensesReason: "it's a retry loop", locale: "es-MX" }),
    );
    assert.equal(o.status, "consent_required");
    if (o.status !== "consent_required") return;
    assert.deepEqual(consentViolations(o.envelope), []);
    const inv = o.envelope.choices[0].invocation;
    assert.match(inv, /--target base-diff --base-ref main --committed-only /);
    assert.match(inv, /--lenses reliability --lenses-reason 'it'\\''s a retry loop'/);
    assert.match(o.envelope.headline, /revisión/);
  } finally {
    r.cleanup();
  }
});

test("declined records a candidate-scoped decline atomically and creates no state", async () => {
  const r = makeRepo();
  try {
    const o = await startReview(base(r, "high", { consent: "declined", now: () => "2026-02-03T04:05:06.000Z" }));
    assert.equal(o.status, "declined");
    if (o.status !== "declined") return;
    const rec = readDecline(r.commonDir, o.target_identity);
    assert.deepEqual(rec, {
      schema: "odd-claude.review-decline/v1",
      target_identity: o.target_identity,
      projection: "workspace",
      risk_level: "high",
      declined_at: "2026-02-03T04:05:06.000Z",
    });
    assert.equal(o.record_path, join(r.commonDir, "odd-plugin", "declines", `${o.target_identity.slice(7)}.json`));
    assert.equal(existsSync(stateRoot(r)), false);
    assert.deepEqual(readdirSync(join(r.commonDir, "odd-plugin", "declines")), [`${o.target_identity.slice(7)}.json`], "no temp files left");
    // a second decline keeps the first record
    await startReview(base(r, "high", { consent: "declined", now: () => "2030-01-01T00:00:00.000Z" }));
    assert.equal(readDecline(r.commonDir, o.target_identity)!.declined_at, "2026-02-03T04:05:06.000Z");
    // a different candidate is not covered by the decline
    writeFileSync(join(r.repo, "a.txt"), "other\n");
    const next = await startReview(base(r, "high", { consent: "relay" }));
    assert.equal(next.status, "consent_required");
  } finally {
    r.cleanup();
  }
});

test("granted creates a readable state with the frozen identity, lenses and budget", async () => {
  const r = makeRepo();
  try {
    for (const [level, lenses] of [
      ["medium", ["review-risk"]],
      ["high", ["review-risk", "review-resilience", "review-readability", "review-reliability"]],
    ] as const) {
      writeFileSync(join(r.repo, "a.txt"), `${level}\n`.repeat(3));
      const result = started(await startReview(base(r, level)));
      assert.equal(result.action, "created");
      assert.equal(result.state, "reviewing");
      assert.deepEqual(result.selected_lenses, lenses);
      assert.match(result.lineage_id, /^review-[0-9a-f]{16}$/);
      assert.equal(result.acknowledgement, undefined);
      assert.deepEqual(startViolations(result), []);
      const rec = readState(r.commonDir, result.lineage_id);
      assert.equal(rec.state, "reviewing");
      assert.equal(rec.target_identity, result.target_identity);
      assert.equal(rec.risk_level, level);
      assert.deepEqual(rec.selected_lenses, lenses.map((l) => l.slice(7)));
      assert.equal(rec.correction_budget, correctionBudget(rec.original_changed_lines));
      assert.equal(result.correction_budget, rec.correction_budget);
      assert.equal(result.changed_lines, rec.original_changed_lines);
      assert.equal(result.changed_files, 1);
      assert.equal(rec.base_tree, result.base_tree);
      assert.equal(rec.candidate_tree, result.candidate_tree);
    }
  } finally {
    r.cleanup();
  }
});

test("medium focusLens from the assessor picks the lens", async () => {
  const r = makeRepo();
  try {
    const result = started(await startReview(base(r, "medium", { riskAssessor: assess("medium", { focusLens: "readability" }) })));
    assert.deepEqual(result.selected_lenses, ["review-readability"]);
  } finally {
    r.cleanup();
  }
});

test("explicit lens selection: honored when storable, refused otherwise", async () => {
  const r = makeRepo();
  try {
    const refusal = async (over: Partial<StartInput>, level: RiskAssessment["level"] = "medium") => {
      const o = await startReview(base(r, level, over));
      assert.equal(o.status, "refused", JSON.stringify(o));
      return o.status === "refused" ? o : (undefined as never);
    };
    assert.equal((await refusal({ lenses: ["review-nonsense"], lensesReason: "x" })).code, "invalid_lenses");
    assert.equal((await refusal({ lenses: ["risk", "risk"], lensesReason: "x" }, "high")).code, "invalid_lenses");
    assert.equal((await refusal({ lenses: ["readability", "risk"], lensesReason: "x" }, "high")).code, "invalid_lenses");
    assert.equal((await refusal({ lenses: [], lensesReason: "x" })).code, "invalid_lenses");
    assert.equal((await refusal({ lenses: ["risk", "resilience", "readability", "reliability", "risk"], lensesReason: "x" }, "high")).code, "invalid_lenses");
    assert.equal((await refusal({ lenses: ["risk"] })).code, "invalid_lenses", "reason required");
    assert.equal((await refusal({ lenses: ["risk"], lensesReason: "  " })).code, "invalid_lenses");
    assert.equal((await refusal({ lenses: ["risk"], lensesReason: "x".repeat(501) })).code, "invalid_lenses");
    assert.equal((await refusal({ lensesReason: "orphan" })).code, "invalid_lenses");
    assert.equal((await refusal({ lenses: ["risk"], lensesReason: "x" }, "low")).code, "invalid_lenses");
    assert.equal((await refusal({ lenses: ["risk", "reliability"], lensesReason: "x" })).code, "invalid_lenses", "medium holds exactly one lens");
    assert.equal(existsSync(stateRoot(r)), false, "refusals create nothing");

    const ok = started(await startReview(base(r, "medium", { lenses: ["reliability"], lensesReason: "retry logic" })));
    assert.deepEqual(ok.selected_lenses, ["review-reliability"]);
    assert.deepEqual(readState(r.commonDir, ok.lineage_id).selected_lenses, ["reliability"]);
  } finally {
    r.cleanup();
  }
});

test("high risk honors an explicit pertinent subset and stores exactly those lenses", async () => {
  const r = makeRepo();
  try {
    const ok = started(await startReview(base(r, "high", { lenses: ["risk", "reliability"], lensesReason: "auth + retries" })));
    assert.deepEqual(ok.selected_lenses, ["review-risk", "review-reliability"]);
    assert.equal(ok.state, "reviewing");
    assert.deepEqual(startViolations(ok), []);
    assert.deepEqual(readState(r.commonDir, ok.lineage_id).selected_lenses, ["risk", "reliability"]);
    // the relay envelope replays the subset
    writeFileSync(join(r.repo, "a.txt"), "next\n");
    const o = await startReview(base(r, "high", { consent: "relay", lenses: ["readability"], lensesReason: "naming" }));
    assert.equal(o.status, "consent_required");
    if (o.status === "consent_required") assert.match(o.envelope.choices[0].invocation, /--lenses readability --lenses-reason naming/);
  } finally {
    r.cleanup();
  }
});

test("explicit full lens set is honored for high risk", async () => {
  const r = makeRepo();
  try {
    const all = ["risk", "resilience", "readability", "reliability"];
    const ok = started(await startReview(base(r, "high", { lenses: all, lensesReason: "whole 4R" })));
    assert.deepEqual(readState(r.commonDir, ok.lineage_id).selected_lenses, all);
  } finally {
    r.cleanup();
  }
});

test("a repeated START for the same candidate replays the live lineage, even under relay", async () => {
  const r = makeRepo();
  try {
    const first = started(await startReview(base(r, "high")));
    const second = started(await startReview(base(r, "high")));
    assert.equal(second.action, "replayed");
    assert.equal(second.lineage_id, first.lineage_id);
    assert.equal(second.state, "reviewing");
    assert.deepEqual(startViolations(second), []);
    const viaRelay = started(await startReview(base(r, "high", { consent: "relay" })));
    assert.equal(viaRelay.lineage_id, first.lineage_id);
    assert.deepEqual(listLineages(r.commonDir).lineages, [first.lineage_id]);
  } finally {
    r.cleanup();
  }
});

test("a burned candidate is refused with target_already_acknowledged", async () => {
  const r = makeRepo();
  try {
    const first = started(await startReview(base(r, "low")));
    const ack = first.acknowledgement!;
    await updateState(r.commonDir, first.lineage_id, ack.expected_revision, (rec) => burn(rec, { now: new Date().toISOString(), token: ack.token }));
    for (const consent of ["granted", "relay", "declined"] as const) {
      const o = await startReview(base(r, "low", { consent }));
      assert.deepEqual(o, { status: "refused", code: "target_already_acknowledged", message: "this candidate was already reviewed and acknowledged", lineage_id: first.lineage_id });
    }
    assert.deepEqual(listLineages(r.commonDir).lineages, [first.lineage_id]);
  } finally {
    r.cleanup();
  }
});

test("concurrent STARTs for one candidate create exactly one lineage", async () => {
  const r = makeRepo();
  try {
    const outcomes = await Promise.all(Array.from({ length: 8 }, () => startReview(base(r, "high"))));
    const results = outcomes.map(started);
    assert.equal(new Set(results.map((x) => x.lineage_id)).size, 1);
    assert.equal(results.filter((x) => x.action === "created").length, 1);
    assert.equal(results.filter((x) => x.action === "replayed").length, 7);
    assert.equal(listLineages(r.commonDir).lineages.length, 1);
  } finally {
    r.cleanup();
  }
});

test("a different candidate gets its own lineage", async () => {
  const r = makeRepo();
  try {
    const a = started(await startReview(base(r, "medium")));
    writeFileSync(join(r.repo, "a.txt"), "changed again\n");
    const b = started(await startReview(base(r, "medium")));
    assert.notEqual(a.lineage_id, b.lineage_id);
    assert.notEqual(a.target_identity, b.target_identity);
    assert.equal(listLineages(r.commonDir).lineages.length, 2);
  } finally {
    r.cleanup();
  }
});

test("bad input and bad risk assessments are refused before anything is written", async () => {
  const r = makeRepo();
  try {
    const refused = async (over: Partial<StartInput>) => {
      const o = await startReview(base(r, "high", over));
      assert.equal(o.status, "refused");
      return o.status === "refused" ? o.code : "";
    };
    assert.equal(await refused({ consent: "maybe" as never }), "invalid_input");
    assert.equal(await refused({ target: { kind: "bogus" } as never }), "invalid_input");
    assert.equal(await refused({ target: { kind: "base-diff", baseRef: "" } }), "invalid_input");
    assert.equal(await refused({ projection: "nope" as never }), "invalid_input");
    assert.equal(await refused({ riskAssessor: (() => ({ level: "extreme", reasons: [], evidence: [] })) as never }), "invalid_risk_assessment");
    assert.equal(await refused({ riskAssessor: assess("high", { reasons: [] }) }), "invalid_risk_assessment");
    assert.equal(existsSync(stateRoot(r)), false);
  } finally {
    r.cleanup();
  }
});

test("staged projection freezes the index and reports it", async () => {
  const r = makeRepo();
  try {
    git(r.repo, "add", "a.txt");
    const result = started(await startReview(base(r, "medium", { projection: "staged" })));
    assert.equal(result.projection, "staged");
    assert.equal(readState(r.commonDir, result.lineage_id).projection, "staged");
  } finally {
    r.cleanup();
  }
});

test("expectedTargetIdentity: a different candidate is refused with binding_drift and nothing is written; the right one starts", async () => {
  const r = makeRepo();
  try {
    const consent = await startReview(base(r, "medium", { consent: "relay" }));
    assert.equal(consent.status, "consent_required");
    if (consent.status !== "consent_required") return;
    const wrong = `sha256:${"0".repeat(64)}`;
    const drift = await startReview(base(r, "medium", { consent: "granted", expectedTargetIdentity: wrong }));
    assert.equal(drift.status, "refused");
    if (drift.status === "refused") assert.equal(drift.code, "binding_drift");
    assert.deepEqual(listLineages(r.commonDir).lineages, []);
    const declined = await startReview(base(r, "medium", { consent: "declined", expectedTargetIdentity: wrong }));
    assert.equal(declined.status, "refused");
    assert.equal(readDecline(r.commonDir, consent.envelope.target_identity), undefined);
    const ok = await startReview(base(r, "medium", { consent: "granted", expectedTargetIdentity: consent.envelope.target_identity }));
    assert.equal(ok.status, "started");
    assert.equal(listLineages(r.commonDir).lineages.length, 1);
  } finally {
    r.cleanup();
  }
});
