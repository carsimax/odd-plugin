// Write path of /odd-setup. Real filesystem; callers (tests/CLI) pick the paths.
// Order on apply: validate/plan -> backup original (atomic) -> record state -> atomic write.
import { accessSync, constants, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { denyRulesIn, planDenyProfile } from "./deny-profile.js";
import { atomicWriteFile, readPluginState, writePluginState } from "./state.js";
import { BACKUP_NAME_RE, NO_CHANGES, backupFileName, planModeChange, unifiedDiff, } from "./setup.js";
function readCurrent(path) {
    return existsSync(path) ? readFileSync(path) : null;
}
export function backupsDir(dataDir) {
    return join(dataDir, "backups");
}
/** Backup file names, newest first (names embed a sortable timestamp). */
export function listBackups(dataDir) {
    try {
        return readdirSync(backupsDir(dataDir))
            .filter((f) => BACKUP_NAME_RE.test(f))
            .sort()
            .reverse();
    }
    catch {
        return [];
    }
}
/** Follows a symlinked settings file so the link is kept and its target updated. */
export function resolveTarget(path) {
    try {
        if (lstatSync(path).isSymbolicLink())
            return { ok: true, path: realpathSync(path) };
    }
    catch (err) {
        if (err.code === "ENOENT") {
            // lstat failing means the path itself is missing: fine (will be created)
            return { ok: true, path };
        }
        return { ok: false, error: `cannot inspect ${path}: ${err.message}` };
    }
    return { ok: true, path };
}
/** Error text when an existing target cannot be written by this user; undefined when fine. */
export function notWritable(path) {
    if (!existsSync(path))
        return undefined;
    try {
        accessSync(path, constants.W_OK);
        return undefined;
    }
    catch {
        return `${path} is not writable by this user (read-only?); refusing to overwrite it`;
    }
}
function writeBackup(dataDir, original, now) {
    const dir = backupsDir(dataDir);
    let path = join(dir, backupFileName(now));
    for (let n = 1; existsSync(path); n++)
        path = join(dir, backupFileName(now).replace(/\.json$/, `-${n}.json`));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    atomicWriteFile(path, original, 0o600);
    return path;
}
function record(dataDir, backupPath) {
    const prev = readPluginState("setup", { dataDir });
    const backups = Array.isArray(prev.backups) ? prev.backups : [];
    writePluginState("setup", { ...prev, lastBackup: backupPath, backups: [...backups, backupPath] }, { dataDir });
}
export function fileMode(path) {
    return existsSync(path) ? statSync(path).mode & 0o7777 : undefined;
}
/** Shared tail of apply/restore: backup current, record state, atomic write keeping the mode. */
function commit(opts, target, content, diff, what, afterWrite) {
    let backupPath;
    try {
        const cur = readCurrent(target);
        if (cur !== null) {
            backupPath = writeBackup(opts.dataDir, cur, opts.now ?? new Date());
            record(opts.dataDir, backupPath);
        }
        atomicWriteFile(target, content, fileMode(target));
        if (afterWrite) {
            try {
                afterWrite();
            }
            catch (err) {
                const undo = backupPath ? `run \`--restore ${basename(backupPath)} --apply\` to undo it` : "undo it by hand (there was no previous file to restore)";
                return {
                    status: "error",
                    diff,
                    error: `${what}: settings were written, but ownership of the deny profile rules was not recorded (${err.message}); fix the data dir and ${undo}, or remove the rules by hand`,
                    backupPath,
                };
            }
        }
        return { status: "applied", diff, backupPath };
    }
    catch (err) {
        const kept = backupPath ? `; backup kept at ${backupPath}` : "";
        return { status: "error", diff, error: `${what} failed: ${err.message}${kept}; settings left as they were`, backupPath };
    }
}
export function applyMode(opts) {
    const t = resolveTarget(opts.settingsPath);
    if (!t.ok)
        return { status: "error", diff: NO_CHANGES, error: t.error };
    if (lstatDangling(opts.settingsPath, t.path))
        return { status: "error", diff: NO_CHANGES, error: `${opts.settingsPath} is a dangling symlink` };
    let cur;
    try {
        cur = readCurrent(t.path);
    }
    catch (err) {
        return { status: "error", diff: NO_CHANGES, error: `cannot read ${t.path}: ${err.message}` };
    }
    const plan = planModeChange(cur === null ? null : cur.toString("utf8"), opts.mode, opts.settingsPath);
    if (!plan.ok)
        return { status: "error", diff: NO_CHANGES, error: plan.error };
    if (!plan.changed)
        return { status: "unchanged", diff: plan.diff };
    const nw = notWritable(t.path);
    if (nw)
        return { status: "error", diff: plan.diff, error: nw };
    return commit(opts, t.path, plan.after, plan.diff, "write");
}
/** A symlink whose target does not exist: realpath would have thrown, so the path is unchanged. */
export function lstatDangling(path, resolved) {
    try {
        return lstatSync(path).isSymbolicLink() && !existsSync(resolved);
    }
    catch {
        return false;
    }
}
export function planRestore(opts) {
    const names = listBackups(opts.dataDir);
    let name;
    if (opts.backup === undefined)
        name = names[0];
    else
        name = names.includes(opts.backup) ? opts.backup : undefined;
    if (name === undefined) {
        return {
            ok: false,
            error: opts.backup === undefined ? "no backups to restore" : `unknown backup "${opts.backup}"; available: ${names.join(", ") || "none"}`,
        };
    }
    const backupPath = join(backupsDir(opts.dataDir), name);
    const content = readFileSync(backupPath);
    try {
        JSON.parse(content.toString("utf8"));
    }
    catch {
        return { ok: false, error: `backup ${name} is not valid JSON; refusing to restore it` };
    }
    let cur;
    try {
        cur = readCurrent(opts.settingsPath);
    }
    catch (err) {
        return { ok: false, error: `cannot read ${opts.settingsPath}: ${err.message}` };
    }
    const same = cur !== null && cur.equals(content);
    const diff = same ? NO_CHANGES : unifiedDiff(cur === null ? "" : cur.toString("utf8"), content.toString("utf8"), opts.settingsPath, `${opts.settingsPath} (restored from ${name})`);
    return { ok: true, changed: !same, diff, backupPath, content };
}
/** Restores atomically; the current file is backed up first so a restore is itself reversible. */
export function applyRestore(opts) {
    const plan = planRestore(opts);
    if (!plan.ok)
        return { status: "error", diff: NO_CHANGES, error: plan.error };
    if (!plan.changed)
        return { status: "unchanged", diff: plan.diff };
    const t = resolveTarget(opts.settingsPath);
    if (!t.ok)
        return { status: "error", diff: plan.diff, error: t.error };
    const nw = notWritable(t.path);
    if (nw)
        return { status: "error", diff: plan.diff, error: nw };
    const restored = new Set(denyRulesIn(plan.content.toString("utf8")));
    return commit(opts, t.path, plan.content, plan.diff, "restore", () => {
        const owned = readDenyOwned(opts.dataDir);
        const kept = owned.filter((r) => restored.has(r));
        if (kept.length !== owned.length)
            recordDenyOwned(opts.dataDir, kept);
    });
}
const DENY_OWNED_KEY = "denyProfileOwned";
/** Rules a previous `deny-profile install` recorded as added by it (empty when none). */
export function readDenyOwned(dataDir) {
    const v = readPluginState("setup", { dataDir })[DENY_OWNED_KEY];
    return Array.isArray(v) ? v.filter((r) => typeof r === "string") : [];
}
function readSettingsText(path) {
    const t = resolveTarget(path);
    if (!t.ok)
        return t;
    if (lstatDangling(path, t.path))
        return { ok: false, error: `${path} is a dangling symlink` };
    try {
        const cur = readCurrent(t.path);
        return { ok: true, target: t.path, text: cur === null ? null : cur.toString("utf8") };
    }
    catch (err) {
        return { ok: false, error: `cannot read ${t.path}: ${err.message}` };
    }
}
/** Dry-run plan of the opt-in deny profile; same file reading rules as apply. */
export function planDeny(opts) {
    const r = readSettingsText(opts.settingsPath);
    if (!r.ok)
        return r;
    const plan = planDenyProfile(r.text, opts.action, readDenyOwned(opts.dataDir), opts.settingsPath);
    return plan.ok ? { ...plan, target: r.target } : plan;
}
/** Same safety as applyMode: plan, backup, atomic write; ownership is recorded only after the write. */
export function applyDenyProfile(opts) {
    const plan = planDeny(opts);
    if (!plan.ok)
        return { status: "error", diff: NO_CHANGES, error: plan.error };
    if (!plan.changed) {
        if (JSON.stringify(plan.owned) !== JSON.stringify(readDenyOwned(opts.dataDir)))
            recordDenyOwned(opts.dataDir, plan.owned);
        return { status: "unchanged", diff: plan.diff };
    }
    const nw = notWritable(plan.target);
    if (nw)
        return { status: "error", diff: plan.diff, error: nw };
    return commit(opts, plan.target, plan.after, plan.diff, "write", () => recordDenyOwned(opts.dataDir, plan.owned));
}
function recordDenyOwned(dataDir, owned) {
    const prev = readPluginState("setup", { dataDir });
    writePluginState("setup", { ...prev, [DENY_OWNED_KEY]: owned }, { dataDir });
}
