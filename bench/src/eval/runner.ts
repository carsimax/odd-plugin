// One eval run = fresh workspace + isolated Claude Code state + `claude -p` + hidden-test grading; `runEval` loops with a global budget guard.
import { appendFileSync, cpSync, existsSync, writeFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runProcess } from "../process.js";
import { buildClaudeArgv, ODD_OUTPUT_STYLE } from "./argv.js";
import { ARM_MODE, buildRunEnv, isPluginArm, PLUGIN_ID, prepareIsolation, runDirs, type Arm } from "./isolation.js";
import { parseStream, type TokenCounts } from "./stream.js";
import type { EvalTask } from "./tasks.js";

/** odd-skills installer of this repository (bench/dist/eval -> repo root). */
export const DEFAULT_SKILLS_INSTALLER = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "odd-skills", "install.sh");
export const SKILLS_AGENT = "odd-worker";

export const RUN_SCHEMA = "odd-claude.eval-run/v1";

export interface RunRecord {
  schema: typeof RUN_SCHEMA;
  run_id: string;
  task: string; kind: string; size: string; arm: Arm; trial: number; model: string;
  started_at: string;
  status: "ok" | "error" | "timeout" | "invalid";
  error: string | null;
  exit_code: number | null; timed_out: boolean;
  wall_ms: number;
  cost_usd: number | null;
  tokens: TokenCounts | null;
  tokens_by_model: Record<string, TokenCounts> | null;
  num_turns: number | null; duration_ms: number | null;
  subagents: number;
  is_error: boolean | null; result_subtype: string | null; result_found: boolean;
  observed_delegation: string | null;
  /** Proof fields from the init message (null when absent). */
  observed_plugins: string[] | null; observed_output_style: string | null;
  /** Init `agents` / `skills` names (null when absent). */
  observed_agents: string[] | null; observed_skills: string[] | null;
  /** odd-skills was installed into the run's private config before claude started (arm skills only). */
  skills_installed: boolean;
  /** The plugin ran from a staged copy without its `dependencies` (engram is not installed in the isolated config). */
  plugin_staged: boolean;
  /** Hidden tests passed (grade command exit 0); null when grading did not run. */
  passed: boolean | null; grade_exit_code: number | null;
  /** Per named check of the task (present only when the task defines `checks`); `passed` requires all of them true. */
  checks?: Record<string, boolean>;
  /** The task's difficulty label (present only when task.json sets it). */
  difficulty?: string;
  /** The agent changed or removed a visible test file that existed in the shipped repo. */
  visible_tests_modified: boolean | null;
}

export interface EvalOptions {
  tasks: EvalTask[];
  arms: readonly Arm[];
  trials: number;
  pluginDir: string;
  claudeBin: string;
  model: string;
  maxBudgetUsd: number;
  maxTurns: number;
  totalBudgetUsd: number;
  outDir: string;
  /** Set by runEval when `pluginDir` is the staged copy; recorded as `plugin_staged` on plugin-arm records. */
  pluginStaged?: boolean;
  /** install.sh of odd-skills run for arm `skills` (defaults to the repository's). */
  skillsInstaller?: string;
  /** Parent environment the run env is derived from (defaults to process.env). */
  baseEnv?: NodeJS.ProcessEnv;
  keepWorkspaces?: boolean;
  onRecord?: (r: RunRecord) => void;
}

export interface EvalOutcome { records: RunRecord[]; planned: number; stopped: { reason: string; skipped: number } | null; spent_usd: number }

export interface PlannedRun { task: EvalTask; arm: Arm; trial: number }

/** Trial-major order (trial, task, arm) so a budget stop leaves balanced coverage. */
export function planRuns(tasks: readonly EvalTask[], arms: readonly Arm[], trials: number): PlannedRun[] {
  const out: PlannedRun[] = [];
  for (let trial = 1; trial <= trials; trial++) for (const task of tasks) for (const arm of arms) out.push({ task, arm, trial });
  return out;
}

const TEST_FILE = /(^|\/)(tests?|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$/;

function listFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === ".git" || e.name === "node_modules") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p, base)); else if (e.isFile()) out.push(relative(base, p));
  }
  return out.sort();
}

/** path -> sha256 of every visible test file under `dir`. */
export function hashTests(dir: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const f of listFiles(dir)) if (TEST_FILE.test(f)) m.set(f, createHash("sha256").update(readFileSync(join(dir, f))).digest("hex"));
  return m;
}

/** A shipped test file that is now missing or has different content. New test files do not count. */
export function testsModified(before: Map<string, string>, after: Map<string, string>): boolean {
  for (const [f, h] of before) if (after.get(f) !== h) return true;
  return false;
}

function git(args: string[], cwd: string, env: NodeJS.ProcessEnv): void {
  execFileSync("git", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
}

/** Differences between what the arm promises and what the init/hook messages showed. */
export function proofMismatches(arm: Arm, r: Pick<RunRecord, "observed_plugins" | "observed_output_style" | "observed_delegation"> & { observed_agents?: string[] | null }): string[] {
  const loaded = r.observed_plugins?.includes(PLUGIN_ID) ?? false, out: string[] = [];
  const worker = r.observed_agents?.includes(SKILLS_AGENT) ?? false;
  if (arm === "none") {
    if (loaded) out.push(`arm none loaded ${PLUGIN_ID}`);
    if (worker) out.push(`arm none lists the ${SKILLS_AGENT} agent`);
    return out;
  }
  if (arm === "skills") {
    if (!worker) out.push(`init agents ${JSON.stringify(r.observed_agents)} lack ${SKILLS_AGENT}`);
    if (loaded) out.push(`arm skills loaded ${PLUGIN_ID}`);
    return out;
  }
  if (!loaded) out.push(`init plugins ${JSON.stringify(r.observed_plugins)} lack ${PLUGIN_ID}`);
  if (r.observed_output_style !== ODD_OUTPUT_STYLE) out.push(`output style ${JSON.stringify(r.observed_output_style)}, expected "${ODD_OUTPUT_STYLE}"`);
  if (r.observed_delegation !== ARM_MODE[arm]) out.push(`delegation mode ${JSON.stringify(r.observed_delegation)}, expected "${ARM_MODE[arm]}"`);
  return out;
}

/** Copy of the plugin in a fresh temp dir with `dependencies` removed from its manifest: the isolated config has no engram, and Claude Code disables a plugin with an unsatisfied dependency. */
export function stagePlugin(pluginDir: string): string {
  const root = mkdtempSync(join(tmpdir(), "odd-eval-plugin-"));
  try {
    const dest = join(root, "odd-claude");
    cpSync(pluginDir, dest, { recursive: true });
    const manifest = join(dest, ".claude-plugin", "plugin.json");
    const json = JSON.parse(readFileSync(manifest, "utf8")) as Record<string, unknown>;
    delete json.dependencies;
    writeFileSync(manifest, JSON.stringify(json, null, 2) + "\n");
    return dest;
  } catch (e) { rmSync(root, { recursive: true, force: true }); throw e; }
}

export async function runOne(run: PlannedRun, o: EvalOptions): Promise<RunRecord> {
  const { task, arm, trial } = run;
  const root = mkdtempSync(join(tmpdir(), "odd-eval-run-"));
  const started = new Date();
  const rec: RunRecord = {
    schema: RUN_SCHEMA, run_id: `${task.id}.${arm}.${trial}`, task: task.id, kind: task.kind, size: task.size, arm, trial, model: o.model,
    started_at: started.toISOString(), status: "ok", error: null, exit_code: null, timed_out: false, wall_ms: 0,
    cost_usd: null, tokens: null, tokens_by_model: null, num_turns: null, duration_ms: null, subagents: 0,
    is_error: null, result_subtype: null, result_found: false, observed_delegation: null, observed_plugins: null, observed_output_style: null, plugin_staged: isPluginArm(arm) && o.pluginStaged === true, observed_agents: null, observed_skills: null, skills_installed: false, passed: null, grade_exit_code: null, visible_tests_modified: null,
    ...(task.difficulty !== undefined ? { difficulty: task.difficulty } : {}),
  };
  try {
    const dirs = runDirs(root), ws = join(root, "workspace");
    prepareIsolation(dirs, arm);
    const env = buildRunEnv(o.baseEnv ?? process.env, dirs, arm);
    if (arm === "skills") {
      const inst = await runProcess("sh", [o.skillsInstaller ?? DEFAULT_SKILLS_INSTALLER, "--target", dirs.config], { cwd: root, env, deadlineMs: 60_000 });
      if (inst.code !== 0 || inst.timedOut) throw new Error(`odd-skills install failed (exit ${inst.code}${inst.timedOut ? ", timed out" : ""}): ${inst.stderr.trim().slice(0, 500)}`);
      rec.skills_installed = true;
    }
    cpSync(join(task.dir, "repo"), ws, { recursive: true });
    git(["init", "-q", "-b", "main"], ws, env);
    git(["add", "-A"], ws, env);
    git(["commit", "-q", "-m", "eval: initial"], ws, env);
    const before = hashTests(ws);

    const argv = buildClaudeArgv({ prompt: task.prompt, arm, pluginDir: o.pluginDir, model: o.model, maxTurns: o.maxTurns, maxBudgetUsd: o.maxBudgetUsd, extraTools: task.allowed_tools });
    const t0 = performance.now();
    const res = await runProcess(o.claudeBin, argv, { cwd: ws, env, deadlineMs: task.timeout_s * 1000 });
    rec.wall_ms = Math.round(performance.now() - t0);
    rec.exit_code = res.code; rec.timed_out = res.timedOut;
    mkdirSync(join(o.outDir, "streams"), { recursive: true });
    writeFileSync(join(o.outDir, "streams", `${rec.run_id}.jsonl`), res.stdout);
    const p = parseStream(res.stdout);
    Object.assign(rec, {
      cost_usd: p.cost_usd, tokens: p.tokens, tokens_by_model: p.tokens_by_model, num_turns: p.num_turns, duration_ms: p.duration_ms, subagents: p.subagents,
      is_error: p.is_error, result_subtype: p.result_subtype, result_found: p.result_found, observed_delegation: p.observed_delegation,
      observed_plugins: p.observed_plugins, observed_output_style: p.observed_output_style, observed_agents: p.observed_agents, observed_skills: p.observed_skills,
    });
    rec.status = res.timedOut ? "timeout" : "ok";
    if (!res.timedOut && (res.code !== 0 || !p.result_found)) { rec.status = "error"; rec.error = `claude exited ${res.code}${p.result_found ? "" : " without a result message"}: ${res.stderr.trim().slice(0, 300)}`; }
    // Proof check: a run whose arm was not what it claims must not enter the stats (it is still graded and its cost recorded).
    if (rec.status === "ok") {
      const bad = proofMismatches(arm, rec);
      if (bad.length) { rec.status = "invalid"; rec.error = `proof mismatch: ${bad.join("; ")}`; }
    }

    rec.visible_tests_modified = testsModified(before, hashTests(ws));
    // Grading runs after the session whatever its status: the end state is what counts.
    cpSync(join(task.dir, "hidden"), join(ws, "hidden"), { recursive: true, force: true });
    const g = await runProcess("sh", ["-c", task.grade], { cwd: ws, env, deadlineMs: Math.min(task.timeout_s, 300) * 1000 });
    rec.grade_exit_code = g.code;
    rec.passed = g.code === 0 && !g.timedOut;
    if (task.checks) {
      const results: Record<string, boolean> = {};
      for (const [name, cmd] of Object.entries(task.checks)) {
        const c = await runProcess("sh", ["-c", cmd], { cwd: ws, env, deadlineMs: Math.min(task.timeout_s, 300) * 1000 });
        results[name] = c.code === 0 && !c.timedOut;
      }
      rec.checks = results;
      rec.passed = rec.passed && Object.values(results).every(Boolean);
    }
  } catch (e) {
    rec.status = "error"; rec.error = (e as Error).message;
  } finally {
    if (!o.keepWorkspaces) rmSync(root, { recursive: true, force: true });
  }
  return rec;
}

export async function runEval(opts: EvalOptions): Promise<EvalOutcome> {
  const staged = opts.arms.some(isPluginArm) ? stagePlugin(opts.pluginDir) : null;
  try {
    return await runEvalStaged(staged ? { ...opts, pluginDir: staged, pluginStaged: true } : opts);
  } finally {
    if (staged) rmSync(dirname(staged), { recursive: true, force: true });
  }
}

async function runEvalStaged(o: EvalOptions): Promise<EvalOutcome> {
  mkdirSync(o.outDir, { recursive: true });
  const file = join(o.outDir, "runs.jsonl");
  const plan = planRuns(o.tasks, o.arms, o.trials);
  const records: RunRecord[] = [];
  let spent = 0, stopped: EvalOutcome["stopped"] = null;
  for (let i = 0; i < plan.length; i++) {
    // Guard before starting: the run may cost up to its own cap.
    if (spent + o.maxBudgetUsd > o.totalBudgetUsd) {
      stopped = { reason: `accumulated ${spent.toFixed(2)} USD + per-run cap ${o.maxBudgetUsd} USD would exceed the total budget ${o.totalBudgetUsd} USD`, skipped: plan.length - i };
      break;
    }
    const r = await runOne(plan[i], o);
    // A run whose cost is unknown is charged its full cap, the conservative reading.
    spent += r.cost_usd ?? o.maxBudgetUsd;
    records.push(r);
    appendFileSync(file, JSON.stringify(r) + "\n");
    o.onRecord?.(r);
  }
  return { records, planned: plan.length, stopped, spent_usd: spent };
}
