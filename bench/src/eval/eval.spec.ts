import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { buildClaudeArgv } from "./argv.js";
import { main, parseArgs } from "./cli.js";
import { buildRunEnv, hasAuthEnv, prepareIsolation, runDirs } from "./isolation.js";
import { renderReport } from "./report.js";
import { planRuns, runEval, runOne, type EvalOptions, type RunRecord } from "./runner.js";
import { parseStream } from "./stream.js";
import { summarize } from "./stats.js";
import { loadTasks } from "./tasks.js";
import { goodStream, installFakeClaude, makeTask, scratch } from "./fixtures.js";

const dirs: string[] = [];
const tmp = (): string => { const d = scratch(); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const logOf = (f: string): Record<string, any>[] => (existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

function setup(over: Partial<Parameters<typeof installFakeClaude>[1]> = {}, taskOver = {}): { root: string; tasksDir: string; log: string; opts: EvalOptions } {
  const root = tmp(), tasksDir = join(root, "tasks"), log = join(root, "calls.log");
  makeTask(tasksDir, "t1", taskOver);
  const claudeBin = installFakeClaude(root, { logFile: log, stdout: goodStream(), ...over });
  const opts: EvalOptions = {
    tasks: loadTasks(tasksDir), arms: ["none", "coord-on", "coord-off"], trials: 1, pluginDir: join(root, "plugin"), claudeBin, model: "opus",
    maxBudgetUsd: 1, maxTurns: 5, totalBudgetUsd: 70, outDir: join(root, "out"),
    baseEnv: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, ANTHROPIC_API_KEY: "k", SECRET_PARENT_VAR: "leak", CLAUDE_CONFIG_DIR: "/real/.claude", CLAUDE_PLUGIN_DATA: "/real/data" },
  };
  return { root, tasksDir, log, opts };
}

describe("argv", () => {
  const base = { prompt: "P", pluginDir: "/p", model: "opus", maxTurns: 9, maxBudgetUsd: 1.5 };
  test("none arm: no plugin-dir; never --bare nor a bypass flag", () => {
    const a = buildClaudeArgv({ ...base, arm: "none" });
    assert.ok(!a.includes("--plugin-dir"));
    assert.ok(!a.includes("--bare") && !a.some((x) => /dangerously|bypass/i.test(x)));
    assert.equal(a[a.indexOf("--permission-mode") + 1], "dontAsk");
    assert.equal(a[a.indexOf("--setting-sources") + 1], "");
    assert.equal(a[a.indexOf("--max-turns") + 1], "9");
    assert.equal(a[a.indexOf("--max-budget-usd") + 1], "1.5");
    assert.match(a[a.indexOf("--allowedTools") + 1], /^Agent,Read,Edit,Write,Glob,Grep,Bash\(node \*\),Bash\(npm \*\),Bash\(git \*\)$/);
    assert.equal(a.at(-1), "P");
    assert.ok(a.includes("--no-session-persistence") && a.includes("--verbose"));
  });
  test("coord arms: plugin-dir", () => {
    for (const arm of ["coord-on", "coord-off"] as const) { const a = buildClaudeArgv({ ...base, arm }); assert.equal(a[a.indexOf("--plugin-dir") + 1], "/p"); assert.ok(!a.includes("--bare")); }
  });
});

describe("isolation", () => {
  test("env is built from scratch with private dirs and delegation state per arm", () => {
    const root = tmp(), d = runDirs(root);
    const base = { PATH: "/bin", ANTHROPIC_API_KEY: "k", SECRET_PARENT_VAR: "x", CLAUDE_CONFIG_DIR: "/real", CLAUDE_PLUGIN_DATA: "/real/d", CLAUDE_CODE_PLUGIN_DIRS: "/x", HOME: "/Users/real" };
    prepareIsolation(d, "coord-on");
    const env = buildRunEnv(base, d, "coord-on");
    assert.equal(env.HOME, d.home); assert.equal(env.CLAUDE_CONFIG_DIR, d.config); assert.equal(env.CLAUDE_PLUGIN_DATA, d.pluginData);
    assert.equal(env.ANTHROPIC_API_KEY, "k"); assert.equal(env.SECRET_PARENT_VAR, undefined); assert.equal(env.CLAUDE_CODE_PLUGIN_DIRS, undefined);
    assert.ok(d.pluginData.startsWith(root) && d.pluginData.endsWith("plugins/data/odd-claude-inline"));
    assert.deepEqual(JSON.parse(readFileSync(join(d.pluginData, "delegation.json"), "utf8")), { version: 1, sessionId: "delegation", data: { mode: "full" } });
    const r2 = tmp(), d2 = runDirs(r2); prepareIsolation(d2, "coord-off");
    assert.equal(JSON.parse(readFileSync(join(d2.pluginData, "delegation.json"), "utf8")).data.mode, "organic");
    const r3 = tmp(), d3 = runDirs(r3); prepareIsolation(d3, "none");
    assert.ok(!existsSync(d3.pluginData)); assert.equal(buildRunEnv(base, d3, "none").CLAUDE_PLUGIN_DATA, undefined);
  });
  test("hasAuthEnv", () => { assert.equal(hasAuthEnv({}), false); assert.equal(hasAuthEnv({ CLAUDE_CODE_OAUTH_TOKEN: "t" }), true); });
  test("a run never sees the parent's config/plugin dirs and seeds the arm state only in its own dir", async () => {
    const { opts, log } = setup();
    await runEval(opts);
    const calls = logOf(log);
    assert.equal(calls.length, 3);
    for (const c of calls) {
      assert.notEqual(c.env.CLAUDE_CONFIG_DIR, "/real/.claude"); assert.notEqual(c.env.HOME, process.env.HOME);
      assert.equal(c.env.SECRET_PARENT_VAR, null); assert.equal(c.env.ANTHROPIC_API_KEY, "k");
    }
    const byArm = Object.fromEntries(calls.map((c) => [c.argv.includes("--plugin-dir") ? (JSON.parse(c.delegation).data.mode === "full" ? "on" : "off") : "none", c]));
    assert.deepEqual(Object.keys(byArm).sort(), ["none", "off", "on"]);
    assert.equal(byArm.none.delegation, null); assert.equal(byArm.none.env.CLAUDE_PLUGIN_DATA, null);
    assert.ok(!existsSync(byArm.on.env.CLAUDE_CONFIG_DIR), "workspace and private dirs are removed afterwards");
  });
});

describe("stream parsing", () => {
  test("good stream", () => {
    const p = parseStream(goodStream(0.5));
    assert.equal(p.cost_usd, 0.5); assert.equal(p.num_turns, 7); assert.equal(p.duration_ms, 1234); assert.equal(p.subagents, 1);
    assert.deepEqual(p.tokens, { input: 11, output: 22, cache_read: 33, cache_creation: 44, total: 110 });
    assert.equal(p.tokens_by_model?.["claude-haiku"].total, 10); assert.equal(p.result_found, true); assert.equal(p.is_error, false);
  });
  test("partial result: missing fields are null", () => {
    const p = parseStream(JSON.stringify({ type: "result", subtype: "error_max_turns" }) + "\n");
    assert.equal(p.result_found, true); assert.equal(p.cost_usd, null); assert.equal(p.tokens, null); assert.equal(p.num_turns, null); assert.equal(p.result_subtype, "error_max_turns"); assert.equal(p.subagents, 0);
  });
  test("malformed and empty input never throws", () => {
    const p = parseStream('not json\n{"type":"result","total_cost_usd":"x","modelUsage":[1],"num_turns":null}\n[1]\n');
    assert.equal(p.malformed_lines, 2); assert.equal(p.cost_usd, null); assert.equal(p.tokens, null);
    assert.equal(parseStream("").result_found, false);
  });
  test("observed delegation mode from the session context", () => {
    assert.equal(parseStream(JSON.stringify({ type: "system", output: "Delegation mode: organic" }) + "\n").observed_delegation, "organic");
  });
});

describe("runOne grading", () => {
  test("hidden tests fail when the agent did nothing", async () => {
    const a = setup(); const rec = await runOne({ task: a.opts.tasks[0], arm: "none", trial: 1 }, a.opts);
    assert.equal(rec.passed, false); assert.notEqual(rec.grade_exit_code, 0); assert.equal(rec.status, "ok"); assert.equal(rec.visible_tests_modified, false);
    assert.equal(rec.schema, "odd-claude.eval-run/v1"); assert.equal(rec.cost_usd, 0.5); assert.equal(rec.subagents, 1); assert.equal(rec.tokens?.total, 110);
  });
  test("hidden tests pass when the agent fixed the code; test-change comparison rules", async () => {
    const root = tmp(), tasksDir = join(root, "tasks");
    makeTask(tasksDir, "t1");
    const bin = join(root, "fake");
    // A fake that edits relative to its cwd.
    writeFileSync(bin, `#!${process.execPath}\nconst fs=require("fs");fs.mkdirSync("src",{recursive:true});fs.writeFileSync("src/value.txt","fixed");process.stdout.write(${JSON.stringify(goodStream())});\n`, { mode: 0o755 });
    const mk = (extra: NodeJS.ProcessEnv): EvalOptions => ({ tasks: loadTasks(tasksDir), arms: ["none"], trials: 1, pluginDir: "/p", claudeBin: bin, model: "opus", maxBudgetUsd: 1, maxTurns: 5, totalBudgetUsd: 70, outDir: join(root, "o"), baseEnv: { PATH: process.env.PATH, ANTHROPIC_API_KEY: "k", ...extra } });
    const clean = await runOne({ task: loadTasks(tasksDir)[0], arm: "none", trial: 1 }, mk({}));
    assert.equal(clean.passed, true); assert.equal(clean.visible_tests_modified, false);
    const { testsModified } = await import("./runner.js");
    assert.equal(testsModified(new Map([["a.test.js", "1"]]), new Map([["a.test.js", "2"]])), true);
    assert.equal(testsModified(new Map([["a.test.js", "1"]]), new Map()), true);
    assert.equal(testsModified(new Map([["a.test.js", "1"]]), new Map([["a.test.js", "1"], ["b.test.js", "9"]])), false);
  });
  test("agent edit to a visible test is flagged end to end", async () => {
    const root = tmp(), tasksDir = join(root, "tasks");
    makeTask(tasksDir, "t1");
    const bin = join(root, "fake");
    writeFileSync(bin, `#!${process.execPath}\nrequire("fs").writeFileSync("test/visible.test.js","changed");process.stdout.write(${JSON.stringify(goodStream())});\n`, { mode: 0o755 });
    const rec = await runOne({ task: loadTasks(tasksDir)[0], arm: "none", trial: 1 }, { tasks: [], arms: ["none"], trials: 1, pluginDir: "/p", claudeBin: bin, model: "opus", maxBudgetUsd: 1, maxTurns: 5, totalBudgetUsd: 70, outDir: join(root, "o"), baseEnv: { PATH: process.env.PATH } });
    assert.equal(rec.visible_tests_modified, true); assert.equal(rec.passed, false);
  });
  test("a nonzero exit without a result is an error record, not a crash", async () => {
    const a = setup({ stdout: "garbage\n", exitCode: 3 });
    const rec = await runOne({ task: a.opts.tasks[0], arm: "none", trial: 1 }, a.opts);
    assert.equal(rec.status, "error"); assert.equal(rec.cost_usd, null); assert.equal(rec.exit_code, 3); assert.equal(rec.passed, false);
  });
  test("timeout is recorded", async () => {
    const a = setup({ sleepMs: 5000 }, { timeout_s: 0.3 });
    const rec = await runOne({ task: a.opts.tasks[0], arm: "none", trial: 1 }, a.opts);
    assert.equal(rec.status, "timeout"); assert.equal(rec.timed_out, true);
  });
});

describe("budget guard", () => {
  test("stops before a run that could overrun the total; writes runs.jsonl", async () => {
    const a = setup({ stdout: goodStream(0.6) });
    a.opts.maxBudgetUsd = 1; a.opts.totalBudgetUsd = 2.5; a.opts.trials = 1;
    const out = await runEval(a.opts);
    // run1: 0 + 1 <= 2.5 ok (spent .6); run2: 1.6 ok (spent 1.2); run3: 2.2 + ... 1.2+1=2.2 ok (1.8); run4 would not exist (3 runs).
    assert.equal(out.records.length, 3);
    a.opts.totalBudgetUsd = 1.9; a.opts.outDir = join(a.root, "out2");
    const o2 = await runEval(a.opts);
    assert.equal(o2.records.length, 2); assert.equal(o2.stopped?.skipped, 1); assert.equal(logOf(a.log).length, 3 + 2);
    assert.equal(readFileSync(join(a.opts.outDir, "runs.jsonl"), "utf8").trim().split("\n").length, 2);
  });
  test("a run with unknown cost is charged its cap", async () => {
    const a = setup({ stdout: "" }); a.opts.totalBudgetUsd = 2; a.opts.maxBudgetUsd = 1;
    const o = await runEval(a.opts);
    assert.equal(o.records.length, 2); assert.equal(o.stopped?.skipped, 1);
  });
});

describe("stats and report", () => {
  test("summarize", () => {
    const s = summarize([1, 2, 3, 4, null]);
    assert.equal(s.n, 4); assert.equal(s.mean, 2.5); assert.equal(s.median, 2.5); assert.ok(Math.abs((s.stdev ?? 0) - 1.2909944) < 1e-6);
    assert.deepEqual(summarize([]), { n: 0, mean: null, median: null, stdev: null }); assert.equal(summarize([5]).stdev, null); assert.equal(summarize([3, 1, 2]).median, 2);
  });
  test("report aggregates per arm and per task", () => {
    const mk = (arm: string, task: string, passed: boolean, cost: number | null, tokens: number, wall: number, sub: number): RunRecord => ({ arm, task, passed, cost_usd: cost, tokens: { input: 0, output: 0, cache_read: 0, cache_creation: 0, total: tokens }, wall_ms: wall, subagents: sub, status: "ok", error: null, visible_tests_modified: false, run_id: `${task}.${arm}` }) as unknown as RunRecord;
    const md = renderReport([mk("none", "a", true, 1, 100, 10000, 0), mk("none", "a", false, 3, 300, 30000, 0), mk("coord-on", "a", true, 2, 200, 20000, 2)]);
    assert.match(md, /\| none \| 2 \| 1\/2 \(50%\) \| 2\.000 \/ 2\.000 \/ 1\.414 \| 200 \/ 200 \/ 141 \| 20\.0 \/ 20\.0 \/ 14\.1 \| 0\.00 \/ 0\.00 \/ 0\.00 \|/);
    assert.match(md, /\| coord-on \| 1 \| 1\/1 \(100%\) \| 2\.000 \/ 2\.000 \/ n\/a/);
    assert.match(md, /\| a \| 1\/2 \| 2\.000 \| 1\/1 \| 2\.000 \|/);
    assert.ok(!md.includes("coord-off"));
  });
  test("runEval output feeds the report", async () => {
    const a = setup(); const o = await runEval(a.opts);
    const md = renderReport(o.records, o);
    assert.match(md, /Runs: 3 of 3 planned/); assert.match(md, /\| none \| 1 \| 0\/1 \(0%\)/);
  });
});

describe("cli", () => {
  test("--dry-run plans 6 tasks x 3 arms x 3 trials = 54 runs and executes nothing", async () => {
    const root = tmp(), tasksDir = join(root, "tasks"), log = join(root, "c.log");
    for (let i = 1; i <= 6; i++) makeTask(tasksDir, `task${i}`);
    const bin = installFakeClaude(root, { logFile: log });
    let out = "";
    const code = await main(["--dry-run", "--tasks-dir", tasksDir, "--claude-bin", bin], (s) => { out += s; }, {});
    assert.equal(code, 0); assert.match(out, /6 tasks x 3 arms x 3 trials = 54 runs/);
    assert.equal(out.split("\n").filter((l) => /^\s*\d+\. /.test(l)).length, 54);
    assert.match(out, /total budget guard 70 USD/); assert.equal(logOf(log).length, 0);
    assert.equal(planRuns(loadTasks(tasksDir), ["none", "coord-on", "coord-off"], 3).length, 54);
  });
  test("option parsing and errors", () => {
    const a = parseArgs(["--tasks", "a,b", "--arms", "none,coord-on", "--trials", "2", "--max-budget-usd", "1.5", "--max-turns", "10", "--out", "/x", "--dry-run"]);
    assert.deepEqual(a.tasks, ["a", "b"]); assert.deepEqual(a.arms, ["none", "coord-on"]); assert.equal(a.trials, 2); assert.equal(a.maxBudgetUsd, 1.5); assert.equal(a.maxTurns, 10); assert.equal(a.out, "/x"); assert.equal(a.dryRun, true);
    assert.equal(parseArgs([]).totalBudgetUsd, 70); assert.equal(parseArgs([]).trials, 3);
    assert.throws(() => parseArgs(["--arms", "bogus"]), /unknown arm "bogus"; available: none, coord-on, coord-off/);
    assert.throws(() => parseArgs(["--trials", "0"]), /--trials needs a positive number/);
    assert.throws(() => parseArgs(["--wat"]), /unknown option "--wat"/);
  });
  test("a real run without a credential in the environment refuses before spawning anything", async () => {
    const root = tmp(), tasksDir = join(root, "tasks"), log = join(root, "c.log");
    makeTask(tasksDir, "t1"); const bin = installFakeClaude(root, { logFile: log });
    await assert.rejects(main(["--tasks-dir", tasksDir, "--claude-bin", bin, "--out", join(root, "o")], () => {}, { PATH: process.env.PATH }), /no credential in the environment/);
    assert.equal(logOf(log).length, 0);
  });
  test("a full CLI run writes runs.jsonl and report.md", async () => {
    const root = tmp(), tasksDir = join(root, "tasks"), log = join(root, "c.log"), outDir = join(root, "o");
    makeTask(tasksDir, "t1"); const bin = installFakeClaude(root, { logFile: log, stdout: goodStream() });
    // plugin dir check uses the real repo plugin: present in this repository.
    const code = await main(["--tasks-dir", tasksDir, "--claude-bin", bin, "--out", outDir, "--trials", "1", "--arms", "none,coord-on"], () => {}, { PATH: process.env.PATH, ANTHROPIC_API_KEY: "k" });
    assert.equal(code, 0);
    const rows = readFileSync(join(outDir, "runs.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(rows.length, 2); assert.ok(rows.every((r) => r.schema === "odd-claude.eval-run/v1"));
    assert.match(readFileSync(join(outDir, "report.md"), "utf8"), /## Per arm/);
  });
  test("unknown task id", () => { const root = tmp(); makeTask(join(root, "t"), "a"); assert.throws(() => loadTasks(join(root, "t"), ["zz"]), /unknown task "zz"; available: a/); });
});
