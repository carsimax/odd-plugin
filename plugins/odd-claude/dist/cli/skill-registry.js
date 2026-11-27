// `node dist/cli/skill-registry.js [--cwd <dir>] [--force]`: refresh of <cwd>/.atl/skill-registry.md.
// Without --force the Git-tracked guard and the opt-out apply (same as the hook). Exit codes: 0 written/unchanged; 1 skipped; 2 usage error.
import { homedir } from "node:os";
import { realGitTracked, realPluginRoots, refreshRegistry } from "../lib/skill-registry.js";
import { lockPath, releaseLock } from "../lib/lock.js";
import { dataDirFromEnv } from "../lib/state.js";
import { flagValue, runMain } from "../lib/system.js";
const USAGE = "usage: skill-registry.js [--cwd <dir>] [--force]";
export function skillRegistryCli(argv, base) {
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === "--cwd") {
            const v = argv[i + 1];
            if (v === undefined || v === "" || v.startsWith("--"))
                return { exitCode: 2, stdout: "", stderr: `error: usage: --cwd needs a value\n${USAGE}` };
            i++;
        }
        else if (argv[i] === "--force")
            continue;
        else
            return { exitCode: 2, stdout: "", stderr: `error: usage: unknown argument ${argv[i]}\n${USAGE}` };
    }
    const cwd = flagValue(argv, "--cwd") ?? base.cwd ?? process.cwd();
    const r = refreshRegistry({ ...base, cwd, force: argv.includes("--force") });
    if (r.status === "skipped") {
        return { exitCode: 1, stdout: "", stderr: `skill registry skipped: ${r.reason}${r.warning ? ` (${r.warning})` : ""}` };
    }
    const noun = `${r.skillCount} skill${r.skillCount === 1 ? "" : "s"}`;
    return {
        exitCode: 0,
        stdout: r.status === "written" ? `skill registry: ${noun} written to ${r.registryPath}` : `skill registry: ${noun} unchanged in ${r.registryPath}`,
        stderr: "",
    };
}
function main() {
    const home = homedir();
    const res = skillRegistryCli(process.argv.slice(2), {
        home,
        plugins: realPluginRoots(process.env, home),
        env: process.env,
        gitTracked: realGitTracked,
    });
    // Detached SessionStart refreshes hold an in-flight lock (see session-integrations.ts); free it when done.
    releaseLock(lockPath(dataDirFromEnv(process.env), "registry", flagValue(process.argv.slice(2), "--cwd") ?? process.cwd()), process.pid);
    return res;
}
runMain(import.meta.url, main);
