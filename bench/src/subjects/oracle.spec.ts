// The oracle subject: plumbing (isolation env, telemetry off, version capture), the mapping table, the support/divergence tables, the CLI
// options, and the journeys executed against the REAL upstream binary (skipped with a clear message when it is absent).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expectedProjection, runJourney, toJourney, type JourneyDef, type JourneyResultRow } from "../journey.js";
import { blocksTotal } from "../metrics.js";
import { buildResult } from "../report.js";
import { validateResult } from "../schema.js";
import { createSandbox } from "../sandbox.js";
import { runProcess } from "../process.js";
import { JOURNEY_DEFS } from "../journeys/index.js";
import { outputPaths, parse } from "../cli.js";
import {
  DIVERGENCES, MAPPING, ORACLE_DEFAULT_BINARY, captureOracleVersion, invocationArgs, mapValue, oracleAvailable, oracleBinaryPath, oracleEnv, oracleExpected, oracleSubject, oracleUnsupportedReason, refusalReason,
} from "./oracle.js";

const skip = oracleAvailable() ? false : `oracle binary not found at ${oracleBinaryPath()}: set ODD_BENCH_ORACLE_BIN to run the oracle journeys`;
const byId = (id: string): JourneyDef => {
  const d = JOURNEY_DEFS.find((x) => x.id === id);
  assert.ok(d, `unknown journey ${id}`);
  return d;
};

// ---- plumbing: isolation and telemetry ----

test("the oracle env is the sandbox env plus the product's own switches: telemetry off at three levels, every location inside the sandbox, no parent variable", async () => {
  const leaked = { ANTHROPIC_API_KEY: "dummy-not-a-secret", CLAUDE_CODE_OAUTH_TOKEN: "dummy", AWS_PROFILE: "dummy", GENTLE_AI_TELEMETRY: "1", DO_NOT_TRACK: "0", GENTLE_AI_TELEMETRY_ENDPOINT: "https://real.example/", GENTLE_AI_HOME: "/nonexistent/real" };
  const saved = Object.fromEntries(Object.keys(leaked).map((k) => [k, process.env[k]]));
  Object.assign(process.env, leaked);
  const sb = await createSandbox();
  try {
    const env = oracleEnv(sb.env);
    assert.equal(env.DO_NOT_TRACK, "1", "first kill switch in the product's precedence order");
    assert.equal(env.GENTLE_AI_TELEMETRY, "0", "second kill switch");
    assert.match(env.GENTLE_AI_TELEMETRY_ENDPOINT ?? "", /^http:\/\/127\.0\.0\.1:9\//, "the collector endpoint is a closed loopback port, never the real server");
    assert.deepEqual(Object.keys(env).filter((k) => /^(ANTHROPIC_|AWS_|CLAUDE_CODE)/.test(k)), []);
    assert.deepEqual(Object.keys(env).filter((k) => /^GENTLE/.test(k)).sort(), ["GENTLE_AI_TELEMETRY", "GENTLE_AI_TELEMETRY_ENDPOINT"], "the only GENTLE_* variables are the telemetry switches");
    for (const k of ["HOME", "USERPROFILE", "CLAUDE_PLUGIN_DATA", "CLAUDE_CONFIG_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "GIT_CONFIG_GLOBAL"]) {
      assert.ok(typeof env[k] === "string" && env[k]!.startsWith(`${sb.root}/`), `${k}=${String(env[k])} is inside the sandbox`);
    }
    assert.ok(env.PATH!.startsWith(`${sb.root}/bin:`), "the git counter and the fake claude come first on PATH");
    const child = await runProcess(process.execPath, ["-e", "process.stdout.write(JSON.stringify(process.env))"], { cwd: sb.repo, env, deadlineMs: 10_000 });
    const seen = JSON.parse(child.stdout) as Record<string, string>;
    for (const k of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "AWS_PROFILE", "GENTLE_AI_HOME"]) assert.equal(seen[k], undefined, k);
    assert.equal(seen.DO_NOT_TRACK, "1");
    assert.equal(seen.GENTLE_AI_TELEMETRY, "0");
  } finally {
    sb.cleanup();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test("the default oracle binary is the pinned 4.6.0 install, overridable with ODD_BENCH_ORACLE_BIN", () => {
  assert.match(ORACLE_DEFAULT_BINARY, /gentle-ai-4\.6\.0\/bin\/gentle-ai$/);
  const saved = process.env.ODD_BENCH_ORACLE_BIN;
  try {
    delete process.env.ODD_BENCH_ORACLE_BIN;
    assert.equal(oracleBinaryPath(), ORACLE_DEFAULT_BINARY);
    process.env.ODD_BENCH_ORACLE_BIN = "/nonexistent/gentle-ai";
    assert.equal(oracleBinaryPath(), "/nonexistent/gentle-ai");
    assert.equal(oracleAvailable(), false);
  } finally {
    if (saved === undefined) delete process.env.ODD_BENCH_ORACLE_BIN; else process.env.ODD_BENCH_ORACLE_BIN = saved;
  }
});

test("the real binary, run in the oracle env, reports its version and sees telemetry disabled by each switch", { skip }, async () => {
  const version = await captureOracleVersion();
  assert.match(version, /^\d+\.\d+\.\d+/, "version recorded for the run metadata");
  const sb = await createSandbox();
  try {
    const status = async (env: NodeJS.ProcessEnv): Promise<Record<string, unknown>> => JSON.parse((await runProcess(oracleBinaryPath(), ["telemetry", "status", "--json"], { cwd: sb.repo, env, deadlineMs: 20_000 })).stdout) as Record<string, unknown>;
    const full = await status(oracleEnv(sb.env));
    assert.deepEqual([full.enabled, full.source], [false, "DO_NOT_TRACK"]);
    const { DO_NOT_TRACK: _dnt, ...withoutFirst } = oracleEnv(sb.env);
    const second = await status(withoutFirst);
    assert.deepEqual([second.enabled, second.source], [false, "GENTLE_AI_TELEMETRY"], "either switch alone disables it");
    assert.equal(existsSync(`${sb.home}/.gentle-ai`), true, "the product keeps its state under the sandbox HOME");
  } finally {
    sb.cleanup();
  }
});

test("a missing oracle binary is reported, not faked", async () => {
  const saved = process.env.ODD_BENCH_ORACLE_BIN;
  process.env.ODD_BENCH_ORACLE_BIN = "/nonexistent/gentle-ai";
  try {
    await assert.rejects(captureOracleVersion(), /ENOENT|did not report a version/);
    const row = await runJourney(toJourney(byId("low-risk-closes-with-zero-lenses"), oracleSubject));
    assert.equal(row.status, "failed");
    assert.match(row.reason ?? "", /oracle binary not found: \/nonexistent\/gentle-ai/);
  } finally {
    if (saved === undefined) delete process.env.ODD_BENCH_ORACLE_BIN; else process.env.ODD_BENCH_ORACLE_BIN = saved;
  }
});

// ---- the mapping table ----

test("the mapping table has one commented row per upstream value and maps into the odd vocabulary only", () => {
  assert.equal(new Set(MAPPING.map((r) => `${r.kind}|${r.upstream}`)).size, MAPPING.length, "one row per (kind, upstream value)");
  for (const r of MAPPING) assert.ok(r.comment.length >= 8, `row ${r.kind}:${r.upstream} carries its comment`);
  const vocab: Record<string, string[]> = {
    risk: ["low", "medium", "high"],
    start: ["closed", "consent_required", "consented", "declined"],
    capture: ["approved", "correction_required", "escalated"],
    next: ["start", "acknowledge", "validate", "collect", "stop"],
    gate: ["allow", "deny"],
    reminder: ["remind", "silent"],
  };
  for (const r of MAPPING.filter((x) => x.kind !== "refusal")) assert.ok(vocab[r.kind]!.includes(r.odd), `${r.kind}:${r.upstream} -> ${r.odd}`);
  // the odd vocabulary the journeys expect is covered by the table's targets
  const used = new Set(JOURNEY_DEFS.flatMap((d) => d.steps.map((s) => s.expect.reason).filter(Boolean)));
  for (const reason of ["binding_drift", "unchanged_candidate"]) assert.ok(used.has(reason) && MAPPING.some((r) => r.kind === "refusal" && r.odd === reason), reason);
});

test("mapping: documented rows translate, an unknown upstream value is an error, and an unknown refusal keeps a visible name", () => {
  assert.equal(mapValue("risk", "passive"), "low");
  assert.equal(mapValue("start", "created"), "consented");
  assert.equal(mapValue("next", "execute:review.acknowledge-approved"), "acknowledge");
  assert.equal(mapValue("gate", "unmanaged"), "allow");
  assert.equal(mapValue("gate", "disabled/unmanaged"), "allow");
  assert.equal(mapValue("reminder", "block"), "remind");
  assert.equal(mapValue("reminder", ""), "silent");
  assert.throws(() => mapValue("risk", "catastrophic"), /no risk row for "catastrophic"/);
  assert.equal(refusalReason("stale_target_identity"), "binding_drift");
  assert.equal(refusalReason("corrected_candidate_unavailable"), "unchanged_candidate");
  assert.equal(refusalReason("rdd_disabled"), "oracle:rdd_disabled");
});

test("printed invocations split into arguments the way a shell would", () => {
  assert.deepEqual(invocationArgs("gentle-ai review start --cwd '/tmp/a b' --consent granted"), ["review", "start", "--cwd", "/tmp/a b", "--consent", "granted"]);
  assert.deepEqual(invocationArgs("gentle-ai review status --lineage=x --next-transition=true"), ["review", "status", "--lineage=x", "--next-transition=true"]);
});

// ---- what the oracle cannot express, and where it differs ----

test("unsupported: exactly the journeys that need a delivery denial, each with the product's reason", () => {
  const unsupported = JOURNEY_DEFS.filter((d) => oracleUnsupportedReason(d) !== undefined).map((d) => d.id).sort();
  assert.deepEqual(unsupported, [
    "gate-pr-open-allowed-after-receipt", "gate-pr-open-denied-unreviewed", "gate-push-allowed-after-receipt", "gate-push-allowed-when-declined", "gate-push-denied-unreviewed-high-risk",
    "workspace-review-does-not-authorize-committed-range",
  ]);
  for (const d of JOURNEY_DEFS) if (oracleUnsupportedReason(d) !== undefined) assert.match(oracleUnsupportedReason(d)!, /non-deciding.*delivery=unmanaged/);
  assert.equal(toJourney(byId("gate-push-denied-unreviewed-high-risk"), oracleSubject).unsupported, oracleUnsupportedReason(byId("gate-push-denied-unreviewed-high-risk")));
  assert.equal(toJourney(byId("gate-silent-with-rdd-off"), oracleSubject).unsupported, undefined);
});

test("divergences: the oracle's expected projection differs from the shared one only in the declared steps and in the product's default RDD mode", () => {
  for (const d of JOURNEY_DEFS) {
    const shared = (expectedProjection(d) as { steps: Record<string, unknown>[] }).steps;
    const own = (oracleExpected(d) as { steps: Record<string, unknown>[] }).steps;
    own.forEach((step, i) => {
      if (JSON.stringify(step) === JSON.stringify(shared[i])) return;
      const declared = DIVERGENCES.some((x) => x.journey === d.id && x.step === i);
      const defaultMode = d.steps[i]!.do.kind === "inspect" && step.mode === "on" && shared[i]!.mode === "off";
      assert.ok(declared || defaultMode, `${d.id} step ${i} differs without a declaration`);
    });
  }
  for (const x of DIVERGENCES) {
    assert.ok(byId(x.journey).steps[x.step], `${x.journey} step ${x.step} exists`);
    assert.ok(x.comment.length > 8);
  }
  const modeJourney = oracleExpected(byId("rdd-mode-global-and-clone-scopes")) as { steps: { mode?: string }[] };
  assert.equal(modeJourney.steps[2]!.mode, "off", "a mode the journey itself switched is not the product default");
  assert.equal((oracleExpected(byId("consent-declined-creates-no-review")) as { steps: { mode?: string }[] }).steps[2]!.mode, "on");
});

// ---- the CLI options ----

test("cli: --subject selects odd (default), oracle or both; both writes two results side by side", () => {
  assert.deepEqual(parse(["--out", "r.json"]), { out: "r.json", only: [], subject: "odd" });
  assert.equal(parse(["--out", "r.json", "--subject", "both"]).subject, "both");
  assert.match(parse(["--out", "r.json", "--subject", "upstream"]).error ?? "", /--subject must be odd, oracle or both/);
  assert.match(parse([]).error ?? "", /usage: bench --out/);
  assert.deepEqual(outputPaths("/tmp/x/r.json", "odd"), { odd: "/tmp/x/r.json" });
  assert.deepEqual(outputPaths("/tmp/x/r.json", "oracle"), { oracle: "/tmp/x/r.json" });
  assert.deepEqual(outputPaths("/tmp/x/r.json", "both"), { odd: "/tmp/x/r.odd.json", oracle: "/tmp/x/r.oracle.json" });
  assert.deepEqual(outputPaths("/tmp/x/out", "both"), { odd: "/tmp/x/out/odd.json", oracle: "/tmp/x/out/oracle.json" });
});

// ---- the journeys, against the real binary ----

const runs = new Map<string, Promise<JourneyResultRow>>();
const run = (id: string): Promise<JourneyResultRow> => {
  if (!runs.has(id)) runs.set(id, runJourney(toJourney(byId(id), oracleSubject)));
  return runs.get(id)!;
};

for (const d of JOURNEY_DEFS) {
  test(`oracle runs journey ${d.id}: ${oracleUnsupportedReason(d) !== undefined ? "unsupported with the product's reason" : "its normalized projection is the oracle's expected one"}`, { skip }, async () => {
    const row = await run(d.id);
    assert.equal(row.ref_id, d.refId);
    const reason = oracleUnsupportedReason(d);
    if (reason !== undefined) {
      assert.deepEqual([row.status, row.reason, row.outcome, row.metrics], ["unsupported", reason, null, null]);
      return;
    }
    assert.equal(row.status, "passed", JSON.stringify(row));
    assert.deepEqual(row.outcome, oracleExpected(d));
    const m = row.metrics!;
    assert.ok(m.commands_to_completion.value! >= 1);
    const ops = Object.keys(m.latency);
    assert.ok(ops.length >= 1 && ops.every((o) => /^cli\.[a-z_]+$/.test(o)), `latency per operation: ${ops.join()}`);
    for (const o of ops) assert.ok(m.latency[o]!.samples >= 1 && m.latency[o]!.median_ms > 0 && m.latency[o]!.p95_ms >= m.latency[o]!.median_ms, o);
  });
}

test("oracle accounting: low risk runs no model and asks no human; medium asks once (consent only: the product has no cost forecast) and runs one reviewer; high runs four", { skip }, async () => {
  const low = (await run("low-risk-closes-with-zero-lenses")).metrics!;
  // assess, the selectorless status the entry rule requires, start, acknowledge
  assert.deepEqual([low.model_runs.value, low.human_prompts.value, low.manual_tokens.value, low.commands_to_completion.value, blocksTotal(low.blocks.value!)], [0, 0, 0, 4, 0]);
  assert.ok(low.git_subprocesses.value! >= 1, "the binary shells out to git through the counted PATH");
  assert.equal(low.model_runs.derivation, "measured");
  const medium = (await run("medium-risk-one-lens-consent-capture-ack")).metrics!;
  // assess, status, start relay, consent answer, status, one capture, acknowledge
  assert.deepEqual([medium.model_runs.value, medium.human_prompts.value, medium.commands_to_completion.value, blocksTotal(medium.blocks.value!)], [1, 1, 7, 0]);
  assert.equal(medium.manual_tokens.value, Math.ceil(Buffer.byteLength("yes, review this change") / 4));
  const high = (await run("high-risk-four-lens-group")).metrics!;
  // status, start relay, consent answer, status step, status, four captures, acknowledge
  assert.deepEqual([high.model_runs.value, high.human_prompts.value, high.commands_to_completion.value], [4, 1, 10]);
  assert.ok(high.human_surface_bytes.value! > 0 && high.git_subprocesses.value! >= low.git_subprocesses.value!);
});

test("oracle accounting: a decline costs one human prompt and no model; a correction runs four lenses, the refuter and the validator", { skip }, async () => {
  const declined = (await run("consent-declined-creates-no-review")).metrics!;
  assert.deepEqual([declined.model_runs.value, declined.human_prompts.value], [0, 1]);
  const fix = (await run("correction-then-validator-approves")).metrics!;
  assert.deepEqual([fix.model_runs.value, fix.human_prompts.value, blocksTotal(fix.blocks.value!)], [6, 1, 0]);
});

test("oracle accounting: refusals and reminders are in-band blocks; a refused answer or hand-back starts no reviewer", { skip }, async () => {
  const noop = (await run("correction-noop-refused")).metrics!;
  assert.deepEqual([noop.blocks.value!.in_band, blocksTotal(noop.blocks.value!), noop.model_runs.value], [1, 1, 5]);
  const stale = (await run("binding-drift-after-consent-question")).metrics!;
  assert.deepEqual([stale.blocks.value!.in_band, stale.model_runs.value], [1, 0]);
  const stop = (await run("stop-reminds-once-per-session-and-candidate")).metrics!;
  assert.deepEqual([stop.blocks.value!.in_band, stop.commands_to_completion.value], [3, 4]);
});

// ---- the gate: deny/allow against the real binary ----

test("gate: the deny journeys are unsupported because the real binary never denies; the allow journeys run and pass", { skip }, async () => {
  for (const id of ["gate-push-denied-unreviewed-high-risk", "gate-pr-open-denied-unreviewed", "gate-push-allowed-after-receipt"]) {
    const row = await run(id);
    assert.equal(row.status, "unsupported", id);
    assert.match(row.reason ?? "", /non-deciding/);
  }
  for (const id of ["gate-silent-with-rdd-off", "gate-push-allowed-for-medium-risk-range"]) {
    const row = await run(id);
    assert.equal(row.status, "passed", JSON.stringify(row));
    const m = row.metrics!;
    assert.deepEqual([m.commands_to_completion.value, blocksTotal(m.blocks.value!), m.model_runs.value, m.human_prompts.value], [1, 0, 0, 0]);
    assert.deepEqual(Object.keys(m.latency), ["cli.review_validate"]);
  }
});

test("gate evidence: for the exact fixture the odd journey denies (unreviewed committed high-risk range, RDD on) the real binary reports an unmanaged allow, for a push and for a pull request alike", { skip }, async () => {
  const probe: JourneyDef = {
    id: "oracle-gate-evidence",
    description: "The binary's gate on a range the odd gate denies: it never decides, so both delivery checks come back as allow.",
    fixture: { change: "high", placement: "committed", origin: true, rdd: "on" },
    steps: [
      { do: { kind: "gateCheck", command: "push" }, expect: { outcome: "allow", gate: "allow" } },
      { do: { kind: "gateCheck", command: "prOpen" }, expect: { outcome: "allow", gate: "allow" } },
    ],
  };
  const row = await runJourney(toJourney(probe, oracleSubject));
  assert.equal(row.status, "passed", JSON.stringify(row));
  assert.equal(blocksTotal(row.metrics!.blocks.value!), 0);
});

// ---- result document ----

test("oracle rows, unsupported ones included, form a valid result document that records the binary version", { skip }, async () => {
  const rows = await Promise.all(JOURNEY_DEFS.map((d) => run(d.id)));
  const version = await captureOracleVersion();
  const res = buildResult("oracle", rows, { binaryPath: oracleBinaryPath(), binaryVersion: version, commit: "binary-only" });
  assert.deepEqual(validateResult(JSON.parse(JSON.stringify(res))), []);
  assert.equal(res.meta.subject, "oracle");
  assert.equal(res.meta.binary.version, version);
  const expectedUnsupported = JOURNEY_DEFS.filter((d) => oracleUnsupportedReason(d) !== undefined).length;
  assert.deepEqual(res.aggregate.counts, { passed: JOURNEY_DEFS.length - expectedUnsupported, failed: 0, unsupported: expectedUnsupported });
});

// ---- T8: the unmanaged gate marks its rows not_comparable ----

test("the default binary lives under the current user's home, derived from os.homedir(), with no username in the source or the docs", () => {
  assert.equal(ORACLE_DEFAULT_BINARY, join(homedir(), ".local/share/odd-claude-oracle/gentle-ai-4.6.0/bin/gentle-ai"));
  const user = userInfo().username;
  const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
  for (const f of ["bench/src/subjects/oracle.ts", "docs/bench.md", "docs/bench/findings.md", "docs/bench/baseline-2026-11-20/README.md", "docs/bench/baseline-2026-11-20/report.md", "docs/bench/baseline-2026-11-20/comparison.json", "docs/bench/baseline-2026-11-20/oracle.json", "odd/tasks/efficiency-bench.md"]) {
    const text = readFileSync(join(root, f), "utf8");
    assert.equal(text.includes(`/Users/${user}`) || text.includes(`/home/${user}`), false, `${f} names the home directory of ${user}`);
  }
});

test("a gate that reports delivery=unmanaged marks the row not_comparable; rows without a gate check carry no mark", { skip }, async () => {
  for (const id of ["gate-silent-with-rdd-off", "gate-push-allowed-for-medium-risk-range"]) {
    const row = await run(id);
    assert.equal(row.status, "passed", JSON.stringify(row));
    assert.equal(row.not_comparable?.length, 1, id);
    assert.match(row.not_comparable![0]!, /delivery=unmanaged/);
    assert.match(row.not_comparable![0]!, /near-zero|no win/);
  }
  const plain = await run("stop-silent-with-rdd-off");
  assert.equal("not_comparable" in plain, false);
});
