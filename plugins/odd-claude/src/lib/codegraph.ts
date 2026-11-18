// codegraph warm-up (R13). Upstream never indexes implicitly: `init` is an explicit operation.
// Here: sync an index that already exists; `init` only with ODD_CLAUDE_CODEGRAPH_INIT=1;
// ODD_CLAUDE_NO_CODEGRAPH_WARMUP=1 disables it; never in a home/broad directory.
// Needs explicit trust (R1-001): a `.codegraph/` dir is repository content, so it alone never warms up
// (see codegraph-trust.ts: per-project trust recorded by the user, or ODD_CLAUDE_CODEGRAPH_WARMUP=1).
// Pure + injected: exec/hasIndex/log are provided by the caller. Never throws.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, parse } from "node:path";

export type ExecOutcome = { kind: "ok" } | { kind: "missing" } | { kind: "timeout" } | { kind: "failed"; detail?: string };

export interface WarmupDeps {
  env: Record<string, string | undefined>;
  hasIndex: (cwd: string) => boolean;
  /** Explicit user trust for this project (not derivable from repository content). */
  isTrusted: (cwd: string) => boolean;
  isBroadDir: (cwd: string) => boolean;
  exec: (cmd: string, args: string[], opts: { cwd: string; timeoutMs: number }) => ExecOutcome;
  log: (message: string) => void;
  timeoutMs: number;
  /** `init` is the slow first index; defaults to timeoutMs. */
  initTimeoutMs?: number;
}

export interface WarmupPlan {
  action: "sync" | "init" | "skip";
  reason: string;
}

export interface WarmupResult extends WarmupPlan {
  outcome: "skipped" | "ok" | "timeout" | "missing-binary" | "failed";
}

function truthy(v: string | undefined): boolean {
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

export function planWarmup(cwd: string, deps: Pick<WarmupDeps, "env" | "hasIndex" | "isBroadDir" | "isTrusted">): WarmupPlan {
  if (truthy(deps.env.ODD_CLAUDE_NO_CODEGRAPH_WARMUP)) return { action: "skip", reason: "opt-out" };
  if (deps.isBroadDir(cwd)) return { action: "skip", reason: "home-or-broad-directory" };
  if (!deps.isTrusted(cwd)) return { action: "skip", reason: "untrusted" };
  if (deps.hasIndex(cwd)) return { action: "sync", reason: "indexed" };
  if (truthy(deps.env.ODD_CLAUDE_CODEGRAPH_INIT)) return { action: "init", reason: "opt-in" };
  return { action: "skip", reason: "not-initialized" };
}

export function runWarmup(cwd: string, deps: WarmupDeps): WarmupResult {
  const plan = planWarmup(cwd, deps);
  if (plan.action === "skip") return { ...plan, outcome: "skipped" };
  const args = plan.action === "init" ? ["init", "-y", cwd] : ["sync", cwd];
  let outcome: WarmupResult["outcome"];
  let detail = "";
  try {
    const r = deps.exec("codegraph", args, { cwd, timeoutMs: plan.action === "init" ? (deps.initTimeoutMs ?? deps.timeoutMs) : deps.timeoutMs });
    outcome = r.kind === "ok" ? "ok" : r.kind === "missing" ? "missing-binary" : r.kind === "timeout" ? "timeout" : "failed";
    if (r.kind === "failed" && r.detail) detail = ` (${r.detail})`;
  } catch (err) {
    outcome = "failed";
    detail = ` (${err instanceof Error ? err.message : String(err)})`;
  }
  try {
    deps.log(`codegraph warm-up ${plan.action} ${outcome}${detail} cwd=${cwd}`);
  } catch {
    // logging must never break the warm-up
  }
  return { ...plan, outcome };
}

export function realHasIndex(cwd: string): boolean {
  return existsSync(join(cwd, ".codegraph"));
}

export function isBroadDirectory(cwd: string, home: string = homedir()): boolean {
  const abs = resolve(cwd);
  return abs === resolve(home) || abs === parse(abs).root;
}

/** Real exec with a hard timeout: ENOENT -> missing, killed by the timeout -> timeout. */
export function realWarmupExec(cmd: string, args: string[], o: { cwd: string; timeoutMs: number }): ExecOutcome {
  const r = spawnSync(cmd, args, { cwd: o.cwd, timeout: o.timeoutMs, stdio: "ignore", killSignal: "SIGKILL" });
  const code = (r.error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT") return { kind: "missing" };
  if (code === "ETIMEDOUT" || r.signal === "SIGKILL") return { kind: "timeout" };
  if (r.error) return { kind: "failed", detail: r.error.message };
  return r.status === 0 ? { kind: "ok" } : { kind: "failed", detail: `exit ${r.status}` };
}

export const SYNC_TIMEOUT_MS = 60_000;
export const INIT_TIMEOUT_MS = 300_000;
