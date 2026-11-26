// SessionStart integrations: skill-registry refresh (R53) and codegraph warm-up launch (R13).
// Nothing here may break or slow session start: the hook only does cheap checks (a stat, a small file read)
// and launches detached children for the real work. Each child is guarded by an in-flight lock
// (<dataDir>/locks, keyed by kind + project) so repeated SessionStart events never spawn overlapping runs.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { INIT_TIMEOUT_MS, isBroadDirectory, planWarmup, realHasIndex } from "./codegraph.js";
import { isTrustedProject } from "./codegraph-trust.js";
import { acquireLock, lockPath, pidAlive, releaseLock, setLockPid } from "./lock.js";
import { NO_REGISTRY_ENV, peekRegistry } from "./skill-registry.js";
import { resolveDataDir } from "./state.js";
export const WARMUP_STALE_MS = INIT_TIMEOUT_MS + 60_000;
export const REGISTRY_STALE_MS = 120_000;
function truthy(v) {
    return v === "1" || v === "true" || v === "yes" || v === "on";
}
export function runSessionIntegrations(cwd, deps) {
    const extraLines = [];
    try {
        if (!truthy(deps.env[NO_REGISTRY_ENV]) && !deps.isBroadDir(cwd)) {
            // The refresh (scan + git tracking check) runs in a detached child; the line reflects the registry on disk now.
            const known = peekRegistry(cwd);
            if (known) {
                const noun = `${known.skillCount} skill${known.skillCount === 1 ? "" : "s"}`;
                extraLines.push(`Skill registry: ${known.registryPath} (${noun}) indexes project, user and plugin skills by trigger and path; read it when delegating and pass exact SKILL.md paths to subagents.`);
            }
            deps.launchRegistryRefresh(cwd);
        }
    }
    catch (err) {
        deps.log(`skill registry refresh launch failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
        const plan = planWarmup(cwd, deps);
        if (plan.action !== "skip")
            deps.launchWarmup(cwd);
    }
    catch (err) {
        deps.log(`codegraph warm-up launch failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { extraLines };
}
/** Takes the in-flight lock for (kind, cwd) and spawns; "locked" when a live, fresh run exists. Throws if the spawn fails (lock released). */
export function launchLocked(kind, cwd, ctx) {
    if (!ctx.dataDir)
        return "no-data-dir";
    const path = lockPath(ctx.dataDir, kind, cwd);
    const staleMs = kind === "warm" ? WARMUP_STALE_MS : REGISTRY_STALE_MS;
    if (!acquireLock(path, process.pid, { staleMs, now: ctx.now, isAlive: ctx.isAlive }))
        return "locked";
    try {
        const args = kind === "warm" ? ["codegraph-warm.js", cwd] : ["skill-registry.js", "--cwd", cwd];
        const pid = ctx.spawnChild(args, { ...ctx.env, ODD_CLAUDE_DATA: ctx.dataDir });
        if (pid === undefined)
            throw new Error("no child pid");
        setLockPid(path, pid, ctx.now);
    }
    catch (err) {
        releaseLock(path, process.pid);
        throw err;
    }
    return "launched";
}
/** Real detached spawn of dist/cli/<script>; the hook never waits for it. */
export function realSpawnChild(args, env) {
    const [name, ...rest] = args;
    const script = fileURLToPath(new URL(`../cli/${name}`, import.meta.url));
    if (!existsSync(script))
        throw new Error(`${name} not found`);
    const child = spawn(process.execPath, [script, ...rest], { detached: true, stdio: "ignore", env: env });
    child.on("error", () => { });
    child.unref();
    return child.pid;
}
export function realIntegrationDeps(home, env, log, opts = {}) {
    let dataDir;
    try {
        dataDir = resolveDataDir({ ...opts, env });
    }
    catch {
        dataDir = undefined;
    }
    const ctx = { dataDir, env, spawnChild: realSpawnChild, isAlive: pidAlive };
    const launch = (kind, label) => (cwd) => {
        const r = launchLocked(kind, cwd, ctx);
        if (r === "no-data-dir")
            log(`${label} not launched: no data dir for the in-flight lock`);
    };
    return {
        home,
        env,
        hasIndex: realHasIndex,
        isBroadDir: (cwd) => isBroadDirectory(cwd, home),
        isTrusted: (cwd) => isTrustedProject(cwd, env, { ...opts, env }),
        launchWarmup: launch("warm", "codegraph warm-up"),
        launchRegistryRefresh: launch("registry", "skill registry refresh"),
        log,
    };
}
