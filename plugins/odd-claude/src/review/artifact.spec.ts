import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ARTIFACT_SUBJECT_SCHEMA,
  artifactSubjectFor,
  artifactSubjectProblems,
  findingPath,
  lensArtifactSubject,
  manifestFor,
  refuterRequestHash,
  targetedValidationRequestHash,
  treeDiffPaths,
} from "./artifact.js";
import { domainHash } from "./canonical.js";
import { digestPaths, freezeSnapshot } from "./snapshot.js";
import { admitLensResult, beginValidation, requireCorrection, start, type Finding, type StateRecord } from "./state.js";

const T0 = "2026-11-19T10:00:00.000Z";
const hex = (c: string, n = 64) => c.repeat(n).slice(0, n);
const sha = (c: string) => `sha256:${hex(c)}`;

function record(over: Partial<Parameters<typeof start>[0]> = {}): StateRecord {
  const r = start({
    lineageId: `review-${hex("a", 16)}`,
    targetIdentity: sha("1"),
    projection: "workspace",
    baseTree: hex("b", 40),
    candidateTree: hex("c", 40),
    riskLevel: "high",
    selectedLenses: ["risk", "reliability"],
    originalChangedLines: 8,
    now: T0,
    ...over,
  });
  if (!r.ok) throw new Error(r.refusal.message);
  return r.record;
}

test("artifactSubjectFor binds lineage, target, trees, manifest digest, lens and slot order (and not the state revision)", () => {
  const rec = record();
  const subject = artifactSubjectFor(rec, "reliability", sha("9"))!;
  assert.equal(subject.schema, ARTIFACT_SUBJECT_SCHEMA);
  assert.equal(ARTIFACT_SUBJECT_SCHEMA, "odd-claude.review-artifact-subject/v2");
  assert.equal(subject.selected_order, 1);
  assert.equal(subject.role, "lens");
  const { subject_hash, ...preimage } = subject;
  assert.equal(subject_hash, domainHash("review-artifact-subject", 2, preimage));
  assert.deepEqual(preimage, {
    schema: ARTIFACT_SUBJECT_SCHEMA,
    lineage_id: rec.lineage_id,
    target_identity: rec.target_identity,
    base_tree: rec.base_tree,
    candidate_tree: rec.candidate_tree,
    changed_path_manifest_sha256: sha("9"),
    role: "lens",
    lens: "reliability",
    selected_order: 1,
  });
  // admitting a sibling lens moves the revision but never the subject
  const moved = admitLensResult(rec, { lens: "risk", findings: [], resultHash: sha("2"), now: T0 });
  assert.equal(moved.ok, true);
  if (moved.ok) {
    assert.notEqual(moved.record.revision, rec.revision);
    assert.equal(artifactSubjectFor(moved.record, "reliability", sha("9"))!.subject_hash, subject_hash);
  }
  assert.deepEqual(artifactSubjectProblems(subject), []);
});

test("artifactSubjectFor differs per lens, target, tree and manifest; unselected lens has no subject", () => {
  const rec = record();
  const base = artifactSubjectFor(rec, "risk", sha("9"))!.subject_hash;
  assert.notEqual(artifactSubjectFor(rec, "reliability", sha("9"))!.subject_hash, base);
  assert.notEqual(artifactSubjectFor(rec, "risk", sha("8"))!.subject_hash, base);
  assert.notEqual(artifactSubjectFor(record({ candidateTree: hex("d", 40) }), "risk", sha("9"))!.subject_hash, base);
  assert.notEqual(artifactSubjectFor(record({ baseTree: hex("d", 40) }), "risk", sha("9"))!.subject_hash, base);
  assert.notEqual(artifactSubjectFor(record({ targetIdentity: sha("2") }), "risk", sha("9"))!.subject_hash, base);
  assert.notEqual(artifactSubjectFor(record({ lineageId: `review-${hex("e", 16)}` }), "risk", sha("9"))!.subject_hash, base);
  assert.equal(artifactSubjectFor(rec, "readability", sha("9")), null);
  assert.equal(artifactSubjectFor(rec, "nope", sha("9")), null);
});

test("artifactSubjectProblems rejects tampering, unknown and missing fields", () => {
  const subject = artifactSubjectFor(record(), "risk", sha("9"))!;
  assert.notDeepEqual(artifactSubjectProblems({ ...subject, lens: "reliability" }), []);
  assert.notDeepEqual(artifactSubjectProblems({ ...subject, selected_order: 3 }), []);
  assert.notDeepEqual(artifactSubjectProblems({ ...subject, extra: 1 }), []);
  assert.notDeepEqual(artifactSubjectProblems({ ...subject, subject_hash: sha("0") }), []);
  const { lens: _lens, ...missing } = subject;
  void _lens;
  assert.notDeepEqual(artifactSubjectProblems(missing), []);
  assert.notDeepEqual(artifactSubjectProblems(null), []);
  assert.notDeepEqual(artifactSubjectProblems("x"), []);
});

test("request hashes: refuter binds the blocking findings; validator needs a validating record with a target", () => {
  const rec = record({ riskLevel: "medium", selectedLenses: ["reliability"] });
  const finding: Finding = { id: "R3-1", lens: "reliability", severity: "CRITICAL", location: "a.txt:1", claim: "boom" };
  const reviewed = admitLensResult(rec, { lens: "reliability", findings: [finding], resultHash: sha("2"), now: T0 });
  assert.equal(reviewed.ok, true);
  if (!reviewed.ok) return;
  const h = refuterRequestHash(reviewed.record);
  assert.match(h, /^sha256:[0-9a-f]{64}$/);
  const other = admitLensResult(rec, { lens: "reliability", findings: [{ ...finding, claim: "different" }], resultHash: sha("2"), now: T0 });
  assert.equal(other.ok && refuterRequestHash(other.record) !== h, true);

  assert.equal(targetedValidationRequestHash(reviewed.record), null);
  const corr = requireCorrection(reviewed.record, { fixFindingIds: ["R3-1"], now: T0 });
  assert.equal(corr.ok, true);
  if (!corr.ok) return;
  assert.equal(targetedValidationRequestHash(corr.record), null);
  const noTarget = beginValidation(corr.record, { actualCorrectionLines: 1, now: T0 });
  assert.equal(noTarget.ok && targetedValidationRequestHash(noTarget.record), null);
  const a = beginValidation(corr.record, { actualCorrectionLines: 1, correctionTargetIdentity: sha("4"), now: T0 });
  const b = beginValidation(corr.record, { actualCorrectionLines: 1, correctionTargetIdentity: sha("5"), now: T0 });
  assert.equal(a.ok && b.ok, true);
  if (a.ok && b.ok) {
    assert.match(targetedValidationRequestHash(a.record)!, /^sha256:[0-9a-f]{64}$/);
    assert.notEqual(targetedValidationRequestHash(a.record), targetedValidationRequestHash(b.record));
  }
});

test("findingPath extracts the path of path:line and path:start-end", () => {
  assert.equal(findingPath("src/a.ts:12"), "src/a.ts");
  assert.equal(findingPath("src/a.ts:12-20"), "src/a.ts");
  assert.equal(findingPath("dir/with:colon.ts:3"), "dir/with:colon.ts");
  assert.equal(findingPath("a.ts"), null);
  assert.equal(findingPath("a.ts:0"), null);
});

// ---- real trees ----

function git(cwd: string, ...args: string[]): string {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.toUpperCase().startsWith("GIT_")) env[k] = v;
  env.GIT_CONFIG_NOSYSTEM = "1";
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.invalid", "-c", "commit.gpgsign=false", "-C", cwd, ...args], { env, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

test("treeDiffPaths and manifestFor reproduce the frozen snapshot's paths and digest from the trees alone", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "odd-artifact-")));
  try {
    const repo = join(dir, "repo");
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "a.txt"), "one\n");
    writeFileSync(join(repo, "b.txt"), "bee\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "init");
    writeFileSync(join(repo, "b.txt"), "bee\nmore\n");
    writeFileSync(join(repo, "a.txt"), "uno\n");
    mkdirSync(join(repo, "d"));
    writeFileSync(join(repo, "d", "é.txt"), "x\n");
    git(repo, "add", "-A");
    const frozen = freezeSnapshot(repo, { kind: "current-changes", projection: "staged" });
    assert.equal(frozen.status, "frozen");
    if (frozen.status !== "frozen") return;
    const { snapshot, repository } = frozen;
    assert.deepEqual(treeDiffPaths(repository.commonDir, snapshot.baseTree, snapshot.candidateTree), snapshot.paths);
    const rec = record({
      riskLevel: "medium",
      selectedLenses: ["risk"],
      baseTree: snapshot.baseTree,
      candidateTree: snapshot.candidateTree,
      targetIdentity: snapshot.identity,
      projection: "staged",
    });
    const manifest = manifestFor(repository.commonDir, rec);
    assert.deepEqual(manifest.paths, snapshot.paths);
    assert.equal(manifest.digest, snapshot.pathsDigest);
    assert.equal(manifest.digest, digestPaths(snapshot.paths));
    const subject = lensArtifactSubject(repository.commonDir, rec, "risk")!;
    assert.equal(subject.changed_path_manifest_sha256, snapshot.pathsDigest);
    assert.equal(lensArtifactSubject(repository.commonDir, rec, "reliability"), null);
    assert.throws(() => treeDiffPaths(repository.commonDir, "nothex", snapshot.candidateTree), RangeError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
