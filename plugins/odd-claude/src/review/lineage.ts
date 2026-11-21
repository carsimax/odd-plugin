/**
 * Shared read-only helpers over lineage records, used by start, status and capture.
 * One home so the three callers cannot drift apart.
 */
import type { Projection, StateRecord } from "./state.js";
import { listLineages, readState } from "./store.js";

/** Existing lineage for this exact candidate: a live one wins, else a burned one. Corrupt lineages are skipped. */
export function findLineage(
  commonDir: string,
  targetIdentity: string,
  projection: Projection,
  options: { limit?: number; maxScan?: number } = {},
): { live?: StateRecord; burned?: StateRecord } {
  const found: { live?: StateRecord; burned?: StateRecord } = {};
  for (const id of listLineages(commonDir, options).lineages) {
    let rec: StateRecord;
    try {
      rec = readState(commonDir, id);
    } catch {
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
