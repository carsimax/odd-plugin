// `node dist/cli/review-mode.js <enable|disable|status> [--scope global|clone] [--cwd <repo>] [--data-dir <dir>] [--json]`
// The RDD mode switch (U13). Review-driven development is OFF until enabled. `global` (default) is the user-wide
// switch kept in plugin state; `clone` is an off-only override for one repository under <git-common-dir>/odd-plugin.
// `status` is read-only. Exit codes: 0 ok; 1 the switch could not be written; 2 usage error.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MODE_SCHEMA, readReviewMode, ReviewModeError, setReviewMode } from "../review/mode.js";
import { envWithDataDir } from "../lib/system.js";
const USAGE = "usage: review-mode.js <enable|disable|status> [--scope global|clone] [--cwd <repo>] [--data-dir <dir>] [--json]";
const VERBS = ["enable", "disable", "status"];
const usageError = (message) => ({ exitCode: 2, stdout: "", stderr: `error: ${message}\n${USAGE}` });
function render(s, note) {
    const lines = [
        `review-driven development: ${s.effective} (decided by ${s.source})`,
        `  global:      ${s.global}`,
        `  clone-local: ${s.cloneLocal}`,
        ...s.problems.map((p) => `  problem:     ${p}`),
    ];
    if (note)
        lines.push("  note:        a clone-local override can only disable, so this cleared the clone's off opinion and the global switch still decides; run `review-mode.js enable` (global scope) to turn it on");
    return lines.join("\n");
}
export function reviewModeCli(argv, env, cwd = process.cwd()) {
    let verb;
    let scope;
    let repo;
    let json = false;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--scope" || a === "--cwd" || a === "--data-dir") {
            const v = argv[i + 1];
            if (v === undefined || v === "" || v.startsWith("--"))
                return usageError(`${a} needs a value`);
            if (a === "--scope")
                scope = v;
            else if (a === "--cwd")
                repo = v;
            i++;
        }
        else if (a === "--json")
            json = true;
        else if (a.startsWith("--"))
            return usageError(`unknown argument ${a}`);
        else if (verb === undefined)
            verb = a;
        else
            return usageError(`unexpected argument ${a}`);
    }
    if (verb === undefined || !VERBS.includes(verb))
        return usageError(verb === undefined ? "a verb is required" : `unknown verb ${JSON.stringify(verb)}`);
    if (scope !== undefined && scope !== "global" && scope !== "clone")
        return usageError(`unknown scope ${JSON.stringify(scope)}`);
    if (verb === "status" && scope !== undefined)
        return usageError("status reads both scopes; do not pass --scope");
    const opts = { env: envWithDataDir(argv, env) };
    const where = repo ?? cwd;
    try {
        if (verb === "status") {
            const s = readReviewMode(where, opts);
            const text = json ? JSON.stringify({ schema: MODE_SCHEMA, operation: "status", scope: "both", status: s }) : render(s, false);
            return { exitCode: 0, stdout: text, stderr: "" };
        }
        const chosen = scope === "clone" ? "clone" : "global";
        const s = setReviewMode(verb, chosen, where, opts);
        const note = verb === "enable" && chosen === "clone" && s.effective === "off" && s.source === "global";
        const text = json ? JSON.stringify({ schema: MODE_SCHEMA, operation: verb, scope: chosen, status: s }) : render(s, note);
        return { exitCode: 0, stdout: text, stderr: "" };
    }
    catch (err) {
        if (err instanceof ReviewModeError)
            return { exitCode: 1, stdout: "", stderr: `error: ${err.message}` };
        throw err;
    }
}
function main() {
    const res = reviewModeCli(process.argv.slice(2), process.env);
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
