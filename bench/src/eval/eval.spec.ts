import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { afterEach, describe, test } from "node:test";
import { chmodSync } from "node:fs";
import { buildClaudeArgv } from "./argv.js";
import { main, parseArgs } from "./cli.js";
import { buildRunEnv, hasAuthEnv, prepareIsolation, runDirs } from "./isolation.js";
import { renderReport } from "./report.js";
import { planRuns, runEval, runOne, type EvalOptions, type RunRecord } from "./runner.js";
import { parseStream } from "./stream.js";
import { summarize } from "./stats.js";
import { loadTasks } from "./tasks.js";
import { FAKE_PLUGIN_JSON, goodStream, installFakeClaude, makeFakePlugin, makeTask, scratch } from "./fixtures.js";

const dirs: string[] = [];
const tmp = (): string => { const d = scratch(); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const logOf = (f: string): Record<string, any>[] => (existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

function setup(over: Partial<Parameters<typeof installFakeClaude>[1]> = {}, taskOver = {}): { root: string; tasksDir: string; log: string; opts: EvalOptions } {
  const root = tmp(), tasksDir = join(root, "tasks"), log = join(root, "calls.log");
  makeTask(tasksDir, "t1", taskOver);
  makeFakePlugin(join(root, "plugin"));
  const claudeBin = installFakeClaude(root, { logFile: log, stdout: goodStream(), proof: {}, ...over });
  const opts: EvalOptions = {
    tasks: loadTasks(tasksDir), arms: ["none", "coord-on", "coord-off"], trials: 1, pluginDir: join(root, "plugin"), claudeBin, model: "opus",
    maxBudgetUsd: 1, maxTurns: 5, totalBudgetUsd: 70, outDir: join(root, "out"),
    baseEnv: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, ANTHROPIC_API_KEY: "k", SECRET_PARENT_VAR: "leak", CLAUDE_CONFIG_DIR: "/real/.claude", CLAUDE_PLUGIN_DATA: "/real/data" },
  };
  return { root, tasksDir, log, opts };
}

const SANDBOX = { sandbox: { enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false, failIfUnavailable: true } };
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
    assert.match(a[a.indexOf("--allowedTools") + 1], /^Agent,Read,Edit,Write,Glob,Grep,Bash$/);
    assert.equal(a.at(-1), "P");
    assert.ok(a.includes("--no-session-persistence") && a.includes("--verbose"));
  });
  test("coord arms: plugin-dir and the odd output style via --settings", () => {
    for (const arm of ["coord-on", "coord-off"] as const) {
      const a = buildClaudeArgv({ ...base, arm }); assert.equal(a[a.indexOf("--plugin-dir") + 1], "/p"); assert.ok(!a.includes("--bare"));
      assert.deepEqual(JSON.parse(a[a.indexOf("--settings") + 1]), { outputStyle: "odd-claude:odd", ...SANDBOX });
    }
    assert.deepEqual(JSON.parse(buildClaudeArgv({ ...base, arm: "none" }).join("\u0000").split("--settings\u0000")[1].split("\u0000")[0]), SANDBOX);
  });
  test("every arm: plain Bash (no Bash(...) patterns), extra tools kept, one --settings with the native sandbox", () => {
    for (const arm of ["none", "coord-on", "coord-off", "skills"] as const) {
      const a = buildClaudeArgv({ ...base, arm, extraTools: ["WebFetch"] });
      const tools = a[a.indexOf("--allowedTools") + 1].split(",");
      assert.deepEqual(tools, ["Agent", "Read", "Edit", "Write", "Glob", "Grep", "Bash", "WebFetch"]);
      assert.equal(a.filter((x) => x === "--settings").length, 1);
      const s = JSON.parse(a[a.indexOf("--settings") + 1]);
      assert.deepEqual(s.sandbox, SANDBOX.sandbox);
      assert.deepEqual(Object.keys(s).sort(), arm.startsWith("coord") ? ["outputStyle", "sandbox"] : ["sandbox"]);
    }
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
    const hook = JSON.stringify({ type: "system", subtype: "hook_response", hook_name: "SessionStart:startup", output: "ctx\nDelegation mode: full\nx" });
    assert.equal(parseStream(hook + "\n").observed_delegation, "full");
  });
  test("init message: observed plugins and output style", () => {
    const init = JSON.stringify({ type: "system", subtype: "init", plugins: [{ name: "odd-claude", path: "/p", source: "odd-claude@inline" }, { name: "x", source: "x@y" }, 7], output_style: "odd-claude:odd" });
    const p = parseStream(init + "\n") as Record<string, any>;
    assert.deepEqual(p.observed_plugins, ["odd-claude@inline", "x@y"]); assert.equal(p.observed_output_style, "odd-claude:odd");
    const none = parseStream(goodStream()) as Record<string, any>;
    assert.equal(none.observed_plugins, null); assert.equal(none.observed_output_style, null);
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

describe("grading path", () => {
  test("hidden tests are graded from <workspace>/hidden/ (a test importing ../src/x.js passes only there)", async () => {
    const a = setup({}, { grade: "node --test hidden/" });
    writeFileSync(join(a.tasksDir, "t1", "hidden", "x.test.js"), 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { x } from "../src/x.js";\ntest("x", () => assert.equal(x, 1));\n');
    writeFileSync(join(a.tasksDir, "t1", "repo", "package.json"), '{"type":"module"}\n');
    const bin = join(a.root, "fake-x");
    writeFileSync(bin, `#!${process.execPath}\nconst fs=require("fs");fs.mkdirSync("src",{recursive:true});fs.writeFileSync("src/x.js","export const x = 1;\\n");process.stdout.write(${JSON.stringify(goodStream())});\n`, { mode: 0o755 });
    a.opts.claudeBin = bin;
    const rec = await runOne({ task: loadTasks(a.tasksDir)[0], arm: "none", trial: 1 }, a.opts);
    assert.equal(rec.grade_exit_code, 0); assert.equal(rec.passed, true);
  });
});

describe("plugin staging, output style and proof fields", () => {
  const armOf = (c: Record<string, any>): string => (!c.argv.includes("--plugin-dir") ? "none" : JSON.parse(c.delegation).data.mode === "full" ? "coord-on" : "coord-off");

  test("plugin arms get a staged copy without dependencies; the source is untouched; the copy is removed afterwards", async () => {
    const a = setup(); const srcManifest = join(a.opts.pluginDir, ".claude-plugin", "plugin.json");
    const before = readFileSync(srcManifest, "utf8");
    await runEval(a.opts);
    const calls = logOf(a.log).filter((c) => c.argv.includes("--plugin-dir"));
    assert.equal(calls.length, 2);
    const dirsUsed = new Set(calls.map((c) => c.argv[c.argv.indexOf("--plugin-dir") + 1]));
    assert.equal(dirsUsed.size, 1, "staged once per eval");
    const staged = [...dirsUsed][0];
    assert.notEqual(staged, a.opts.pluginDir);
    for (const c of calls) { const m = JSON.parse(c.pluginJson); assert.equal(m.name, "odd-claude"); assert.ok(!("dependencies" in m)); }
    assert.equal(readFileSync(srcManifest, "utf8"), before); assert.deepEqual(JSON.parse(before), FAKE_PLUGIN_JSON);
    assert.ok(!existsSync(staged), "staged copy removed");
  });
  test("the staged copy is removed when the eval throws; no staging for the none arm only", async () => {
    const a = setup(); a.opts.arms = ["coord-on"]; a.opts.onRecord = () => { throw new Error("boom"); };
    await assert.rejects(runEval(a.opts), /boom/);
    const staged = logOf(a.log)[0].argv; const dir = staged[staged.indexOf("--plugin-dir") + 1];
    assert.ok(!existsSync(dir));
    const b = setup(); b.opts.arms = ["none"]; await runEval(b.opts);
    assert.ok(!logOf(b.log)[0].argv.includes("--plugin-dir"));
  });
  test("--settings carries the sandbox for every arm and the odd output style for plugin arms only; records say whether the plugin was staged", async () => {
    const a = setup(); const out = await runEval(a.opts);
    for (const c of logOf(a.log)) {
      assert.deepEqual(JSON.parse(c.argv[c.argv.indexOf("--settings") + 1]), armOf(c) === "none" ? SANDBOX : { outputStyle: "odd-claude:odd", ...SANDBOX });
    }
    for (const r of out.records as Record<string, any>[]) {
      assert.equal(r.plugin_staged, r.arm !== "none"); assert.equal(r.sandboxed, true); assert.equal(r.status, "ok", `${r.run_id}: ${r.error}`);
      assert.deepEqual(r.observed_plugins, r.arm === "none" ? [] : ["odd-claude@inline"]);
      assert.equal(r.observed_output_style, r.arm === "none" ? "default" : "odd-claude:odd");
      assert.equal(r.observed_delegation, r.arm === "coord-on" ? "full" : r.arm === "coord-off" ? "organic" : null);
    }
  });
  test("raw stdout of each run is saved under <out>/streams/<run_id>.jsonl", async () => {
    const a = setup(); const out = await runEval(a.opts);
    for (const r of out.records) {
      const f = join(a.opts.outDir, "streams", `${r.run_id}.jsonl`);
      assert.ok(existsSync(f), f); assert.match(readFileSync(f, "utf8"), /"type":"result"/); assert.match(readFileSync(f, "utf8"), /"subtype":"init"/);
    }
  });

  const invalidCase = async (arm: "none" | "coord-on" | "coord-off", proof: Record<string, unknown>, expectError: RegExp): Promise<void> => {
    const a = setup({ proof }); const rec = await runOne({ task: a.opts.tasks[0], arm, trial: 1 }, a.opts) as unknown as Record<string, any>;
    assert.equal(rec.status, "invalid"); assert.match(rec.error, expectError);
    assert.equal(rec.cost_usd, 0.5, "cost still recorded"); assert.equal(typeof rec.passed, "boolean", "still graded");
  };
  test("invalid: plugin arm without odd-claude@inline in the init plugins", () => invalidCase("coord-on", { plugins: [] }, /odd-claude@inline/));
  test("invalid: plugin arm with another output style", () => invalidCase("coord-off", { output_style: "default" }, /output style.*default/i));
  test("invalid: observed delegation differs from the arm's mode", async () => {
    await invalidCase("coord-on", { delegation: "organic" }, /delegation.*organic.*full/i);
    await invalidCase("coord-off", { delegation: "full" }, /delegation.*full.*organic/i);
    await invalidCase("coord-on", { delegation: null }, /delegation/i);
  });
  test("invalid: arm none that loaded odd-claude", () => invalidCase("none", { plugins: [{ name: "odd-claude", source: "odd-claude@inline" }] }, /odd-claude@inline/));

  test("report excludes invalid runs from stats and lists them with a count per arm", async () => {
    const a = setup({ proof: { output_style: "default" } }); a.opts.arms = ["none", "coord-on"];
    const out = await runEval(a.opts);
    assert.deepEqual(out.records.map((r) => r.status), ["ok", "invalid"]);
    const md = renderReport(out.records, out);
    assert.match(md, /\| none \| 1 \| 0\/1 \(0%\) \| 0\.500 .*\| 0 \| 0 \| n\/a \|\n/);
    assert.match(md, /\| coord-on \| 0 \| 0\/0 \| n\/a .*\| 1 \| 0 \| n\/a \|\n/);
    assert.match(md, /Invalid runs[\s\S]*- t1\.coord-on\.1: invalid/); assert.match(md, /Invalid runs[\s\S]*coord-on: 1/);
    assert.match(md, /\| t1 \| 0\/1 \| 0\.500 \| 0\/0 \| n\/a \|/);
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

describe("named grade checks", () => {
  const ov = (o: Record<string, unknown>): never => o as never;
  /** A fake claude that fixes src/value.txt in its cwd, then prints a good stream. */
  const fixer = (root: string): string => {
    const bin = join(root, "fake-fix");
    writeFileSync(bin, `#!${process.execPath}\nconst fs=require("fs");fs.mkdirSync("src",{recursive:true});fs.writeFileSync("src/value.txt","fixed");process.stdout.write(${JSON.stringify(goodStream())});\n`, { mode: 0o755 });
    return bin;
  };
  const optsFor = (root: string, tasksDir: string, bin: string): EvalOptions => ({ tasks: loadTasks(tasksDir), arms: ["none"], trials: 1, pluginDir: "/p", claudeBin: bin, model: "opus", maxBudgetUsd: 1, maxTurns: 5, totalBudgetUsd: 70, outDir: join(root, "o"), baseEnv: { PATH: process.env.PATH, ANTHROPIC_API_KEY: "k" } });

  test("one failing check: checks records both, passed is false, grade is still recorded", async () => {
    const root = tmp(), tasksDir = join(root, "tasks");
    makeTask(tasksDir, "t1", ov({ checks: { good: "grep -q fixed src/value.txt", bad: "exit 3" } }));
    const o = optsFor(root, tasksDir, fixer(root));
    const rec = await runOne({ task: o.tasks[0], arm: "none", trial: 1 }, o);
    assert.deepEqual(rec.checks, { good: true, bad: false }); assert.equal(rec.grade_exit_code, 0); assert.equal(rec.passed, false);
  });
  test("all checks pass: passed is true; checks run in the hidden-copied workspace root", async () => {
    const root = tmp(), tasksDir = join(root, "tasks");
    makeTask(tasksDir, "t1", ov({ checks: { acceptance: "sh hidden/check.sh", regression: "test -f README.md" } }));
    const o = optsFor(root, tasksDir, fixer(root));
    const rec = await runOne({ task: o.tasks[0], arm: "none", trial: 1 }, o);
    assert.deepEqual(rec.checks, { acceptance: true, regression: true }); assert.equal(rec.passed, true);
  });
  test("checks pass but grade fails: passed is false", async () => {
    const root = tmp(), tasksDir = join(root, "tasks");
    makeTask(tasksDir, "t1", ov({ checks: { ok: "true" } }));
    const a = setup({}, ov({ checks: { ok: "true" } }));
    const rec = await runOne({ task: a.opts.tasks[0], arm: "none", trial: 1 }, a.opts);
    assert.deepEqual(rec.checks, { ok: true }); assert.notEqual(rec.grade_exit_code, 0); assert.equal(rec.passed, false);
  });
  test("a task without checks keeps the previous record shape (no checks, no difficulty key)", async () => {
    const a = setup();
    const rec = await runOne({ task: a.opts.tasks[0], arm: "none", trial: 1 }, a.opts);
    assert.ok(!("checks" in rec)); assert.ok(!("difficulty" in rec)); assert.equal(rec.size, "small");
  });
  test("size large and difficulty are accepted and recorded", async () => {
    const a = setup({}, ov({ size: "large", difficulty: "regression-trap" }));
    assert.equal(a.opts.tasks[0].size, "large");
    const rec = await runOne({ task: a.opts.tasks[0], arm: "none", trial: 1 }, a.opts);
    assert.equal(rec.size, "large"); assert.equal(rec.difficulty, "regression-trap");
  });
  test("loader rejects invalid checks, difficulty and size with clear errors", () => {
    const root = tmp(), d = join(root, "t");
    makeTask(d, "a", ov({ checks: "nope" })); assert.throws(() => loadTasks(d), /task a: checks must be an object of name -> non-empty command string/);
    makeTask(d, "b", ov({ checks: { x: "" } })); assert.throws(() => loadTasks(d, ["b"]), /task b: checks must be an object of name -> non-empty command string/);
    makeTask(d, "c", ov({ checks: { x: 1 } })); assert.throws(() => loadTasks(d, ["c"]), /task c: checks must be an object/);
    makeTask(d, "e", ov({ checks: ["true"] })); assert.throws(() => loadTasks(d, ["e"]), /task e: checks must be an object/);
    makeTask(d, "f", ov({ difficulty: 3 })); assert.throws(() => loadTasks(d, ["f"]), /task f: difficulty must be a non-empty string/);
    makeTask(d, "g", ov({ size: "huge" })); assert.throws(() => loadTasks(d, ["g"]), /task g: size must be one of small\|medium\|large/);
  });
  test("report adds per-arm and per-task pass rates per check name, excluding invalid runs; absent without checks", () => {
    const mk = (arm: string, task: string, status: string, checks?: Record<string, boolean>): RunRecord => ({ arm, task, status, passed: true, cost_usd: 1, tokens: null, wall_ms: 1000, subagents: 0, error: null, visible_tests_modified: false, run_id: `${task}.${arm}`, ...(checks ? { checks } : {}) }) as unknown as RunRecord;
    const md = renderReport([
      mk("none", "a", "ok", { acceptance: true, regression: false }), mk("none", "b", "ok", { acceptance: true, regression: true }),
      mk("coord-on", "a", "ok", { acceptance: false, regression: true }), mk("coord-on", "a", "invalid", { acceptance: true, regression: true }),
    ]);
    assert.match(md, /## Per arm[\s\S]*\| arm \| check acceptance \| check regression \|/);
    assert.match(md, /\| none \| 2\/2 \(100%\) \| 1\/2 \(50%\) \|/);
    assert.match(md, /\| coord-on \| 0\/1 \(0%\) \| 1\/1 \(100%\) \|/);
    assert.match(md, /## Per task[\s\S]*\| task \| none acceptance \| none regression \| coord-on acceptance \| coord-on regression \|/);
    assert.match(md, /\| a \| 1\/1 \| 0\/1 \| 0\/1 \| 1\/1 \|/);
    assert.match(md, /\| b \| 1\/1 \| 1\/1 \| 0\/0 \| 0\/0 \|/);
    const plain = renderReport([mk("none", "a", "ok")]);
    assert.ok(!plain.includes("check "));
  });
});

const markerInstaller = (root: string): string => {
  const f = join(root, "marker-install.sh");
  writeFileSync(f, '#!/bin/sh\nset -e\nt="$2"\nmkdir -p "$t/agents" "$t/skills/x"\necho m > "$t/agents/odd-worker.md"\necho m > "$t/agents/marker-agent.md"\necho m > "$t/skills/x/SKILL.md"\necho m > "$t/CLAUDE.md"\necho {} > "$t/settings.json"\n');
  chmodSync(f, 0o755); return f;
};

describe("skills arm", () => {
  const sk = (proof: Record<string, unknown> = {}) => { const a = setup({ proof }); a.opts.arms = ["skills"]; a.opts.skillsInstaller = markerInstaller(a.root); return a; };
  test("argv: no plugin-dir, sandbox-only --settings, --setting-sources user", () => {
    const a = buildClaudeArgv({ prompt: "P", pluginDir: "/p", model: "sonnet", maxTurns: 9, maxBudgetUsd: 1, arm: "skills" });
    assert.ok(!a.includes("--plugin-dir") && !a.includes("--bare"));
    assert.deepEqual(JSON.parse(a[a.indexOf("--settings") + 1]), SANDBOX);
    assert.equal(a[a.indexOf("--setting-sources") + 1], "user"); assert.equal(a.at(-1), "P");
    assert.equal(a[a.indexOf("--permission-mode") + 1], "dontAsk");
  });
  test("the installer runs into the private config before claude; no plugin staging, no plugin data", async () => {
    const a = sk(); const out = await runEval(a.opts);
    const calls = logOf(a.log); assert.equal(calls.length, 1);
    const c = calls[0];
    assert.ok(c.installed.agents.includes("odd-worker.md") && c.installed.skills.length > 0 && c.installed.claudeMd && c.installed.settings);
    assert.equal(c.env.CLAUDE_PLUGIN_DATA, null); assert.equal(c.pluginJson, null);
    const r = out.records[0] as unknown as Record<string, any>;
    assert.equal(r.status, "ok", String(r.error)); assert.equal(r.skills_installed, true); assert.equal(r.plugin_staged, false);
    assert.ok(r.observed_agents.includes("odd-worker")); assert.deepEqual(r.observed_plugins, []); assert.ok(r.observed_skills.length > 0);
    assert.ok(!existsSync(c.env.CLAUDE_CONFIG_DIR), "private dirs removed");
  });
  test("other arms never install and record skills_installed false", async () => {
    const a = setup(); const out = await runEval(a.opts);
    for (const c of logOf(a.log)) assert.equal(c.installed.agents, null);
    for (const r of out.records as unknown as Record<string, any>[]) assert.equal(r.skills_installed, false);
  });
  test("installer failure: error record with the installer's stderr, claude never spawned", async () => {
    const a = sk(); const bad = join(a.root, "bad-install.sh");
    writeFileSync(bad, "#!/bin/sh\necho 'jq missing' >&2\nexit 7\n"); chmodSync(bad, 0o755);
    (a.opts as unknown as Record<string, unknown>).skillsInstaller = bad;
    const rec = await runOne({ task: a.opts.tasks[0], arm: "skills", trial: 1 }, a.opts);
    assert.equal(rec.status, "error"); assert.match(String(rec.error), /jq missing/); assert.equal(logOf(a.log).length, 0);
    assert.equal((rec as unknown as Record<string, unknown>).skills_installed, false);
  });
  test("invalid: skills run without odd-worker, or with odd-claude@inline", async () => {
    for (const [proof, re] of [[{ agents: ["odd-explore"] }, /odd-worker/], [{ plugins: [{ name: "odd-claude", source: "odd-claude@inline" }] }, /odd-claude@inline/]] as const) {
      const a = sk(proof as Record<string, unknown>); const rec = await runOne({ task: a.opts.tasks[0], arm: "skills", trial: 1 }, a.opts);
      assert.equal(rec.status, "invalid"); assert.match(String(rec.error), re); assert.equal(rec.cost_usd, 0.5);
    }
  });
  test("invalid: arm none that shows odd-worker; valid none without it", async () => {
    const a = setup({ proof: { agents: ["odd-worker"] } }); const bad = await runOne({ task: a.opts.tasks[0], arm: "none", trial: 1 }, a.opts);
    assert.equal(bad.status, "invalid"); assert.match(String(bad.error), /odd-worker/);
    const b = setup({ proof: {} }); assert.equal((await runOne({ task: b.opts.tasks[0], arm: "none", trial: 1 }, b.opts)).status, "ok");
  });
  test("parseStream: agents and skills from init", () => {
    const p = parseStream(JSON.stringify({ type: "system", subtype: "init", agents: ["a", 3, "b"], skills: ["s"] }) + "\n") as Record<string, any>;
    assert.deepEqual(p.observed_agents, ["a", "b"]); assert.deepEqual(p.observed_skills, ["s"]);
    const q = parseStream(goodStream()) as Record<string, any>; assert.equal(q.observed_agents, null); assert.equal(q.observed_skills, null);
  });
  test("report lists the skills arm after the others", async () => {
    const a = sk(); const o = await runEval(a.opts); const md = renderReport(o.records, o);
    assert.match(md, /\| skills \| 1 \| 0\/1 \(0%\)/);
  });
  test("dry-run accepts the arm: 6 tasks x 2 arms x 3 trials = 36 runs", async () => {
    const root = tmp(), tasksDir = join(root, "tasks");
    for (let i = 1; i <= 6; i++) makeTask(tasksDir, `task${i}`);
    let out = ""; const code = await main(["--dry-run", "--tasks-dir", tasksDir, "--arms", "none,skills", "--skills-installer", markerInstaller(root)], (s) => { out += s; }, {});
    assert.equal(code, 0); assert.match(out, /6 tasks x 2 arms x 3 trials = 36 runs/); assert.match(out, /arm=skills/);
  });
});

describe("--skills-installer", () => {
  test("parseArgs: absent (non-skills arms) -> undefined; relative resolves against cwd; value is absolute", () => {
    const root = tmp(); const f = markerInstaller(root);
    assert.equal(parseArgs([]).skillsInstaller, undefined);
    assert.equal(parseArgs(["--skills-installer", f]).skillsInstaller, f);
    const prev = process.cwd(); process.chdir(root);
    try { assert.equal(realpathSync(parseArgs(["--skills-installer", "marker-install.sh"]).skillsInstaller as string), realpathSync(f)); } finally { process.chdir(prev); }
  });
  test("parseArgs: missing path, directory and missing value are clear errors", () => {
    const root = tmp();
    assert.throws(() => parseArgs(["--skills-installer", join(root, "nope.sh")]), /--skills-installer: .*nope\.sh.* does not exist/);
    assert.throws(() => parseArgs(["--skills-installer", root]), /--skills-installer: .* is not a file/);
    assert.throws(() => parseArgs(["--skills-installer"]), /--skills-installer needs a value/);
  });
  test("a missing installer fails main before any run (no claude spawned, no output dir)", async () => {
    const root = tmp(), tasksDir = join(root, "tasks"), log = join(root, "c.log"), outDir = join(root, "o");
    makeTask(tasksDir, "t1"); const bin = installFakeClaude(root, { logFile: log });
    await assert.rejects(main(["--tasks-dir", tasksDir, "--claude-bin", bin, "--out", outDir, "--arms", "skills", "--skills-installer", join(root, "nope.sh")], () => {}, { PATH: process.env.PATH, ANTHROPIC_API_KEY: "k" }), /--skills-installer: .* does not exist/);
    assert.equal(logOf(log).length, 0); assert.ok(!existsSync(outDir));
  });
  test("the flag routes the skills arm to the given installer; the record carries its path relative to the cwd", async () => {
    const root = tmp(), tasksDir = join(root, "tasks"), log = join(root, "c.log"), outDir = join(root, "o"), inst = markerInstaller(root);
    makeTask(tasksDir, "t1"); const bin = installFakeClaude(root, { logFile: log, stdout: goodStream(), proof: {} });
    const code = await main(["--tasks-dir", tasksDir, "--claude-bin", bin, "--out", outDir, "--trials", "1", "--arms", "none,skills", "--skills-installer", inst], () => {}, { PATH: process.env.PATH, ANTHROPIC_API_KEY: "k" });
    assert.equal(code, 0);
    const calls = logOf(log); assert.equal(calls.length, 2);
    assert.equal(calls.filter((c) => c.installed.agents?.includes("marker-agent.md")).length, 1);
    const rows = readFileSync(join(outDir, "runs.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const sk = rows.find((r) => r.arm === "skills"), none = rows.find((r) => r.arm === "none");
    assert.equal(sk.status, "ok", String(sk.error)); assert.equal(sk.skills_installer, relative(process.cwd(), inst));
    assert.ok(none.skills_installer === undefined || none.skills_installer === null);
  });
  test("the installer path is recorded relative to the cwd, also when the installer fails", async () => {
    const a = setup(); a.opts.arms = ["skills"];
    const bad = join(a.root, "bad.sh"); writeFileSync(bad, "#!/bin/sh\nexit 3\n"); chmodSync(bad, 0o755);
    a.opts.skillsInstaller = bad;
    const got = (await runOne({ task: a.opts.tasks[0], arm: "skills", trial: 1 }, a.opts) as unknown as Record<string, unknown>).skills_installer;
    assert.equal(got, relative(process.cwd(), bad)); assert.ok(!isAbsolute(String(got)));
  });
  test("runOne: skills arm without an installer is an error record, claude never spawned", async () => {
    const a = setup(); a.opts.arms = ["skills"];
    const rec = await runOne({ task: a.opts.tasks[0], arm: "skills", trial: 1 }, a.opts);
    assert.equal(rec.status, "error"); assert.match(String(rec.error), /--skills-installer is required for the skills arm/); assert.equal(logOf(a.log).length, 0);
  });
  test("parseArgs and main: skills arm without the flag fails with the exact message, even on --dry-run, before any run", async () => {
    const msg = "--skills-installer is required for the skills arm (odd-skills now lives in its own repository, e.g. ../odd-skills/install.sh)";
    assert.throws(() => parseArgs(["--arms", "none,skills"]), (e: Error) => e.message === msg);
    const root = tmp(), tasksDir = join(root, "tasks"), log = join(root, "c.log"), outDir = join(root, "o");
    makeTask(tasksDir, "t1"); const bin = installFakeClaude(root, { logFile: log });
    await assert.rejects(main(["--dry-run", "--tasks-dir", tasksDir, "--arms", "none,skills"], () => {}, {}), (e: Error) => e.message === msg);
    await assert.rejects(main(["--tasks-dir", tasksDir, "--claude-bin", bin, "--out", outDir, "--arms", "skills"], () => {}, { PATH: process.env.PATH, ANTHROPIC_API_KEY: "k" }), (e: Error) => e.message === msg);
    assert.equal(logOf(log).length, 0); assert.ok(!existsSync(outDir));
  });
  test("non-skills arms need no flag", async () => {
    assert.doesNotThrow(() => parseArgs(["--arms", "none,coord-on,coord-off"]));
    const root = tmp(), tasksDir = join(root, "tasks"); makeTask(tasksDir, "t1");
    const code = await main(["--dry-run", "--tasks-dir", tasksDir, "--arms", "none,coord-off"], () => {}, {}); assert.equal(code, 0);
  });
  test("dry-run prints the installer in the plan header only when the skills arm is selected", async () => {
    const root = tmp(), tasksDir = join(root, "tasks"), inst = markerInstaller(root);
    makeTask(tasksDir, "t1");
    let out = ""; await main(["--dry-run", "--tasks-dir", tasksDir, "--arms", "none,skills", "--skills-installer", inst], (s) => { out += s; }, {});
    assert.match(out.split("\n")[1], new RegExp(`^Skills installer: ${inst.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
    out = ""; await main(["--dry-run", "--tasks-dir", tasksDir, "--arms", "none", "--skills-installer", inst], (s) => { out += s; }, {});
    assert.ok(!out.includes("Skills installer"));
  });
});

describe("permission denials", () => {
  const two = [{ tool_name: "Bash", tool_use_id: "a", tool_input: {} }, { tool_name: "Bash", tool_use_id: "b", tool_input: {} }];
  test("parseStream counts result.permission_denials; null when absent or not an array", () => {
    assert.equal(parseStream(goodStream(0.5, two)).permission_denials, 2);
    assert.equal(parseStream(goodStream(0.5, [])).permission_denials, 0);
    assert.equal(parseStream(goodStream()).permission_denials, null);
    assert.equal(parseStream(JSON.stringify({ type: "result", permission_denials: "x" })).permission_denials, null);
    assert.equal(parseStream("").permission_denials, null);
  });
  test("the run record carries permission_denials and sandboxed", async () => {
    const a = setup({ stdout: goodStream(0.5, two) }); const out = await runEval(a.opts);
    for (const r of out.records as Record<string, any>[]) { assert.equal(r.permission_denials, 2); assert.equal(r.sandboxed, true); }
    const b = setup({ stdout: goodStream() }); const o2 = await runEval(b.opts);
    for (const r of o2.records as Record<string, any>[]) assert.equal(r.permission_denials, null);
  });
  test("report adds runs with denials and mean denials per arm", () => {
    const mk = (arm: string, d: number | null): RunRecord => ({ arm, task: "a", passed: true, cost_usd: 1, tokens: null, wall_ms: 1, subagents: 0, status: "ok", error: null, visible_tests_modified: false, run_id: `a.${arm}.${d}`, permission_denials: d }) as unknown as RunRecord;
    const md = renderReport([mk("none", 0), mk("none", 3), mk("none", null), mk("skills", 0)]);
    assert.match(md, /runs with denials \| mean denials/);
    assert.match(md, /\| none \|.* \| 1 \| 1\.50 \|$/m);
    assert.match(md, /\| skills \|.* \| 0 \| 0\.00 \|$/m);
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
    assert.throws(() => parseArgs(["--arms", "bogus"]), /unknown arm "bogus"; available: none, coord-on, coord-off, skills/);
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
