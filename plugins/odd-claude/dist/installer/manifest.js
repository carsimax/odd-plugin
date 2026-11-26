// Ownership ledger: which files under the Claude dir this installer wrote, with the hash it wrote.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
export const MANIFEST_VERSION = 1;
export function sha256(data) {
    return createHash("sha256").update(data).digest("hex");
}
export function atomicWriteFile(path, data, mode = 0o644) {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
    try {
        writeFileSync(tmp, data, { mode });
        chmodSync(tmp, mode);
        renameSync(tmp, path);
    }
    catch (e) {
        rmSync(tmp, { force: true });
        throw e;
    }
}
/** Null when absent. A present but unreadable ledger throws: guessing could overwrite or delete user files. */
export function readManifest(path) {
    if (!existsSync(path))
        return null;
    let raw;
    try {
        raw = JSON.parse(readFileSync(path, "utf8"));
    }
    catch {
        throw new Error(`manifest ${path} is not valid JSON; fix or remove it before continuing`);
    }
    const m = raw;
    if (typeof m !== "object" || m === null || m.version !== MANIFEST_VERSION || typeof m.files !== "object" || m.files === null) {
        throw new Error(`manifest ${path} has an unsupported shape; fix or remove it before continuing`);
    }
    return m;
}
export function writeManifest(path, manifest) {
    atomicWriteFile(path, JSON.stringify(manifest, null, 2) + "\n", 0o644);
}
