// `node dist/cli/setup.js [--mode <m> | --deny-profile install|remove] [--apply] [--restore [backup]] [--settings <path>] [--data-dir <dir>] [--json]`
// Without --apply it is a dry run: prints the diff and writes nothing.
// Exit codes: 0 ok (dry run, applied, unchanged, info); 1 refused/failed (invalid mode,
// invalid JSON settings, unknown backup, write error); 2 usage error.
import { dataDirFromEnv } from "../lib/state.js";
import { realpathSync } from "node:fs";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MODES, currentMode, modeWarning, planModeChange } from "../lib/setup.js";
import { applyDenyProfile, applyMode, applyRestore, listBackups, planDeny, planRestore } from "../lib/setup-fs.js";
import { DENY_ACTIONS, DENY_PROFILE_RULES, isDenyAction } from "../lib/deny-profile.js";
const VALUE_FLAGS = ["--mode", "--deny-profile", "--settings", "--data-dir"];
const BOOL_FLAGS = ["--apply", "--json"];
function parseArgs(argv) {
    const a = { apply: false, json: false, restore: false };
    for (let i = 0; i < argv.length; i++) {
        const f = argv[i];
        if (BOOL_FLAGS.includes(f)) {
            if (f === "--apply")
                a.apply = true;
            else
                a.json = true;
        }
        else if (VALUE_FLAGS.includes(f)) {
            const v = argv[++i];
            if (v === undefined || v === "" || v.startsWith("--"))
                return `${f} needs a value`;
            if (f === "--mode")
                a.mode = v;
            else if (f === "--deny-profile") {
                if (a.denyProfile !== undefined)
                    return "--deny-profile given more than once";
                a.denyProfile = v;
            }
            else if (f === "--settings")
                a.settings = v;
            else
                a.dataDir = v;
        }
        else if (f === "--restore") {
            a.restore = true;
            const v = argv[i + 1];
            if (v !== undefined && !v.startsWith("--"))
                a.backup = argv[++i];
        }
        else
            return `unknown argument ${f}`;
    }
    if (a.restore && a.mode !== undefined)
        return "--restore and --mode are mutually exclusive";
    if (a.denyProfile !== undefined) {
        if (!isDenyAction(a.denyProfile))
            return `--deny-profile must be one of ${DENY_ACTIONS.join(", ")}`;
        if (a.restore || a.mode !== undefined)
            return "--deny-profile cannot be combined with --mode or --restore";
    }
    if (a.apply && !a.restore && a.mode === undefined && a.denyProfile === undefined)
        return "--apply needs --mode <mode>, --deny-profile <install|remove> or --restore";
    return a;
}
function errorMessage(err) {
    return err instanceof Error ? err.message : String(err);
}
export function setupCli(argv, env) {
    try {
        return run(argv, env);
    }
    catch (err) {
        return fail(argv, errorMessage(err), 1);
    }
}
/** Errors: `error: <message>` on stderr (JSON object on stdout with --json). */
function fail(argv, message, exitCode, withUsage = false) {
    if (argv.includes("--json"))
        return { exitCode, stdout: JSON.stringify({ status: "error", error: message }, null, 2), stderr: "" };
    return { exitCode, stdout: "", stderr: `error: ${message}${withUsage ? `\n${USAGE}` : ""}` };
}
function run(argv, env) {
    if (argv.includes("--help") || argv.includes("-h"))
        return { exitCode: 0, stdout: HELP, stderr: "" };
    const args = parseArgs(argv);
    const out = (o, text, exitCode) => ({
        exitCode,
        stdout: argv.includes("--json") ? JSON.stringify(o, null, 2) : text,
        stderr: "",
    });
    if (typeof args === "string")
        return fail(argv, `usage: ${args}`, 2, true);
    const settingsPath = args.settings ?? join(homedir(), ".claude", "settings.json");
    const dataDir = args.dataDir ?? dataDirFromEnv(env);
    if (!args.restore && args.mode === undefined && args.denyProfile === undefined) {
        const text = existsSync(settingsPath) ? readFileSync(settingsPath, "utf8") : null;
        const cur = currentMode(text);
        const backups = listBackups(dataDir);
        const lines = [
            `settings: ${settingsPath}${text === null ? " (missing)" : ""}`,
            `permissions.defaultMode: ${cur ?? "(not set)"}`,
            `available modes: ${MODES.join(", ")}`,
            `backups: ${backups.length}`,
            ...backups.map((b) => `  ${b}`),
        ];
        return out({ status: "info", settingsPath, currentMode: cur ?? null, modes: [...MODES], backups }, lines.join("\n"), 0);
    }
    const base = { settingsPath, dataDir };
    if (args.denyProfile !== undefined) {
        const action = args.denyProfile;
        if (!args.apply) {
            const p = planDeny({ ...base, action });
            if (!p.ok)
                return fail(argv, p.error, 1);
            return out({ status: "dry-run", changed: p.changed, diff: p.diff, rules: [...DENY_PROFILE_RULES] }, p.changed ? `${p.diff}\n\ndry run: nothing written. Re-run with --apply to write it` : `${p.diff}\n\ndry run: nothing to do`, 0);
        }
        return render(argv, applyDenyProfile({ ...base, action }), "applied", out);
    }
    if (args.restore) {
        if (!args.apply) {
            const p = planRestore({ ...base, backup: args.backup });
            if (!p.ok)
                return fail(argv, p.error, 1);
            return out({ status: "dry-run", changed: p.changed, diff: p.diff, backup: p.backupPath }, `${p.diff}\n\ndry run: nothing written. Re-run with --apply to restore ${p.backupPath}`, 0);
        }
        return render(argv, applyRestore({ ...base, backup: args.backup }), "restored", out);
    }
    if (!args.apply) {
        const text = existsSync(settingsPath) ? readFileSync(settingsPath, "utf8") : null;
        const p = planModeChange(text, args.mode, settingsPath);
        if (!p.ok)
            return fail(argv, p.error, 1);
        const w = modeWarning(args.mode);
        const tail = w === undefined ? "" : `\n\n${w}`;
        return out({ status: "dry-run", changed: p.changed, diff: p.diff, ...(w === undefined ? {} : { warning: w }) }, (p.changed ? `${p.diff}\n\ndry run: nothing written. Re-run with --apply to write it` : `${p.diff}\n\ndry run: nothing to do`) + tail, 0);
    }
    const applied = render(argv, applyMode({ ...base, mode: args.mode }), "applied", out);
    const w = modeWarning(args.mode);
    if (w === undefined || applied.exitCode !== 0)
        return applied;
    if (argv.includes("--json"))
        return { ...applied, stdout: JSON.stringify({ ...JSON.parse(applied.stdout), warning: w }, null, 2) };
    return { ...applied, stdout: `${applied.stdout}\n\n${w}` };
}
function render(argv, r, verb, out) {
    if (r.status === "error")
        return fail(argv, r.error ?? "unknown error", 1);
    if (r.status === "unchanged")
        return out({ status: "unchanged", changed: false, diff: r.diff }, "no changes: nothing written", 0);
    const text = `${r.diff}\n\n${verb}.${r.backupPath ? `\nbackup: ${r.backupPath}` : "\nbackup: none (no previous file)"}`;
    return out({ status: verb === "applied" ? "applied" : "restored", changed: true, diff: r.diff, backup: r.backupPath ?? null }, text, 0);
}
const USAGE = "usage: setup.js [--mode default|acceptEdits|auto|plan|bypassPermissions | --deny-profile install|remove] [--apply] [--restore [backup]] [--settings <path>] [--data-dir <dir>] [--json] [--help]";
const HELP = `${USAGE}

Writes ONLY permissions.defaultMode of the settings file (default ~/.claude/settings.json), or, with the
explicit opt-in --deny-profile install|remove, the permission rules of the odd-claude deny profile
(Read/Edit of .env files, ~/.ssh, ~/.aws/credentials, *.pem and *.key, plus Bash(git push *) and
Bash(gh pr merge *)). The installer never writes it. install merges only the missing rules and records
which ones it added; remove deletes only those, so rules you already had survive. Bash(git push *)
does not catch variants such as "git -C . push".
Without --apply it is a dry run: prints the diff and writes nothing.
--apply backs up the original to <data-dir>/backups (mode 0600) first, then writes atomically,
keeping the file mode and following a symlinked settings file. A read-only file is refused.

exit codes: 0 ok (dry run, applied, unchanged, info); 1 refused or failed (invalid mode, invalid JSON
settings, unknown backup, unwritable/unreadable file, write error); 2 usage error.
Errors go to stderr as "error: <message>" (a JSON object on stdout with --json).

Known limitations:
- The file is reserialized from parsed JSON: integers beyond 2^53 lose precision, -0 becomes 0,
  duplicate keys collapse, number forms are normalized and the whole file may be reformatted
  (the diff shows it). Content is otherwise preserved.
- Very large files (more than ~15k lines) make the diff slow and memory hungry.
- --restore without a name toggles between the last two states, because restoring first backs up
  the current file; pass an explicit backup name to pick another one.
`;
function main() {
    const res = setupCli(process.argv.slice(2), process.env);
    if (res.stdout !== "")
        process.stdout.write(res.stdout + "\n");
    if (res.stderr !== "")
        process.stderr.write(res.stderr + "\n");
    process.exitCode = res.exitCode;
}
let isMain = false;
try {
    isMain = !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
}
catch {
    // importing must never throw
}
if (isMain)
    main();
