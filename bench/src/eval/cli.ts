// Dev-only CLI: `npm run eval -- [--tasks a,b] [--arms none,coord-on,coord-off] [--trials 3] [--max-budget-usd 2] [--max-turns 60] [--total-budget-usd 70] [--out <dir>] [--dry-run]`
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ARMS, hasAuthEnv, type Arm } from "./isolation.js";
import { planRuns, runEval } from "./runner.js";
import { renderReport } from "./report.js";
import { loadTasks } from "./tasks.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export interface CliArgs { tasks?: string[]; arms: Arm[]; trials: number; maxBudgetUsd: number; maxTurns: number; totalBudgetUsd: number; out?: string; dryRun: boolean; tasksDir: string; claudeBin: string; model: string; skipAuthCheck: boolean; keepWorkspaces: boolean }

export function parseArgs(argv: readonly string[]): CliArgs {
  const a: CliArgs = { arms: [...ARMS], trials: 3, maxBudgetUsd: 2, maxTurns: 60, totalBudgetUsd: 70, dryRun: false, tasksDir: join(REPO_ROOT, "bench", "eval-tasks"), claudeBin: "claude", model: "opus", skipAuthCheck: false, keepWorkspaces: false };
  const posNum = (flag: string, v: string | undefined): number => { const n = Number(v); if (v === undefined || v === "" || !Number.isFinite(n) || n <= 0) throw new Error(`${flag} needs a positive number`); return n; };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const val = (): string => { const v = argv[++i]; if (v === undefined) throw new Error(`${flag} needs a value`); return v; };
    switch (flag) {
      case "--tasks": a.tasks = val().split(",").filter(Boolean); break;
      case "--arms": a.arms = val().split(",").filter(Boolean).map((x) => { if (!(ARMS as readonly string[]).includes(x)) throw new Error(`unknown arm ${JSON.stringify(x)}; available: ${ARMS.join(", ")}`); return x as Arm; }); break;
      case "--trials": a.trials = Math.floor(posNum(flag, val())); break;
      case "--max-budget-usd": a.maxBudgetUsd = posNum(flag, val()); break;
      case "--max-turns": a.maxTurns = Math.floor(posNum(flag, val())); break;
      case "--total-budget-usd": a.totalBudgetUsd = posNum(flag, val()); break;
      case "--out": a.out = resolve(val()); break;
      case "--tasks-dir": a.tasksDir = resolve(val()); break;
      case "--claude-bin": a.claudeBin = val(); break;
      case "--model": a.model = val(); break;
      case "--dry-run": a.dryRun = true; break;
      case "--skip-auth-check": a.skipAuthCheck = true; break;
      case "--keep-workspaces": a.keepWorkspaces = true; break;
      default: throw new Error(`unknown option ${JSON.stringify(flag)}`);
    }
  }
  if (a.arms.length === 0) throw new Error("--arms needs at least one arm");
  return a;
}

export async function main(argv: readonly string[], write: (s: string) => void = (s) => process.stdout.write(s), env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const a = parseArgs(argv);
  const tasks = loadTasks(a.tasksDir, a.tasks);
  const plan = planRuns(tasks, a.arms, a.trials);
  const worst = plan.length * a.maxBudgetUsd;
  if (a.dryRun) {
    write(`Plan: ${tasks.length} tasks x ${a.arms.length} arms x ${a.trials} trials = ${plan.length} runs\n`);
    for (const [i, r] of plan.entries()) write(`${String(i + 1).padStart(3)}. ${r.task.id} arm=${r.arm} trial=${r.trial}\n`);
    write(`Per-run cap ${a.maxBudgetUsd} USD (worst case ${worst} USD), total budget guard ${a.totalBudgetUsd} USD${worst > a.totalBudgetUsd ? " (will stop early)" : ""}. Dry run: nothing executed.\n`);
    return 0;
  }
  const pluginDir = join(REPO_ROOT, "plugins", "odd-claude");
  if (a.arms.some((x) => x !== "none") && !existsSync(join(pluginDir, ".claude-plugin", "plugin.json"))) throw new Error(`plugin not found at ${pluginDir}`);
  if (!a.skipAuthCheck && !hasAuthEnv(env)) throw new Error("no credential in the environment: runs use a private CLAUDE_CONFIG_DIR, so your stored login is not available. Set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN (see `claude setup-token`), or pass --skip-auth-check.");
  const outDir = a.out ?? mkdtempSync(join(tmpdir(), "odd-eval-out-"));
  write(`Output: ${outDir}\n`);
  const outcome = await runEval({
    tasks, arms: a.arms, trials: a.trials, pluginDir, claudeBin: a.claudeBin, model: a.model, maxBudgetUsd: a.maxBudgetUsd, maxTurns: a.maxTurns, totalBudgetUsd: a.totalBudgetUsd, outDir, baseEnv: env, keepWorkspaces: a.keepWorkspaces,
    onRecord: (r) => write(`${r.run_id}: ${r.status} passed=${r.passed} cost=${r.cost_usd ?? "n/a"} subagents=${r.subagents}\n`),
  });
  writeFileSync(join(outDir, "report.md"), renderReport(outcome.records, outcome));
  write(`${outcome.records.length}/${outcome.planned} runs, ${outcome.spent_usd.toFixed(2)} USD${outcome.stopped ? `; STOPPED: ${outcome.stopped.reason}` : ""}\nReport: ${join(outDir, "report.md")}\n`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e: Error) => { process.stderr.write(`eval: ${e.message}\n`); process.exit(2); });
}
