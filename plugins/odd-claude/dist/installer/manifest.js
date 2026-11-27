// Ownership ledger: which files under the Claude dir this installer wrote, with the hash it wrote.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { atomicWriteFile } from "../lib/state.js";
export const MANIFEST_VERSION = 1;
export function sha256(data) {
    return createHash("sha256").update(data).digest("hex");
}
// Re-exported so installer modules keep importing it from here.
export { atomicWriteFile };
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
    if (typeof m !== "object" || m === null || m.version !== MANIFEST_VERSION || typeof m.files !== "object" || m.files === null || (m.blocks !== undefined && (typeof m.blocks !== "object" || m.blocks === null))) {
        throw new Error(`manifest ${path} has an unsupported shape; fix or remove it before continuing`);
    }
    return m;
}
export function writeManifest(path, manifest) {
    atomicWriteFile(path, JSON.stringify(manifest, null, 2) + "\n", 0o644);
}
