// `node dist/cli/coordinator.js [--action on|off|status] [--data-dir <dir>]`
// Coordinator mode is a PROMPT mode: it stores the delegation mode (on = full, off = organic) in plugin
// state and the session context states it. No hook enforces it.
// Without --action (or `status`): prints the effective mode (read-only).
// Exit codes: 0 ok; 1 invalid action; 2 usage error / no data dir.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readPluginState } from "../lib/state.js";
import { readDelegationMode, writeDelegationMode } from "../lib/context.js";
import { envWithDataDir, flagValue } from "../lib/system.js";
const USAGE = "usage: coordinator.js [--action on|off|status] [--data-dir <dir>]";
const ACTIONS = ["on", "off", "status"];
const NOTE = "It is a prompt rule the orchestrator follows; no hook blocks edits.";
function usageError(message) {
    return { exitCode: 2, stdout: "", stderr: `error: usage: ${message}\n${USAGE}` };
}
export function coordinatorCli(argv, env) {
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--action" || a === "--data-dir") {
            const v = argv[i + 1];
            if (v === undefined || v === "" || v.startsWith("--"))
                return usageError(`${a} needs a value`);
            i++;
        }
        else
            return usageError(`unknown argument ${a}`);
    }
    const opts = { env: envWithDataDir(argv, env) };
    const action = flagValue(argv, "--action") ?? "status";
    if (!ACTIONS.includes(action)) {
        return { exitCode: 1, stdout: "", stderr: `error: invalid action ${JSON.stringify(action)}; available actions: ${ACTIONS.join(", ")}` };
    }
    if (action !== "status") {
        writeDelegationMode(action === "on" ? "full" : "organic", opts);
        return {
            exitCode: 0,
            stdout: `coordinator mode set to: ${action}\n${NOTE}\nApplies from the next session start (or /clear).`,
            stderr: "",
        };
    }
    const mode = readDelegationMode(opts);
    let stored = false;
    try {
        stored = readPluginState("delegation", opts).mode === mode;
    }
    catch {
        stored = false;
    }
    return {
        exitCode: 0,
        stdout: `coordinator mode: ${mode === "full" ? "on" : "off"} (${stored ? "stored" : "default"})\n${NOTE}\navailable actions: ${ACTIONS.join(", ")}`,
        stderr: "",
    };
}
function main() {
    const res = coordinatorCli(process.argv.slice(2), process.env);
    if (res.stdout !== "")
        process.stdout.write(res.stdout + "\n");
    if (res.stderr !== "")
        process.stderr.write(res.stderr + "\n");
    process.exitCode = res.exitCode;
}
try {
    if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)))
        main();
}
catch {
    // importing must never throw
}
