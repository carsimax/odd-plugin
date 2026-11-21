import { listLineages, readState } from "./store.js";
/** Existing lineage for this exact candidate: a live one wins, else a burned one. Corrupt lineages are skipped. */
export function findLineage(commonDir, targetIdentity, projection, options = {}) {
    const found = {};
    for (const id of listLineages(commonDir, options).lineages) {
        let rec;
        try {
            rec = readState(commonDir, id);
        }
        catch {
            continue;
        }
        if (rec.target_identity !== targetIdentity || rec.projection !== projection)
            continue;
        if (rec.burned)
            found.burned ??= rec;
        else
            found.live ??= rec;
    }
    return found;
}
/** Selected lenses that have no admitted lens result yet. */
export const lensesPending = (r) => r.selected_lenses.filter((l) => !r.admitted_role_results.some((e) => e.role === "lens" && e.lens === l));
/** Whether a result for this role has been admitted. */
export const hasRole = (r, role) => r.admitted_role_results.some((e) => e.role === role);
