// `node dist/cli/codegraph-trust.js [--action trust|untrust|list] [--cwd <dir>] [--data-dir <dir>]`
// Explicit user opt-in for the SessionStart codegraph warm-up of one project (default cwd: current dir).
// Exit codes: 0 ok; 1 invalid action; 2 usage error / no data dir.
import { listTrustedProjects, trustProject, untrustProject } from "../lib/codegraph-trust.js";
import { envWithDataDir, flagValue, runMain } from "../lib/system.js";
const USAGE = "usage: codegraph-trust.js [--action trust|untrust|list] [--cwd <dir>] [--data-dir <dir>]";
const ACTIONS = ["trust", "untrust", "list"];
function usageError(message) {
    return { exitCode: 2, stdout: "", stderr: `error: usage: ${message}\n${USAGE}` };
}
export function codegraphTrustCli(argv, env, defaultCwd = process.cwd()) {
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--action" || a === "--cwd" || a === "--data-dir") {
            const v = argv[i + 1];
            if (v === undefined || v === "" || v.startsWith("--"))
                return usageError(`${a} needs a value`);
            i++;
        }
        else
            return usageError(`unknown argument ${a}`);
    }
    const action = flagValue(argv, "--action") ?? "list";
    if (!ACTIONS.includes(action)) {
        return { exitCode: 1, stdout: "", stderr: `error: invalid action ${JSON.stringify(action)}; available actions: ${ACTIONS.join(", ")}` };
    }
    const opts = { env: envWithDataDir(argv, env) };
    const cwd = flagValue(argv, "--cwd") ?? defaultCwd;
    if (action === "list") {
        const l = listTrustedProjects(opts);
        return { exitCode: 0, stdout: l.length === 0 ? "no trusted projects" : l.join("\n"), stderr: "" };
    }
    if (action === "trust") {
        trustProject(cwd, opts);
        return { exitCode: 0, stdout: `trusted: ${cwd}\nSessionStart will run \`codegraph sync\` here when a .codegraph index exists.`, stderr: "" };
    }
    untrustProject(cwd, opts);
    return { exitCode: 0, stdout: `untrusted: ${cwd}`, stderr: "" };
}
const main = () => codegraphTrustCli(process.argv.slice(2), process.env);
runMain(import.meta.url, main);
