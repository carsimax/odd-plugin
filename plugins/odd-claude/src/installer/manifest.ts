// Ownership ledger: which files under the Claude dir this installer wrote, with the hash it wrote.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { atomicWriteFile } from "../lib/state.js";
import type { ModelSelection } from "./models.js";

export const MANIFEST_VERSION = 1;

export interface Manifest {
  version: 1;
  oddVersion: string;
  installedAt: string;
  /** Path relative to the Claude dir (posix separators) -> sha256 hex of the installed content. */
  files: Record<string, string>;
  /** CLAUDE.md block id -> sha256 hex of the normalized inner text we wrote. Absent in manifests from before managed blocks. */
  blocks?: Record<string, string>;
  models: ModelSelection;
}

export function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

// Re-exported so installer modules keep importing it from here.
export { atomicWriteFile };

/** Null when absent. A present but unreadable ledger throws: guessing could overwrite or delete user files. */
export function readManifest(path: string): Manifest | null {
  if (!existsSync(path)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`manifest ${path} is not valid JSON; fix or remove it before continuing`);
  }
  const m = raw as Partial<Manifest> | null;
  if (typeof m !== "object" || m === null || m.version !== MANIFEST_VERSION || typeof m.files !== "object" || m.files === null || (m.blocks !== undefined && (typeof m.blocks !== "object" || m.blocks === null))) {
    throw new Error(`manifest ${path} has an unsupported shape; fix or remove it before continuing`);
  }
  return m as Manifest;
}

export function writeManifest(path: string, manifest: Manifest): void {
  atomicWriteFile(path, JSON.stringify(manifest, null, 2) + "\n", 0o644);
}
