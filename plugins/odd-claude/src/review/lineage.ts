/**
 * Shared read-only helpers over lineage records, used by start, status and capture.
 * One home so the three callers cannot drift apart.
 */
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import type { Projection, StateRecord } from "./state.js";
import { listLineages, readState, storeRootFor } from "./store.js";

const MAX_RAW_STATE_BYTES = 1 << 20;

/**
 * Secure bounded read of a state file for the lenient pending-correction look. Returns the record; undefined for a content
 * problem that upstream skips (absent, oversized regular file, not JSON, not an object); "unsafe" for a symlink, FIFO,
 * directory, hardlink, open error or read error (the lineage is corrupt or unreadable: fail closed).
 */
export function readRawState(path: string): Record<string, unknown> | undefined | "unsafe" {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? undefined : "unsafe";
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink > 1) return "unsafe";
    if (st.size > MAX_RAW_STATE_BYTES) return undefined;
    const buf = Buffer.alloc(st.size);
    let got = 0;
    while (got < buf.length) {
      let n: number;
      try {
        n = readSync(fd, buf, got, buf.length - got, null);
      } catch {
        return "unsafe";
      }
      if (n === 0) break;
      got += n;
    }
    try {
      const parsed: unknown = JSON.parse(buf.subarray(0, got).toString("utf8"));
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  } catch {
    return "unsafe";
  } finally {
    closeSync(fd);
  }
}

/** Whether the raw record of an unreadable lineage claims this exact candidate (an unsafe file names no candidate; `runReview` fails closed on it). */
function rawTargetMatches(commonDir: string, id: string, targetIdentity: string, projection: Projection): boolean {
  const raw = readRawState(join(storeRootFor(commonDir), id, "review-state.json"));
  return raw !== undefined && raw !== "unsafe" && raw.target_identity === targetIdentity && raw.projection === projection;
}

/** Existing lineage for this exact candidate: a live one wins, else a burned one. An unreadable lineage whose raw record claims this candidate is reported as `unreadable` (fail closed). */
export function findLineage(
  commonDir: string,
  targetIdentity: string,
  projection: Projection,
  options: { limit?: number; maxScan?: number } = {},
): { live?: StateRecord; burned?: StateRecord; unreadable?: string } {
  const found: { live?: StateRecord; burned?: StateRecord; unreadable?: string } = {};
  for (const id of listLineages(commonDir, options).lineages) {
    let rec: StateRecord;
    try {
      rec = readState(commonDir, id);
    } catch {
      if (rawTargetMatches(commonDir, id, targetIdentity, projection)) found.unreadable ??= id;
      continue;
    }
    if (rec.target_identity !== targetIdentity || rec.projection !== projection) continue;
    if (rec.burned) found.burned ??= rec;
    else found.live ??= rec;
  }
  return found;
}

/** Selected lenses that have no admitted lens result yet. */
export const lensesPending = (r: StateRecord): string[] =>
  r.selected_lenses.filter((l) => !r.admitted_role_results.some((e) => e.role === "lens" && e.lens === l));

/** Whether a result for this role has been admitted. */
export const hasRole = (r: StateRecord, role: "lens" | "refuter" | "validator"): boolean => r.admitted_role_results.some((e) => e.role === role);
