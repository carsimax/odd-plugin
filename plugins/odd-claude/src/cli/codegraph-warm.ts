// `node dist/cli/codegraph-warm.js <cwd>`: detached codegraph warm-up started by the SessionStart hook.
// Hard time bound on the codegraph call; result logged to <data dir>/logs/hooks.log; always exits 0.
import { homedir } from "node:os";
import { INIT_TIMEOUT_MS, SYNC_TIMEOUT_MS, isBroadDirectory, realHasIndex, realWarmupExec, runWarmup } from "../lib/codegraph.js";
import { isTrustedProject } from "../lib/codegraph-trust.js";
import { lockPath, releaseLock } from "../lib/lock.js";
import { dataDirFromEnv, logError } from "../lib/state.js";
import { runMain } from "../lib/system.js";

function main(): Record<string, never> {
  const cwd = process.argv[2];
  if (!cwd) return {};
  try {
    runWarmupOnce(cwd);
  } finally {
    releaseLock(lockPath(dataDirFromEnv(process.env), "warm", cwd), process.pid);
  }
  return {};
}

function runWarmupOnce(cwd: string): void {
  runWarmup(cwd, {
    env: process.env,
    hasIndex: realHasIndex,
    isTrusted: (c) => isTrustedProject(c, process.env),
    isBroadDir: (c) => isBroadDirectory(c, homedir()),
    exec: realWarmupExec,
    log: (m) => logError(m),
    timeoutMs: SYNC_TIMEOUT_MS,
    initTimeoutMs: INIT_TIMEOUT_MS,
  });
}

runMain(import.meta.url, main);
