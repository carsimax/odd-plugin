"""Artifact subjects and request bindings (port of v9 review/artifact.ts): the identities a reviewer result must echo.

A lens subject binds ONE reviewer slot to the frozen candidate (lineage, target identity, immutable base and candidate trees,
digest of the changed-path manifest recomputed from those trees, lens and slot order). The volatile state revision is NOT part
of it: lens results are captured concurrently and each admission moves the revision. Refuter and targeted-validator results bind
to a request hash derived from the record instead.
Records are plain dicts with v9 snake_case keys (see `state.py`); the returned subject is a dict with v9's keys.
Public API: `ARTIFACT_SUBJECT_SCHEMA`, `tree_diff_paths`, `artifact_subject_for`, `manifest_for`, `lens_artifact_subject`,
`artifact_subject_problems`, `refuter_request_hash`, `targeted_validation_request_hash`, `finding_path`.
"""
import math
import re
from typing import Any

from ..lib.js import js_keys
from .canonical import _js_string, domain_hash
from .snapshot import DEFAULT_GIT_TIMEOUT_MS, INVENTORY_LIMIT, decode_name, digest_paths, normalize_logical_path, nul_records, run_git
from .state import LENSES, RangeError, blocking_finding_ids

ARTIFACT_SUBJECT_SCHEMA = "odd-claude.review-artifact-subject/v2"

_SHA_RE = re.compile(r"sha256:[0-9a-f]{64}")
_TREE_RE = re.compile(r"(?:[0-9a-f]{40}|[0-9a-f]{64})")
_LINEAGE_RE = re.compile(r"review-[0-9a-f]{16}")
_FINDING_LOC_RE = re.compile(r"([^\n\r  ]+):[1-9][0-9]*(?:-[1-9][0-9]*)?")  # JS `.` excludes these four line terminators
_SUBJECT_KEYS = ["schema", "subject_hash", "lineage_id", "target_identity", "base_tree", "candidate_tree", "changed_path_manifest_sha256", "role", "lens", "selected_order"]


def _bytes(s: str) -> bytes:
    """`Buffer.from(s, "utf8")`: a lone surrogate becomes U+FFFD."""
    return s.encode("utf-16", "surrogatepass").decode("utf-16", "replace").encode("utf-8")


def _is_tree(v: Any) -> bool:
    return _TREE_RE.fullmatch(_js_string(v)) is not None  # RegExp.test coerces its argument to a string


def tree_diff_paths(common_dir: str, from_tree: str, to_tree: str, timeout_ms: float = DEFAULT_GIT_TIMEOUT_MS) -> list[str]:
    """Sorted (UTF-8 byte order), canonical paths that differ between two immutable trees (same inventory the snapshot freezes)."""
    if not _is_tree(from_tree) or not _is_tree(to_tree):
        raise RangeError("tree ids must be full hexadecimal object ids")
    out = run_git(common_dir, ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", "--no-renames", "--ignore-submodules=none", from_tree, to_tree], timeout_ms, limit=INVENTORY_LIMIT).stdout
    return sorted((normalize_logical_path(decode_name(r, "changed path")) for r in nul_records(out)), key=_bytes)


def _subject_hash_of(preimage: dict) -> str:
    return domain_hash("review-artifact-subject", 2, preimage)


def artifact_subject_for(record: dict, lens: str, paths_digest: str) -> dict | None:
    """The subject a reviewer of `lens` must echo for this lineage; None when the lens is not selected."""
    selected = record["selected_lenses"]
    if not isinstance(lens, str) or lens not in selected or lens not in LENSES:
        return None
    preimage = {
        "schema": ARTIFACT_SUBJECT_SCHEMA, "lineage_id": record["lineage_id"], "target_identity": record["target_identity"],
        "base_tree": record["base_tree"], "candidate_tree": record["candidate_tree"], "changed_path_manifest_sha256": paths_digest,
        "role": "lens", "lens": lens, "selected_order": selected.index(lens),
    }
    return {**preimage, "subject_hash": _subject_hash_of(preimage)}


def manifest_for(common_dir: str, record: dict) -> dict:
    """Recomputes the changed-path manifest digest from the record's frozen trees: `{"paths", "digest"}`."""
    paths = tree_diff_paths(common_dir, record["base_tree"], record["candidate_tree"])
    return {"paths": paths, "digest": digest_paths(paths)}


def lens_artifact_subject(common_dir: str, record: dict, lens: str) -> dict | None:
    """Subject for one selected lens, derived from the frozen trees (never from the working directory)."""
    return artifact_subject_for(record, lens, manifest_for(common_dir, record)["digest"])


def _safe_int(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) and float(v).is_integer() and abs(v) <= 2**53 - 1


def artifact_subject_problems(subject: Any) -> list[str]:
    """Self-consistency problems of a presented subject; empty when its shape and self-hash are sound."""
    if not isinstance(subject, dict):
        return ["artifact subject must be an object"]
    s = subject
    problems = [f"unknown field {k}" for k in js_keys(s) if k not in _SUBJECT_KEYS]
    problems += [f"missing field {k}" for k in _SUBJECT_KEYS if k not in s]
    if problems:
        return problems
    if s["schema"] != ARTIFACT_SUBJECT_SCHEMA:
        problems.append(f"schema must be {ARTIFACT_SUBJECT_SCHEMA}")
    if not isinstance(s["lineage_id"], str) or not _LINEAGE_RE.fullmatch(s["lineage_id"]):
        problems.append("lineage_id is invalid")
    for k in ("subject_hash", "target_identity", "changed_path_manifest_sha256"):
        if not isinstance(s[k], str) or not _SHA_RE.fullmatch(s[k]):
            problems.append(f"{k} must be sha256:<64 hex>")
    for k in ("base_tree", "candidate_tree"):
        if not isinstance(s[k], str) or not _TREE_RE.fullmatch(s[k]):
            problems.append(f"{k} must be a tree id")
    if s["role"] != "lens":
        problems.append("role must be lens")
    if not isinstance(s["lens"], str) or s["lens"] not in LENSES:
        problems.append("lens is unknown")
    if not _safe_int(s["selected_order"]) or s["selected_order"] < 0:
        problems.append("selected_order is invalid")
    if problems:
        return problems
    if _subject_hash_of({k: v for k, v in s.items() if k != "subject_hash"}) != s["subject_hash"]:
        problems.append("subject_hash does not match its binding")
    return problems


def refuter_request_hash(record: dict) -> str:
    """The batch a refuter answers: the blocking severe findings of the fully reviewed candidate."""
    ids = set(blocking_finding_ids({k: v for k, v in record.items() if k != "refuted_finding_ids"}))
    view = [{k: f[k] for k in ("id", "lens", "severity", "location", "claim") if k in f} for f in record["findings"] if f["id"] in ids]
    return domain_hash("refuter-request", 1, {
        "lineage_id": record["lineage_id"], "target_identity": record["target_identity"], "base_tree": record["base_tree"],
        "candidate_tree": record["candidate_tree"], "findings": sorted(view, key=lambda f: _bytes(f["id"])),
    })


def targeted_validation_request_hash(record: dict) -> str | None:
    """The correction a targeted validator judges: frozen ledger, fix ids and the corrected candidate identity."""
    if record["state"] != "validating" or "correction_target_identity" not in record or "ledger_hash" not in record:
        return None
    lines = record.get("actual_correction_lines")
    return domain_hash("targeted-validation-request", 1, {
        "lineage_id": record["lineage_id"], "target_identity": record["target_identity"], "ledger_hash": record["ledger_hash"],
        "fix_finding_ids": record["fix_finding_ids"], "correction_target_identity": record["correction_target_identity"],
        "actual_correction_lines": 0 if lines is None else lines,
    })


def finding_path(location: Any) -> str | None:
    """Repository path of a finding location ("path:line" or "path:start-end"); None when malformed."""
    m = _FINDING_LOC_RE.fullmatch(_js_string(location))
    return m.group(1) if m else None
