// Per-session scratch dir (R56): <data>/scratch/<session>, created at SessionStart and removed at SessionEnd.
// Port of the minimal safe subset of the upstream session scratch: it keeps the "own dir per session, remove
// only what we own" rule and refuses anything that is not a plain directory at exactly that path. The upstream
// artifact ledger (recorded clones/worktrees, crashed-session sweep) is not ported: nothing here records or
// deletes anything outside <data>/scratch/<session>.
import { lstatSync, mkdirSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { resolveDataDir, safeSegment } from "./state.js";
export function scratchRoot(opts = {}) {
    return join(resolveDataDir(opts), "scratch");
}
export function scratchDir(sessionId, opts = {}) {
    return join(scratchRoot(opts), safeSegment(sessionId));
}
function lstatOrUndefined(p) {
    try {
        return lstatSync(p);
    }
    catch (err) {
        if (err.code === "ENOENT")
            return undefined;
        throw err;
    }
}
/** Creates the scratch (0700, idempotent). Throws when the root or the dir is a symlink or not a directory. */
export function createSessionScratch(sessionId, opts = {}) {
    const root = scratchRoot(opts);
    const dir = scratchDir(sessionId, opts);
    mkdirSync(dirname(root), { recursive: true });
    for (const [p, mode] of [[root, 0o700], [dir, 0o700]]) {
        const st = lstatOrUndefined(p);
        if (st === undefined)
            mkdirSync(p, { mode });
        else if (st.isSymbolicLink() || !st.isDirectory())
            throw new Error(`unsafe scratch path: ${p}`);
    }
    return dir;
}
/** Removes only <data>/scratch/<session>; refuses a symlinked root/dir or a path that resolves elsewhere. Never follows links. */
export function removeSessionScratch(sessionId, opts = {}) {
    const root = scratchRoot(opts);
    const dir = scratchDir(sessionId, opts);
    const rootStat = lstatOrUndefined(root);
    if (rootStat === undefined)
        return "absent";
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory())
        return "refused";
    const st = lstatOrUndefined(dir);
    if (st === undefined)
        return "absent";
    if (st.isSymbolicLink() || !st.isDirectory())
        return "refused";
    if (realpathSync(dir) !== join(realpathSync(root), basename(dir)))
        return "refused";
    // rmSync unlinks symlinks inside the tree instead of following them.
    rmSync(dir, { recursive: true, force: true });
    return "removed";
}
function sizeOf(dir) {
    let total = 0;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory())
            total += sizeOf(p);
        else if (e.isFile())
            total += lstatSync(p).size;
    }
    return total;
}
/** Read-only listing of the top-level entries and the total size of regular files. */
export function listScratch(dir) {
    try {
        const st = lstatSync(dir);
        if (st.isSymbolicLink() || !st.isDirectory())
            return { exists: false, entries: [], bytes: 0 };
        const entries = readdirSync(dir, { withFileTypes: true })
            .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
            .sort();
        return { exists: true, entries, bytes: sizeOf(dir) };
    }
    catch {
        return { exists: false, entries: [], bytes: 0 };
    }
}
