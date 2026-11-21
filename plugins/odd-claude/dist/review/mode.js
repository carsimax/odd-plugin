// RDD mode switch (U13). Review-driven development is OFF unless the user turns it on. Two sources, like the
// reference: a user-wide `global` value (plugin state, `<dataDir>/review-mode.json`) and a clone-local override
// (`<git-common-dir>/odd-plugin/review-mode.json`) that can only DISABLE. Any off wins, a clone can never force
// on, and every failure to read a source resolves to off. Reads never write. Nothing is sent anywhere.
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, statSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { atomicWriteFile, readPluginState, writePluginState } from "../lib/state.js";
import { resolveRepository, SnapshotError } from "./snapshot.js";
export const MODE_STATE_NAME = "review-mode";
export const MODE_SCHEMA = "odd-claude.review-mode/v1";
export const CLONE_MODE_SCHEMA = "odd-claude.review-mode-override/v1";
const MAX_OVERRIDE_BYTES = 4096;
export class ReviewModeError extends Error {
    constructor(message) {
        super(message);
        this.name = "ReviewModeError";
    }
}
export function cloneModePath(commonDir) {
    return join(commonDir, "odd-plugin", "review-mode.json");
}
function readGlobal(opts) {
    const mode = readPluginState(MODE_STATE_NAME, opts).mode;
    return mode === "on" || mode === "off" ? mode : "unset";
}
/**
 * Fast-path guard (T6): is the GLOBAL switch on? Same reader as `readReviewMode`: unset, off, unreadable, corrupt or
 * a wrong-version file are all "not on". A clone-local override can only DISABLE, so when this is false the effective
 * mode is off whatever any repository holds, and a caller may answer "off" without starting git. Reads nothing else.
 */
export function isGlobalModeOn(opts = {}) {
    return readGlobal(opts) === "on";
}
/** The `odd-plugin` dir of a clone: absent, a real directory, or anything else (symlink, file): never followed. */
function pluginDirKind(commonDir) {
    try {
        const st = lstatSync(join(commonDir, "odd-plugin"));
        return st.isDirectory() ? "dir" : "bad";
    }
    catch (err) {
        return err.code === "ENOENT" ? "absent" : "bad";
    }
}
function readClone(commonDir, problems) {
    const path = cloneModePath(commonDir);
    const kind = pluginDirKind(commonDir);
    if (kind === "absent")
        return "unset";
    if (kind === "bad") {
        problems.push(`clone-local review mode directory is not a real directory: ${join(commonDir, "odd-plugin")}`);
        return "unreadable";
    }
    let raw;
    try {
        const st = lstatSync(path);
        if (!st.isFile() || st.size > MAX_OVERRIDE_BYTES) {
            problems.push(`clone-local review mode is not a small regular file: ${path}`);
            return "unreadable";
        }
        raw = readFileSync(path, "utf8");
    }
    catch (err) {
        if (err.code === "ENOENT")
            return "unset";
        problems.push(`clone-local review mode cannot be read: ${path}`);
        return "unreadable";
    }
    try {
        const v = JSON.parse(raw);
        if (v && v.schema === CLONE_MODE_SCHEMA && v.mode === "off")
            return "off";
    }
    catch {
        // falls through
    }
    problems.push(`clone-local review mode is malformed: ${path}`);
    return "unreadable";
}
const gitBound = (opts) => ({ gitTimeoutMs: opts.gitTimeoutMs, ...(opts.deadlineAt !== undefined ? { deadlineAt: opts.deadlineAt } : {}) });
function resolveCommonDir(cwd, opts) {
    try {
        return resolveRepository(cwd, gitBound(opts)).commonDir;
    }
    catch (err) {
        if (err instanceof SnapshotError)
            return undefined;
        throw err;
    }
}
/** A small regular file read without following a symlink (O_NOFOLLOW, never blocks on a FIFO); anything else is undefined. */
function readSmallFile(path) {
    let fd;
    try {
        fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const st = fstatSync(fd);
        if (!st.isFile() || st.size > MAX_OVERRIDE_BYTES)
            return undefined;
        const buf = Buffer.alloc(st.size);
        const n = readSync(fd, buf, 0, st.size, 0);
        return buf.subarray(0, n).toString("utf8");
    }
    catch {
        return undefined;
    }
    finally {
        if (fd !== undefined)
            closeSync(fd);
    }
}
const isDir = (path) => {
    try {
        return statSync(path).isDirectory();
    }
    catch {
        return false;
    }
};
const absent = (path) => {
    try {
        lstatSync(path);
        return false;
    }
    catch (err) {
        return err.code === "ENOENT";
    }
};
/**
 * The common dir a `.git` FILE leads to, the way git reads it: `gitdir: <path>` (relative to the file's directory),
 * then `<gitdir>/commondir` (relative to the gitdir) when present, else the gitdir itself (a submodule). A
 * `commondir` that exists but cannot be read safely is not followed.
 */
function commonDirOfGitFile(file) {
    const text = readSmallFile(file);
    const m = text === undefined ? null : /^gitdir: ([^\r\n]+)/.exec(text);
    if (m === null)
        return undefined;
    const gitdir = resolve(dirname(file), m[1].trimEnd());
    if (!isDir(gitdir))
        return undefined;
    const marker = join(gitdir, "commondir");
    if (absent(marker))
        return gitdir;
    const target = readSmallFile(marker)?.trim();
    if (target === undefined || target === "")
        return undefined;
    const dir = isAbsolute(target) ? target : resolve(gitdir, target);
    return isDir(dir) ? dir : undefined;
}
/**
 * Where the clone-local override lives, for READING the mode. One rule: when git cannot resolve the repository
 * (failure, timeout) or does not trust it (`untrusted_repository`, dubious ownership), the override is looked up
 * DIRECTLY: the nearest `.git` (a real directory; a `.git` file is followed through `gitdir:` and `commondir`; a
 * symlink to a directory is resolved) names the real common dir. The nearest `.git` always decides, so a nested
 * repository never borrows a parent's off. An off found there wins; no override, or a `.git` that cannot be followed
 * ("unlocatable": never assumed off), leaves the decision to the GLOBAL switch. "none": no repository (no `.git`
 * above), or a bare repository.
 *
 * Accepted (ADVISORY-1): a `.git` FILE that is not tracked is trusted like any other. Only someone who can already
 * write the repository's own override can create one, and git refuses to track a `.git` entry, so it cannot arrive by
 * checkout or merge.
 */
function locateCommonDir(cwd, opts) {
    try {
        return { kind: "found", commonDir: resolveRepository(cwd, gitBound(opts)).commonDir };
    }
    catch (err) {
        if (!(err instanceof SnapshotError))
            throw err;
        if (err.code === "bare_repository" || err.code === "invalid_target")
            return { kind: "none" };
    }
    let dir;
    try {
        dir = realpathSync(resolve(cwd));
    }
    catch {
        return { kind: "none" };
    }
    for (;;) {
        const dotGit = join(dir, ".git");
        let st;
        try {
            st = lstatSync(dotGit);
        }
        catch (err) {
            if (err.code !== "ENOENT")
                return { kind: "unlocatable" };
        }
        if (st !== undefined) {
            if (st.isDirectory())
                return { kind: "found", commonDir: dotGit };
            if (st.isSymbolicLink()) {
                try {
                    const real = realpathSync(dotGit);
                    return isDir(real) ? { kind: "found", commonDir: real } : { kind: "unlocatable" };
                }
                catch {
                    return { kind: "unlocatable" };
                }
            }
            const common = st.isFile() ? commonDirOfGitFile(dotGit) : undefined;
            return common !== undefined ? { kind: "found", commonDir: common } : { kind: "unlocatable" };
        }
        const up = dirname(dir);
        if (up === dir)
            return { kind: "none" };
        dir = up;
    }
}
function resolveStatus(global, clone, problems) {
    const base = { global, cloneLocal: clone, problems };
    if (clone === "off" || clone === "unreadable")
        return { ...base, effective: "off", source: "clone-local" };
    if (global === "on")
        return { ...base, effective: "on", source: "global" };
    if (global === "off")
        return { ...base, effective: "off", source: "global" };
    return { ...base, effective: "off", source: "default" };
}
/** Effective mode. Read-only; never throws for a missing repository or data dir (both resolve to off). */
export function readReviewMode(cwd, opts = {}) {
    const problems = [];
    const global = readGlobal(opts);
    let clone = "n/a";
    if (cwd !== undefined) {
        const located = locateCommonDir(cwd, opts);
        if (located.kind === "found")
            clone = readClone(located.commonDir, problems);
        else if (located.kind === "unlocatable") {
            problems.push("git failed resolving the repository and its clone-local review mode could not be located; the global switch decides");
        }
    }
    return resolveStatus(global, clone, problems);
}
/**
 * enable|disable for one scope. global: writes on|off in plugin state (needs a data dir). clone: `disable` writes the
 * off-only override, `enable` clears it (the global switch then decides). Returns the resulting status.
 */
export function setReviewMode(operation, scope, cwd, opts = {}) {
    if (scope === "global") {
        try {
            writePluginState(MODE_STATE_NAME, { mode: operation === "enable" ? "on" : "off" }, opts);
        }
        catch (err) {
            throw new ReviewModeError(`cannot write the global review mode: ${err instanceof Error ? err.message : String(err)}`);
        }
        return readReviewMode(cwd, opts);
    }
    if (cwd === undefined)
        throw new ReviewModeError("clone scope needs a repository (--cwd)");
    const commonDir = resolveCommonDir(cwd, opts);
    if (commonDir === undefined)
        throw new ReviewModeError(`clone scope needs a git repository: ${cwd} is not inside one`);
    const path = cloneModePath(commonDir);
    const dir = join(commonDir, "odd-plugin");
    try {
        if (operation === "disable") {
            if (pluginDirKind(commonDir) === "absent")
                mkdirSync(dir, { mode: 0o700, recursive: true });
            if (pluginDirKind(commonDir) !== "dir")
                throw new Error(`not a real directory: ${dir}`);
            atomicWriteFile(path, JSON.stringify({ schema: CLONE_MODE_SCHEMA, mode: "off" }) + "\n", 0o600);
        }
        else {
            const kind = pluginDirKind(commonDir);
            if (kind === "bad")
                throw new Error(`not a real directory: ${dir}`);
            if (kind === "dir") {
                let st;
                try {
                    st = lstatSync(path);
                }
                catch (err) {
                    if (err.code === "ENOENT")
                        st = undefined;
                    else
                        throw err;
                }
                if (st !== undefined) {
                    if (!st.isFile())
                        throw new Error(`not a regular file: ${path}`);
                    unlinkSync(path);
                }
            }
        }
    }
    catch (err) {
        throw new ReviewModeError(`cannot write the clone-local review mode: ${err instanceof Error ? err.message : String(err)}`);
    }
    return readReviewMode(cwd, opts);
}
