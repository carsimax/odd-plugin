// One eval run = fresh workspace + isolated Claude Code state + `claude -p` + hidden-test grading; `runEval` loops with a global budget guard.
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { runProcess } from "../process.js";
import { buildClaudeArgv } from "./argv.js";
import { buildRunEnv, prepareIsolation, runDirs, type Arm } from "./isolation.js";
import { parseStream, type TokenCounts } from "./stream.js";
import type { EvalTask } from "./tasks.js";

export const RUN_SCHEMA = "odd-claude.eval-run/v1";

export interface RunRecord {
  schema: typeof RUN_SCHEMA;
  run_id: string;
  task: string; kind: string; size: string; arm: Arm; trial: number; model: string;
  started_at: string;
  status: "ok" | "error" | "timeout";
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
  /** Hidden tests passed (grade command exit 0); null when grading did not run. */
  passed: boolean | null; grade_exit_code: number | null;
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

export async function runOne(run: PlannedRun, o: EvalOptions): Promise<RunRecord> {
  const { task, arm, trial } = run;
  const root = mkdtempSync(join(tmpdir(), "odd-eval-run-"));
  const started = new Date();
  const rec: RunRecord = {
    schema: RUN_SCHEMA, run_id: `${task.id}.${arm}.${trial}`, task: task.id, kind: task.kind, size: task.size, arm, trial, model: o.model,
    started_at: started.toISOString(), status: "ok", error: null, exit_code: null, timed_out: false, wall_ms: 0,
    cost_usd: null, tokens: null, tokens_by_model: null, num_turns: null, duration_ms: null, subagents: 0,
    is_error: null, result_subtype: null, result_found: false, observed_delegation: null, passed: null, grade_exit_code: null, visible_tests_modified: null,
  };
  try {
    const dirs = runDirs(root), ws = join(root, "workspace");
    prepareIsolation(dirs, arm);
    const env = buildRunEnv(o.baseEnv ?? process.env, dirs, arm);
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
    const p = parseStream(res.stdout);
    Object.assign(rec, {
      cost_usd: p.cost_usd, tokens: p.tokens, tokens_by_model: p.tokens_by_model, num_turns: p.num_turns, duration_ms: p.duration_ms, subagents: p.subagents,
      is_error: p.is_error, result_subtype: p.result_subtype, result_found: p.result_found, observed_delegation: p.observed_delegation,
    });
    rec.status = res.timedOut ? "timeout" : "ok";
    if (!res.timedOut && (res.code !== 0 || !p.result_found)) { rec.status = "error"; rec.error = `claude exited ${res.code}${p.result_found ? "" : " without a result message"}: ${res.stderr.trim().slice(0, 300)}`; }

    rec.visible_tests_modified = testsModified(before, hashTests(ws));
    // Grading runs after the session whatever its status: the end state is what counts.
    cpSync(join(task.dir, "hidden"), ws, { recursive: true, force: true });
    const g = await runProcess("sh", ["-c", task.grade], { cwd: ws, env, deadlineMs: Math.min(task.timeout_s, 300) * 1000 });
    rec.grade_exit_code = g.code;
    rec.passed = g.code === 0 && !g.timedOut;
  } catch (e) {
    rec.status = "error"; rec.error = (e as Error).message;
  } finally {
    if (!o.keepWorkspaces) rmSync(root, { recursive: true, force: true });
  }
  return rec;
}

export async function runEval(o: EvalOptions): Promise<EvalOutcome> {
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
