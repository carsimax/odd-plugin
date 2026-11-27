// codegraph warm-up (R13). Upstream never indexes implicitly: `init` is an explicit operation.
// Here: sync an index that already exists; `init` only with ODD_CLAUDE_CODEGRAPH_INIT=1;
// ODD_CLAUDE_NO_CODEGRAPH_WARMUP=1 disables it; never in a home/broad directory.
// Needs explicit trust (R1-001): a `.codegraph/` dir is repository content, so it alone never warms up
// (see codegraph-trust.ts: per-project trust recorded by the user; no env signal).
// Pure + injected: exec/hasIndex/log are provided by the caller. Never throws.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, parse } from "node:path";
export function truthy(v) {
    return v === "1" || v === "true" || v === "yes" || v === "on";
}
export function planWarmup(cwd, deps) {
    if (truthy(deps.env.ODD_CLAUDE_NO_CODEGRAPH_WARMUP))
        return { action: "skip", reason: "opt-out" };
    if (deps.isBroadDir(cwd))
        return { action: "skip", reason: "home-or-broad-directory" };
    if (!deps.isTrusted(cwd))
        return { action: "skip", reason: "untrusted" };
    if (deps.hasIndex(cwd))
        return { action: "sync", reason: "indexed" };
    if (truthy(deps.env.ODD_CLAUDE_CODEGRAPH_INIT))
        return { action: "init", reason: "opt-in" };
    return { action: "skip", reason: "not-initialized" };
}
export function runWarmup(cwd, deps) {
    const plan = planWarmup(cwd, deps);
    if (plan.action === "skip")
        return { ...plan, outcome: "skipped" };
    const args = plan.action === "init" ? ["init", "-y", cwd] : ["sync", cwd];
    let outcome;
    let detail = "";
    try {
        const r = deps.exec("codegraph", args, { cwd, timeoutMs: plan.action === "init" ? (deps.initTimeoutMs ?? deps.timeoutMs) : deps.timeoutMs });
        outcome = r.kind === "ok" ? "ok" : r.kind === "missing" ? "missing-binary" : r.kind === "timeout" ? "timeout" : "failed";
        if (r.kind === "failed" && r.detail)
            detail = ` (${r.detail})`;
    }
    catch (err) {
        outcome = "failed";
        detail = ` (${err instanceof Error ? err.message : String(err)})`;
    }
    try {
        deps.log(`codegraph warm-up ${plan.action} ${outcome}${detail} cwd=${cwd}`);
    }
    catch {
        // logging must never break the warm-up
    }
    return { ...plan, outcome };
}
export function realHasIndex(cwd) {
    return existsSync(join(cwd, ".codegraph"));
}
export function isBroadDirectory(cwd, home = homedir()) {
    const abs = resolve(cwd);
    return abs === resolve(home) || abs === parse(abs).root;
}
/** Real exec with a hard timeout: ENOENT -> missing, killed by the timeout -> timeout. */
export function realWarmupExec(cmd, args, o) {
    const r = spawnSync(cmd, args, { cwd: o.cwd, timeout: o.timeoutMs, stdio: "ignore", killSignal: "SIGKILL" });
    const code = r.error?.code;
    if (code === "ENOENT")
        return { kind: "missing" };
    if (code === "ETIMEDOUT" || r.signal === "SIGKILL")
        return { kind: "timeout" };
    if (r.error)
        return { kind: "failed", detail: r.error.message };
    return r.status === 0 ? { kind: "ok" } : { kind: "failed", detail: `exit ${r.status}` };
}
export const SYNC_TIMEOUT_MS = 60_000;
export const INIT_TIMEOUT_MS = 300_000;
