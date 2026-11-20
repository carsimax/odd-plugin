// Artifact subjects and request bindings (U6): the identities a reviewer result must echo.
//
// A lens subject binds ONE reviewer slot to the frozen candidate: lineage, target identity, the immutable base and
// candidate trees, the digest of the changed-path manifest recomputed from those trees, the lens and its slot order.
// The volatile state revision is deliberately NOT part of the subject: lens results are captured concurrently and each
// admission moves the revision, so a revision-bound subject would invalidate every sibling. Immutability comes from the
// trees; ordering and exactly-once admission come from the store CAS.
//
// Refuter and targeted-validator results bind to a request hash derived from the record instead of a subject.
import { domainHash } from "./canonical.js";
import { DEFAULT_GIT_TIMEOUT_MS, INVENTORY_LIMIT, decodeName, digestPaths, normalizeLogicalPath, nulRecords, runGit } from "./snapshot.js";
import { LENSES, blockingFindingIds } from "./state.js";
export const ARTIFACT_SUBJECT_SCHEMA = "odd-claude.review-artifact-subject/v2";
const SHA_RE = /^sha256:[0-9a-f]{64}$/;
const TREE_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const LINEAGE_RE = /^review-[0-9a-f]{16}$/;
const compareBytes = (a, b) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
/** Sorted, unique, canonical paths that differ between two immutable trees (same inventory the snapshot freezes). */
export function treeDiffPaths(commonDir, fromTree, toTree, timeoutMs = DEFAULT_GIT_TIMEOUT_MS) {
    if (!TREE_RE.test(fromTree) || !TREE_RE.test(toTree))
        throw new RangeError("tree ids must be full hexadecimal object ids");
    const out = runGit({
        cwd: commonDir,
        args: ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", "--no-renames", "--ignore-submodules=none", fromTree, toTree],
        timeoutMs,
        limit: INVENTORY_LIMIT,
    }).stdout;
    return nulRecords(out)
        .map((record) => normalizeLogicalPath(decodeName(record, "changed path")))
        .sort(compareBytes);
}
const subjectHashOf = (preimage) => domainHash("review-artifact-subject", 2, preimage);
/** The subject a reviewer of `lens` must echo for this lineage; null when the lens is not selected. */
export function artifactSubjectFor(record, lens, pathsDigest) {
    const order = record.selected_lenses.indexOf(lens);
    if (order < 0 || !LENSES.includes(lens))
        return null;
    const preimage = {
        schema: ARTIFACT_SUBJECT_SCHEMA,
        lineage_id: record.lineage_id,
        target_identity: record.target_identity,
        base_tree: record.base_tree,
        candidate_tree: record.candidate_tree,
        changed_path_manifest_sha256: pathsDigest,
        role: "lens",
        lens,
        selected_order: order,
    };
    return { ...preimage, subject_hash: subjectHashOf(preimage) };
}
/** Recomputes the changed-path manifest digest from the record's frozen trees. */
export function manifestFor(commonDir, record) {
    const paths = treeDiffPaths(commonDir, record.base_tree, record.candidate_tree);
    return { paths, digest: digestPaths(paths) };
}
/** Subject for one selected lens, derived from the frozen trees (never from the working directory). */
export function lensArtifactSubject(commonDir, record, lens) {
    return artifactSubjectFor(record, lens, manifestFor(commonDir, record).digest);
}
/** Self-consistency problems of a presented subject; empty when its shape and self-hash are sound. */
export function artifactSubjectProblems(subject) {
    const s = subject;
    if (typeof s !== "object" || s === null || Array.isArray(s))
        return ["artifact subject must be an object"];
    const problems = [];
    const allowed = ["schema", "subject_hash", "lineage_id", "target_identity", "base_tree", "candidate_tree", "changed_path_manifest_sha256", "role", "lens", "selected_order"];
    for (const k of Object.keys(s))
        if (!allowed.includes(k))
            problems.push(`unknown field ${k}`);
    for (const k of allowed)
        if (!(k in s))
            problems.push(`missing field ${k}`);
    if (problems.length > 0)
        return problems;
    if (s.schema !== ARTIFACT_SUBJECT_SCHEMA)
        problems.push(`schema must be ${ARTIFACT_SUBJECT_SCHEMA}`);
    if (typeof s.lineage_id !== "string" || !LINEAGE_RE.test(s.lineage_id))
        problems.push("lineage_id is invalid");
    for (const k of ["subject_hash", "target_identity", "changed_path_manifest_sha256"]) {
        if (typeof s[k] !== "string" || !SHA_RE.test(s[k]))
            problems.push(`${k} must be sha256:<64 hex>`);
    }
    for (const k of ["base_tree", "candidate_tree"])
        if (typeof s[k] !== "string" || !TREE_RE.test(s[k]))
            problems.push(`${k} must be a tree id`);
    if (s.role !== "lens")
        problems.push("role must be lens");
    if (typeof s.lens !== "string" || !LENSES.includes(s.lens))
        problems.push("lens is unknown");
    if (typeof s.selected_order !== "number" || !Number.isSafeInteger(s.selected_order) || s.selected_order < 0)
        problems.push("selected_order is invalid");
    if (problems.length > 0)
        return problems;
    const { subject_hash: claimed, ...preimage } = s;
    if (subjectHashOf(preimage) !== claimed)
        problems.push("subject_hash does not match its binding");
    return problems;
}
const refuterView = (f) => ({ id: f.id, lens: f.lens, severity: f.severity, location: f.location, claim: f.claim });
/** The batch a refuter answers: the blocking severe findings of the fully reviewed candidate. */
export function refuterRequestHash(record) {
    const ids = new Set(blockingFindingIds({ ...record, refuted_finding_ids: undefined }));
    return domainHash("refuter-request", 1, {
        lineage_id: record.lineage_id,
        target_identity: record.target_identity,
        base_tree: record.base_tree,
        candidate_tree: record.candidate_tree,
        findings: record.findings.filter((f) => ids.has(f.id)).map(refuterView).sort((a, b) => compareBytes(a.id, b.id)),
    });
}
/** The correction a targeted validator judges: frozen ledger, fix ids and the corrected candidate identity. */
export function targetedValidationRequestHash(record) {
    if (record.state !== "validating" || record.correction_target_identity === undefined || record.ledger_hash === undefined)
        return null;
    return domainHash("targeted-validation-request", 1, {
        lineage_id: record.lineage_id,
        target_identity: record.target_identity,
        ledger_hash: record.ledger_hash,
        fix_finding_ids: record.fix_finding_ids,
        correction_target_identity: record.correction_target_identity,
        actual_correction_lines: record.actual_correction_lines ?? 0,
    });
}
/** Repository path of a finding location ("path:line" or "path:start-end"); null when malformed. */
export function findingPath(location) {
    const m = /^(.+):[1-9][0-9]*(?:-[1-9][0-9]*)?$/.exec(location);
    return m ? m[1] : null;
}
