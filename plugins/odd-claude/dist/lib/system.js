// Real implementations of the injected probes (exec, filesystem). Kept apart from the
// pure logic so tests never touch the machine.
import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
/** Runs `fn` and writes its result when the module at `metaUrl` is the entry script; only the entry detection is guarded, a thrown action error goes to stderr with exit code 1. */
export function runMain(metaUrl, fn) {
    let isMain = false;
    try {
        isMain = !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(metaUrl));
    }
    catch {
        // importing must never throw
    }
    if (!isMain)
        return;
    try {
        const r = fn();
        if (r.stdout)
            process.stdout.write(r.stdout + "\n");
        if (r.stderr)
            process.stderr.write(r.stderr + "\n");
        process.exitCode = r.exitCode ?? 0;
    }
    catch (e) {
        process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
        process.exitCode = 1;
    }
}
export function realExec(cmd, args) {
    const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] });
    if (r.error || r.status !== 0)
        return undefined;
    return `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
}
/** Read-only: checks the dir, or its nearest existing ancestor when it does not exist yet. */
export function realIsWritable(dir) {
    let cur = dir;
    while (!existsSync(cur)) {
        const parent = dirname(cur);
        if (parent === cur)
            return false;
        cur = parent;
    }
    try {
        accessSync(cur, constants.W_OK);
        return true;
    }
    catch {
        return false;
    }
}
/** Keys of <CLAUDE_CONFIG_DIR or ~/.claude>/plugins/installed_plugins.json, or undefined when unreadable. */
export function realInstalledPlugins(env = process.env) {
    try {
        const raw = JSON.parse(readFileSync(join(env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "plugins", "installed_plugins.json"), "utf8"));
        return raw.plugins ? Object.keys(raw.plugins) : undefined;
    }
    catch {
        return undefined;
    }
}
/** Version of the global install behind `<ODD_CLAUDE_HOME or ~/.odd-claude>/current`; undefined when absent or unreadable. */
export function realInstalledVersion(env = process.env) {
    try {
        const current = join(env.ODD_CLAUDE_HOME || join(homedir(), ".odd-claude"), "current");
        const v = JSON.parse(readFileSync(join(realpathSync(current), "package.json"), "utf8")).version;
        return typeof v === "string" ? v : undefined;
    }
    catch {
        return undefined;
    }
}
/** Hook events of `<CLAUDE_CONFIG_DIR or ~/.claude>/settings.json` with a command running odd-claude's `dist/hooks/run.js`; undefined when unreadable. */
export function realHookEvents(env = process.env) {
    try {
        const raw = readFileSync(join(env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "settings.json"), "utf8");
        const hooks = JSON.parse(raw).hooks ?? {};
        return Object.keys(hooks).filter((e) => /\/dist\/hooks\/run\.js/.test(JSON.stringify(hooks[e])));
    }
    catch {
        return undefined;
    }
}
/** True when settings.json has a hook command running odd-claude's `dist/hooks/run.js`; undefined when unreadable. */
export function realHooksInstalled(env = process.env) {
    const events = realHookEvents(env);
    return events && events.length > 0;
}
/** Value of `--name <value>` in argv; undefined when absent or empty. */
export function flagValue(argv, name) {
    const v = argv[argv.indexOf(name) + 1];
    return argv.includes(name) && v !== undefined && v !== "" && !v.startsWith("--") ? v : undefined;
}
/** env with the data dir pinned to `--data-dir` when given (ODD_CLAUDE_DATA wins over every other source; skills pass the substituted path). */
export function envWithDataDir(argv, env) {
    const dir = flagValue(argv, "--data-dir");
    return dir === undefined ? env : { ...env, ODD_CLAUDE_DATA: dir };
}
