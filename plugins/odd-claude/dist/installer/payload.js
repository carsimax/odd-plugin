// Release payload staging: versions/<v> is built beside the target and renamed in; `current` is swapped atomically.
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import { basename, dirname, join, posix, sep } from "node:path";
import { sha256 } from "./manifest.js";
import { resolvePlaceholders } from "./placeholders.js";
/** What a release carries, relative to the source root. */
export const PAYLOAD_ITEMS = ["dist", "agents", "workflows", "skills", "claude-md", "rules", "output-styles", "support", "hooks", "statusline", "package.json"];
/** Payload dirs whose text is read straight from `current` by the model, so placeholders are resolved when staging. */
const RESOLVED_AT_STAGE = new Set(["support"]);
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z._+-]*$/;
export function assertVersion(version) {
    if (!VERSION_RE.test(version) || version.includes(".."))
        throw new Error(`invalid version ${JSON.stringify(version)}`);
}
/** Regular files under `dir` (symlinks and specials skipped), keyed by posix path relative to `base`. */
export function readTree(dir, base = dir, out = new Map()) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
        const abs = join(dir, e.name);
        if (e.isDirectory())
            readTree(abs, base, out);
        else if (e.isFile())
            out.set(posix.join(...abs.slice(base.length + 1).split(sep)), { data: readFileSync(abs), mode: statSync(abs).mode & 0o777 });
    }
    return out;
}
/** The files a stage would write for `sourceRoot`, with staging-time placeholders already resolved. */
export function collectPayload(sourceRoot, paths) {
    const tree = new Map();
    for (const item of PAYLOAD_ITEMS) {
        const abs = join(sourceRoot, item);
        if (!existsSync(abs))
            continue;
        if (statSync(abs).isDirectory()) {
            for (const [rel, f] of readTree(abs))
                tree.set(`${item}/${rel}`, f);
        }
        else {
            tree.set(item, { data: readFileSync(abs), mode: statSync(abs).mode & 0o777 });
        }
    }
    if (tree.size === 0)
        throw new Error(`no payload found under ${sourceRoot}`);
    for (const [rel, f] of tree) {
        if (RESOLVED_AT_STAGE.has(rel.split("/")[0]) && rel.endsWith(".md")) {
            tree.set(rel, { ...f, data: Buffer.from(resolvePlaceholders(f.data.toString("utf8"), { root: paths.currentLink, data: paths.dataDir })) });
        }
    }
    return tree;
}
export function sameTree(a, b) {
    if (a.size !== b.size)
        return false;
    for (const [rel, f] of a) {
        const o = b.get(rel);
        if (!o || sha256(o.data) !== sha256(f.data))
            return false;
    }
    return true;
}
function tmpName(dir, label) {
    return join(dir, `.${label}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`);
}
/** True when staging `version` from `sourceRoot` would write something (absent or different content). */
export function payloadWouldChange(sourceRoot, paths, version) {
    assertVersion(version);
    const dir = join(paths.versionsDir, version);
    return !existsSync(dir) || !sameTree(collectPayload(sourceRoot, paths), readTree(dir));
}
/** Atomically points `current` at versions/<version> (relative link, temp symlink + rename). */
export function switchCurrent(paths, version) {
    assertVersion(version);
    if (!existsSync(join(paths.versionsDir, version)))
        throw new Error(`version ${version} is not staged`);
    if (existsSync(paths.currentLink) && !lstatSync(paths.currentLink).isSymbolicLink())
        throw new Error(`${paths.currentLink} exists and is not a symlink`);
    const tmp = tmpName(paths.oddHome, "current");
    symlinkSync(join("versions", version), tmp);
    try {
        renameSync(tmp, paths.currentLink);
    }
    catch (e) {
        rmSync(tmp, { force: true });
        throw e;
    }
}
/** Stages the payload as versions/<version> (idempotent) and makes it current. Older versions are kept. */
export function stagePayload(sourceRoot, paths, version) {
    assertVersion(version);
    const tree = collectPayload(sourceRoot, paths);
    const versionDir = join(paths.versionsDir, version);
    const changed = !existsSync(versionDir) || !sameTree(tree, readTree(versionDir));
    if (changed) {
        mkdirSync(paths.versionsDir, { recursive: true });
        const tmp = tmpName(paths.versionsDir, version);
        try {
            for (const [rel, f] of tree) {
                const dest = join(tmp, ...rel.split("/"));
                mkdirSync(dirname(dest), { recursive: true });
                writeFileSync(dest, f.data, { mode: f.mode || 0o644 });
                chmodSync(dest, f.mode || 0o644);
            }
            if (existsSync(versionDir)) {
                const old = tmpName(paths.versionsDir, `${version}-old`);
                renameSync(versionDir, old);
                renameSync(tmp, versionDir);
                rmSync(old, { recursive: true, force: true });
            }
            else {
                renameSync(tmp, versionDir);
            }
        }
        finally {
            rmSync(tmp, { recursive: true, force: true });
        }
    }
    switchCurrent(paths, version);
    return { versionDir, changed };
}
function versionParts(v) {
    return v.split(/[.+-]/).map((p) => (/^\d+$/.test(p) ? Number(p) : p));
}
/** Staged versions, oldest first (numeric-aware). */
export function listVersions(paths) {
    if (!existsSync(paths.versionsDir))
        return [];
    return readdirSync(paths.versionsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith("."))
        .map((e) => e.name)
        .sort((a, b) => {
        const pa = versionParts(a);
        const pb = versionParts(b);
        for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
            const x = pa[i];
            const y = pb[i];
            if (x === y)
                continue;
            if (x === undefined)
                return -1;
            if (y === undefined)
                return 1;
            if (typeof x === "number" && typeof y === "number")
                return x - y;
            return String(x).localeCompare(String(y));
        }
        return 0;
    });
}
/** Version `current` points at, or null when there is no (valid) link. */
export function activeVersion(paths) {
    try {
        if (!lstatSync(paths.currentLink).isSymbolicLink())
            return null;
        const v = basename(readlinkSync(paths.currentLink));
        return existsSync(join(paths.versionsDir, v)) ? v : null;
    }
    catch {
        return null;
    }
}
