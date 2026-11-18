// `node dist/cli/setup.js [--mode <m> | --statusline on|off [--replace-statusline]] [--apply]
//                         [--restore [backup]] [--settings <path>] [--data-dir <dir>]
//                         [--plugin-root <dir>] [--json]`
// Without --apply it is a dry run: prints the diff and writes nothing.
// Exit codes: 0 ok (dry run, applied, unchanged, info); 1 refused/failed (invalid mode,
// invalid JSON settings, unknown backup, write error); 2 usage error.
import { realpathSync } from "node:fs";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MODES, STATUSLINE_ACTIONS, currentMode, currentStatusLine, isOwnStatusLine, modeWarning, planModeChange, statusLineCommand } from "../lib/setup.js";
import { applyMode, applyRestore, applyStatusLine, listBackups, planRestore, planStatusLine, shimPath } from "../lib/setup-fs.js";
const VALUE_FLAGS = ["--mode", "--settings", "--data-dir", "--statusline", "--plugin-root"];
const BOOL_FLAGS = ["--apply", "--json", "--replace-statusline"];
function parseArgs(argv) {
    const a = { apply: false, json: false, restore: false, replaceStatusline: false };
    for (let i = 0; i < argv.length; i++) {
        const f = argv[i];
        if (BOOL_FLAGS.includes(f)) {
            if (f === "--apply")
                a.apply = true;
            else if (f === "--json")
                a.json = true;
            else
                a.replaceStatusline = true;
        }
        else if (VALUE_FLAGS.includes(f)) {
            const v = argv[++i];
            if (v === undefined || v === "" || v.startsWith("--"))
                return `${f} needs a value`;
            if (f === "--mode")
                a.mode = v;
            else if (f === "--settings")
                a.settings = v;
            else if (f === "--statusline")
                a.statusline = v;
            else if (f === "--plugin-root")
                a.pluginRoot = v;
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
    if (a.statusline !== undefined && !STATUSLINE_ACTIONS.includes(a.statusline))
        return `--statusline must be one of: ${STATUSLINE_ACTIONS.join(", ")}`;
    if (a.statusline !== undefined && (a.restore || a.mode !== undefined))
        return "--statusline cannot be combined with --mode or --restore";
    if (a.replaceStatusline && a.statusline !== "on")
        return "--replace-statusline needs --statusline on";
    if (a.apply && !a.restore && a.mode === undefined && a.statusline === undefined)
        return "--apply needs --mode <mode>, --statusline on|off or --restore";
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
    const dataDir = args.dataDir ?? (env.CLAUDE_PLUGIN_DATA || undefined);
    if (!args.restore && args.mode === undefined && args.statusline === undefined) {
        const text = existsSync(settingsPath) ? readFileSync(settingsPath, "utf8") : null;
        const cur = currentMode(text);
        const sl = currentStatusLine(text);
        const slText = sl === undefined ? "(not set)" : `${JSON.stringify(sl)} (${dataDir !== undefined && isOwnStatusLine(sl, statusLineCommand(shimPath(dataDir))) ? "odd-claude" : "not odd-claude"})`;
        const backups = dataDir ? listBackups(dataDir) : [];
        const lines = [
            `settings: ${settingsPath}${text === null ? " (missing)" : ""}`,
            `permissions.defaultMode: ${cur ?? "(not set)"}`,
            `statusLine: ${slText}`,
            `available modes: ${MODES.join(", ")}`,
            `backups: ${backups.length}`,
            ...backups.map((b) => `  ${b}`),
        ];
        return out({ status: "info", settingsPath, currentMode: cur ?? null, statusLine: sl ?? null, modes: [...MODES], backups }, lines.join("\n"), 0);
    }
    if (dataDir === undefined)
        return fail(argv, "usage: no data dir (pass --data-dir or set CLAUDE_PLUGIN_DATA)", 2, true);
    const base = { settingsPath, dataDir };
    if (args.statusline !== undefined) {
        const sl = { ...base, action: args.statusline, pluginRoot: resolve(args.pluginRoot ?? env.CLAUDE_PLUGIN_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), "..", "..")), replaceForeign: args.replaceStatusline };
        if (args.apply)
            return render(argv, applyStatusLine(sl), "applied", out);
        const p = planStatusLine(sl);
        if (!p.ok)
            return fail(argv, p.error, 1);
        const w = p.foreign
            ? "WARNING: settings already has a statusLine that odd-claude did not write (the `-` lines above). Applying replaces it only with --replace-statusline; the original stays in the backup and `--statusline off` puts it back."
            : undefined;
        return out({ status: "dry-run", changed: p.changed, foreign: p.foreign, diff: p.diff, ...(w === undefined ? {} : { warning: w }) }, (p.changed ? `${p.diff}\n\ndry run: nothing written. Re-run with --apply${p.foreign ? " --replace-statusline" : ""} to write it` : `${p.diff}\n\ndry run: nothing to do`) + (w === undefined ? "" : `\n\n${w}`), 0);
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
const USAGE = "usage: setup.js [--mode default|acceptEdits|auto|plan|bypassPermissions | --statusline on|off [--replace-statusline]] [--apply] [--restore [backup]] [--settings <path>] [--data-dir <dir>] [--plugin-root <dir>] [--json] [--help]";
const HELP = `${USAGE}

Writes ONLY permissions.defaultMode or statusLine of the settings file (default ~/.claude/settings.json).
--statusline on sets statusLine to {"type":"command","command":"node '<data-dir>/statusline.mjs'"}: a stable shim
that imports <plugin-root>/dist/cli/statusline.js (the root changes on plugin updates; the SessionStart hook
refreshes the shim, so settings never need to be rewritten). A statusLine odd-claude did not write is shown in the
diff and replaced only with --replace-statusline. --statusline off removes only odd-claude's own statusLine, or
puts back the user's previous one that --replace-statusline displaced.
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
