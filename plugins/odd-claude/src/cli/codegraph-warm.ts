// `node dist/cli/codegraph-warm.js <cwd>`: detached codegraph warm-up started by the SessionStart hook.
// Hard time bound on the codegraph call; result logged to <data dir>/logs/hooks.log; always exits 0.
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { INIT_TIMEOUT_MS, SYNC_TIMEOUT_MS, isBroadDirectory, realHasIndex, realWarmupExec, runWarmup } from "../lib/codegraph.js";
import { logError } from "../lib/state.js";

function main(): void {
  const cwd = process.argv[2];
  if (!cwd) return;
  runWarmup(cwd, {
    env: process.env,
    hasIndex: realHasIndex,
    isBroadDir: (c) => isBroadDirectory(c, homedir()),
    exec: realWarmupExec,
    log: (m) => logError(m),
    timeoutMs: SYNC_TIMEOUT_MS,
    initTimeoutMs: INIT_TIMEOUT_MS,
  });
}

try {
  if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main();
} catch {
  // fail safe
}
