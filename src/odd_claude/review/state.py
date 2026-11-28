"""Compact review state v2: pure, I/O-free model, validator and transitions (port of v9 review/state.ts).

Record representation (what later layers build on): a state record is a plain `dict` with EXACTLY v9's JSON shape
(`odd-claude.review-state/v2`, snake_case keys, optional keys absent rather than None). Transition inputs are plain dicts
with v9's camelCase keys (`now`, `lens`, `findings`, `resultHash`, `artifactDigest`, `refutedFindingIds`, `fixFindingIds`,
`actualCorrectionLines`, `correctionTargetIdentity`, `correctionCandidateTree`, `reason`, `token`, `randomToken` (a
zero-argument callable) and, for `start`, `lineageId`, `targetIdentity`, `projection`, `baseTree`, `candidateTree`,
`riskLevel`, `selectedLenses`, `originalChangedLines`). A missing key is "undefined"; an explicit `None` is JSON null, as in v9.
Outcomes are dicts too: `{"ok": True, "record": {...}[, "ackToken": str]}` or `{"ok": False, "refusal": {"code", "message"}}`;
`validate_state_record` returns `{"ok": True, "record"}` or `{"ok": False, "errors": [...]}`. Transitions never mutate their
input and return a new sealed record (`revision` = `state_revision`).

Why dicts and not Pydantic models: `validate_state_record` must reproduce v9's error LIST (every message, in order, for
arbitrary JSON including wrong types), which a model validator cannot; the validator is a literal port, and a model view
would only restate it.

Public API: constants `STATE_SCHEMA`, `MAX_CORRECTION_ATTEMPTS`, `MAX_ADMITTED_ROLE_RESULTS`, `MAX_CORRECTION_CHANGED_LINES`,
`LENSES`, `STATES`, `SEVERITIES`, `EVIDENCE_CLASSES`, `CAUSAL_DISPOSITIONS`; `finding_id_prefix_for_lens`,
`finding_disposition`, `blocking_finding_ids`, `inconclusive_finding_ids`, `correction_budget`, `state_revision`,
`validate_state_record`, and the transitions `start`, `admit_lens_result`, `admit_validator_result`, `admit_refuter_result`,
`require_correction`, `begin_validation`, `approve`, `reopen_correction`, `escalate`, `invalidate`, `burn`.
"""
import hmac
import math
import re
import secrets
from typing import Any, Callable

from ..lib.js import js_keys, js_number, js_trim
from .canonical import _js_string, domain_hash

STATE_SCHEMA = "odd-claude.review-state/v2"
MAX_CORRECTION_ATTEMPTS = 2
MAX_ADMITTED_ROLE_RESULTS = 6
MAX_CORRECTION_CHANGED_LINES = 200

LENSES = ["risk", "resilience", "readability", "reliability"]
STATES = ["reviewing", "correction_required", "validating", "approved", "escalated", "invalidated"]
SEVERITIES = ["BLOCKER", "CRITICAL", "MAJOR", "MINOR", "INFO", "WARNING", "SUGGESTION"]
EVIDENCE_CLASSES = ["deterministic", "inferential", "insufficient"]
CAUSAL_DISPOSITIONS = ["introduced", "behavior-activated", "worsened", "pre-existing", "base-only", "unknown"]

_FINDING_PREFIX = {"risk": "R1-", "readability": "R2-", "reliability": "R3-", "resilience": "R4-"}

StateRecord = dict[str, Any]
Outcome = dict[str, Any]

_U: Any = object()  # JS `undefined`: a key that is not there


def finding_id_prefix_for_lens(lens: Any) -> str:
    return _FINDING_PREFIX.get(lens, "") if isinstance(lens, str) else ""


def _g(d: dict, k: str) -> Any:
    return d.get(k, _U)


def _num(d: dict, k: str) -> float:
    """JS numeric coercion of a field for `<`/`>=` comparisons: missing is NaN (every comparison false), null is 0."""
    v = d.get(k, _U)
    return float("nan") if v is _U else 0 if v is None else v


def _truthy(v: Any) -> bool:
    """JS truthiness of a JSON value (missing included)."""
    return not (v is _U or v is None or v is False or v == 0 or v == "") if not isinstance(v, (list, dict)) else True


def _str(v: Any) -> str:
    """JS `String(v)` / template interpolation of a JSON value (or a missing one)."""
    return "undefined" if v is _U else _js_string(v)


def _is_num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _seq(a: Any, b: Any) -> bool:
    """JS `===` over JSON values (objects and arrays compare by identity)."""
    if a is _U or b is _U:
        return a is b
    if isinstance(a, bool) or isinstance(b, bool):
        return a is b
    if _is_num(a) and _is_num(b):
        return a == b
    if isinstance(a, str) and isinstance(b, str):
        return a == b
    return a is b


def _to_num(v: Any) -> float:
    """JS ToNumber for the relational operators."""
    if v is None:
        return 0.0
    if isinstance(v, bool):
        return 1.0 if v else 0.0
    if _is_num(v):
        return float(v)
    if isinstance(v, (str, list)):
        t = js_trim(_js_string(v))
        return 0.0 if t == "" else js_number(t)
    return math.nan


def _utf16(s: str) -> bytes:
    return s.encode("utf-16-be", "surrogatepass")


def _sorted_strs(xs: list[str]) -> list[str]:
    """`[...new Set(xs)].sort()`: unique, in UTF-16 code unit order."""
    return sorted(set(xs), key=_utf16)


def _non_neg_int(v: Any) -> bool:
    return _is_num(v) and math.isfinite(v) and float(v).is_integer() and abs(v) <= 2**53 - 1 and v >= 0


# ---- formats ----

_LINEAGE_RE = re.compile(r"review-[0-9a-f]{16}")
_SHA_RE = re.compile(r"sha256:[0-9a-f]{64}")
_TREE_RE = re.compile(r"(?:[0-9a-f]{40}|[0-9a-f]{64})")
_TOKEN_RE = re.compile(r"[0-9a-f]{64}")
_TIME_RE = re.compile(r"([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]+))?Z")
_FINDING_ID_RE = re.compile(r"R[1-4]-[A-Za-z0-9][A-Za-z0-9._-]*")


def _is_sha(v: Any) -> bool:
    return isinstance(v, str) and _SHA_RE.fullmatch(v) is not None


def _is_tree(v: Any) -> bool:
    return isinstance(v, str) and _TREE_RE.fullmatch(v) is not None


def _days_from_civil(y: int, m: int, d: int) -> int:
    y -= m <= 2
    era = y // 400
    yoe = y - era * 400
    doy = (153 * (m + (-3 if m > 2 else 9)) + 2) // 5 + d - 1
    return era * 146097 + yoe * 365 + yoe // 4 - yoe // 100 + doy - 719468


def _date_parse(s: str) -> float | None:
    """V8 `Date.parse` of a string TIME_RE matched: ms since the epoch, None for NaN (day 1..31 of any month rolls over)."""
    m = _TIME_RE.fullmatch(s)
    if not m:
        return None
    y, mo, d, h, mi, sec = (int(x) for x in m.groups()[:6])
    frac = (m.group(7) or "")[:3].ljust(3, "0")
    if not (1 <= mo <= 12 and 1 <= d <= 31 and mi <= 59 and sec <= 59 and h <= 24):
        return None
    if h == 24 and (mi or sec or int(frac)):
        return None
    return ((_days_from_civil(y, mo, d) * 24 + h) * 60 + mi) * 60_000 + sec * 1000 + int(frac)


def _is_time(v: Any) -> bool:
    return isinstance(v, str) and _TIME_RE.fullmatch(v) is not None and _date_parse(v) is not None


def _is_lens(v: Any) -> bool:
    return isinstance(v, str) and v in LENSES


def _is_severe(s: Any) -> bool:
    return s == "BLOCKER" or s == "CRITICAL"


def _is_obj(v: Any) -> bool:
    return isinstance(v, dict)


def correction_budget(original_changed_lines: Any) -> int:
    """floor_two correction budget: ceil(n/2) capped at 200, never below 2 for a positive candidate."""
    if not _non_neg_int(original_changed_lines):
        raise RangeError("original changed lines must be a non-negative integer")
    n = int(original_changed_lines)
    legacy = min(MAX_CORRECTION_CHANGED_LINES, n // 2 + n % 2)
    return 2 if n > 0 and legacy < 2 else legacy


class RangeError(ValueError):
    """JS RangeError (raised by `correction_budget`)."""


def _lens_set_problem(risk: Any, lenses: Any) -> str | None:
    """Lens policy: low 0, medium exactly 1, high 1..4 (an explicit pertinent subset, or all four)."""
    if risk not in ("low", "medium", "high") or not isinstance(risk, str):
        return "risk_level must be low, medium or high"
    if not isinstance(lenses, list) or not all(_is_lens(x) for x in lenses):
        return "selected_lenses must be a list of known lenses"
    lo, hi = (0, 0) if risk == "low" else (1, 1) if risk == "medium" else (1, len(LENSES))
    if len(lenses) < lo or len(lenses) > hi:
        return f"selected_lenses must hold {f'exactly {lo}' if lo == hi else f'{lo} to {hi}'} lenses for {risk} risk"
    order = [LENSES.index(x) for x in lenses]
    for i in range(1, len(order)):
        if order[i] <= order[i - 1]:
            return "selected_lenses must be unique and in canonical order"
    return None


# ---- findings ----


def finding_disposition(f: dict, refuted: list | None = None) -> str:
    """How a finding weighs on approval: clear, blocking, follow_up, inconclusive or refuted."""
    if f.get("severity") != "BLOCKER" and f.get("severity") != "CRITICAL":
        return "clear"
    if f.get("evidence_class") == "insufficient" or f.get("causal_disposition") == "unknown":
        return "inconclusive"
    if f.get("causal_disposition") in ("pre-existing", "base-only"):
        return "follow_up"
    return "refuted" if f.get("id") in (refuted or []) else "blocking"


def _refuted_of(record: StateRecord) -> list:
    r = record.get("refuted_finding_ids")
    return [] if r is None else r


def blocking_finding_ids(record: StateRecord) -> list[str]:
    return sorted((f["id"] for f in record["findings"] if finding_disposition(f, _refuted_of(record)) == "blocking"), key=_utf16)


def inconclusive_finding_ids(record: StateRecord) -> list[str]:
    return sorted((f["id"] for f in record["findings"] if finding_disposition(f) == "inconclusive"), key=_utf16)


# ---- hashes ----


def _ledger_hash_of(findings: list[dict]) -> str:
    return domain_hash("review-ledger", 1, sorted(findings, key=lambda f: _utf16(f["id"])))


def _evidence_hash_of(r: StateRecord) -> str:
    admitted = r["admitted_role_results"]
    lens_results = [
        {"lens": lens, "result_hash": e["result_hash"]} for lens in LENSES for e in admitted if e.get("role") == "lens" and e.get("lens") == lens
    ]
    validator = next((e for e in admitted if e.get("role") == "validator"), None)
    refuter = next((e for e in admitted if e.get("role") == "refuter"), None)
    ledger = r.get("ledger_hash")
    body: dict[str, Any] = {
        "lens_results": lens_results,
        "ledger_hash": None if ledger is None else ledger,
        "correction_attempts": r["correction_attempts"],
        "validator_result_hash": validator["result_hash"] if validator else None,
    }
    if refuter:
        body["refuter_result_hash"] = refuter["result_hash"]
        body["refuted_finding_ids"] = _refuted_of(r)
    return domain_hash("review-evidence", 1, body)


def _token_hash_of(token: str) -> str:
    return domain_hash("approved-ack-token", 1, token)


def state_revision(record: StateRecord) -> str:
    """domainHash("review-state", 2, record without its revision). Key order never matters."""
    return domain_hash("review-state", 2, {k: v for k, v in record.items() if k != "revision"})


def _seal(record: dict) -> StateRecord:
    sealed = {**record, "revision": ""}
    sealed["revision"] = state_revision(sealed)
    return sealed


# ---- validation ----

_REQUIRED = [
    "schema", "revision", "lineage_id", "state", "target_identity", "projection", "base_tree", "candidate_tree", "risk_level",
    "selected_lenses", "original_changed_lines", "correction_budget", "correction_budget_policy", "correction_attempts",
    "admitted_role_results", "findings", "fix_finding_ids", "burned", "created_at", "updated_at",
]
_OPTIONAL = [
    "actual_correction_lines", "ledger_hash", "evidence_hash", "approved_ack_token_hash", "burn_receipt", "approved_revision", "escalation_reason",
    "invalidation_reason", "refuted_finding_ids", "correction_target_identity", "correction_candidate_tree", "original_target_identity",
    "original_candidate_tree",
]


def _check_keys(obj: dict, required: list[str], optional: list[str], where: str, errors: list[str]) -> None:
    for k in js_keys(obj):
        if k not in required and k not in optional:
            errors.append(f"{where}: unknown field {k}")
    for k in required:
        if k not in obj:
            errors.append(f"{where}: missing field {k}")


def _finding_shape_ok(f: dict, lens_ok: Callable[[Any], bool]) -> bool:
    ec, cd = _g(f, "evidence_class"), _g(f, "causal_disposition")
    return (
        isinstance(_g(f, "id"), str) and _FINDING_ID_RE.fullmatch(f["id"]) is not None and isinstance(_g(f, "lens"), str) and lens_ok(f["lens"])
        and isinstance(_g(f, "severity"), str) and f["severity"] in SEVERITIES
        and isinstance(_g(f, "location"), str) and isinstance(_g(f, "claim"), str)
        and (ec is _U or ec in EVIDENCE_CLASSES) and (cd is _U or cd in CAUSAL_DISPOSITIONS)
    )


def validate_state_record(input: Any) -> dict:
    errors: list[str] = []
    if not _is_obj(input):
        return {"ok": False, "errors": ["record must be an object"]}
    o = input
    _check_keys(o, _REQUIRED, _OPTIONAL, "record", errors)

    def has(k: str) -> bool:
        return k in o

    if o.get("schema") != STATE_SCHEMA:
        errors.append(f"schema must be {STATE_SCHEMA}")
    lid = _g(o, "lineage_id")
    if not isinstance(lid, str) or not _LINEAGE_RE.fullmatch(lid):
        errors.append("lineage_id must match review-<16 hex>")
    st = _g(o, "state")
    if not isinstance(st, str) or st not in STATES:
        errors.append(f"state must be one of {', '.join(STATES)}")
    if not _is_sha(_g(o, "target_identity")):
        errors.append("target_identity must be sha256:<64 hex>")
    if o.get("projection") != "workspace" and o.get("projection") != "staged":
        errors.append("projection must be workspace or staged")
    if not _is_tree(_g(o, "base_tree")):
        errors.append("base_tree must be a 40 or 64 hex tree id")
    if not _is_tree(_g(o, "candidate_tree")):
        errors.append("candidate_tree must be a 40 or 64 hex tree id")
    lens_problem = _lens_set_problem(_g(o, "risk_level"), _g(o, "selected_lenses"))
    if lens_problem:
        errors.append(lens_problem)
    ocl = _g(o, "original_changed_lines")
    if not _non_neg_int(ocl):
        errors.append("original_changed_lines must be a non-negative integer")
    if o.get("correction_budget_policy") != "floor_two":
        errors.append("correction_budget_policy must be floor_two")
    if _non_neg_int(ocl) and not _seq(_g(o, "correction_budget"), correction_budget(ocl)):
        errors.append("correction_budget does not match original_changed_lines")
    ca = _g(o, "correction_attempts")
    if not _non_neg_int(ca) or ca > MAX_CORRECTION_ATTEMPTS:
        errors.append(f"correction_attempts must be an integer from 0 to {MAX_CORRECTION_ATTEMPTS}")
    if not isinstance(_g(o, "burned"), bool):
        errors.append("burned must be a boolean")
    created, updated = _g(o, "created_at"), _g(o, "updated_at")
    if not _is_time(created):
        errors.append("created_at must be a UTC RFC 3339 timestamp")
    if not _is_time(updated):
        errors.append("updated_at must be a UTC RFC 3339 timestamp")
    elif _is_time(created) and _date_parse(updated) < _date_parse(created):  # type: ignore[operator]
        errors.append("updated_at must not precede created_at")
    for k in ("ledger_hash", "evidence_hash", "burn_receipt"):
        if has(k) and not _is_sha(o[k]):
            errors.append(f"{k} must be sha256:<64 hex>")
    if has("approved_ack_token_hash") and not _is_sha(o["approved_ack_token_hash"]):
        errors.append("approved_ack_token_hash must be sha256:<64 hex>")
    for k in ("escalation_reason", "invalidation_reason"):
        if has(k) and (not isinstance(o[k], str) or js_trim(o[k]) == ""):
            errors.append(f"{k} must be a non-empty string")
    if has("actual_correction_lines") and not _non_neg_int(o["actual_correction_lines"]):
        errors.append("actual_correction_lines must be a non-negative integer")
    if has("correction_target_identity"):
        if not _is_sha(o["correction_target_identity"]):
            errors.append("correction_target_identity must be sha256:<64 hex>")
        if not _is_num(ca) or ca < 1:
            errors.append("correction_target_identity requires correction_attempts to be at least 1")
    if has("correction_candidate_tree"):
        if not _is_tree(o["correction_candidate_tree"]):
            errors.append("correction_candidate_tree must be a 40 or 64 hex tree id")
        if not has("correction_target_identity"):
            errors.append("correction_candidate_tree requires correction_target_identity")
    # Defense in depth (reference CompleteCorrection): while validating, the corrected candidate must differ from the reviewed one.
    if st == "validating" and (
        (has("correction_target_identity") and _seq(o["correction_target_identity"], _g(o, "target_identity")))
        or (has("correction_candidate_tree") and _seq(o["correction_candidate_tree"], _g(o, "candidate_tree")))
    ):
        errors.append("a validating record needs a corrected candidate that differs from the reviewed one (unchanged correction: same identity or tree)")
    if has("original_target_identity") != has("original_candidate_tree"):
        errors.append("original_target_identity and original_candidate_tree go together")
    # Fail closed: a settled lineage after a correction must bind the corrected candidate, so a missing swap is rejected in the store too.
    if (st == "approved" or st == "escalated") and has("correction_candidate_tree") and not has("original_target_identity"):
        errors.append("a settled record with correction_candidate_tree requires original_target_identity and original_candidate_tree (its candidate must be the corrected one)")
    if st == "approved" and has("correction_target_identity") and not has("original_target_identity"):
        errors.append("approved after a correction must bind the corrected candidate (original_target_identity and original_candidate_tree are required)")
    if has("original_target_identity") or has("original_candidate_tree"):
        if not _is_sha(_g(o, "original_target_identity")):
            errors.append("original_target_identity must be sha256:<64 hex>")
        if not _is_tree(_g(o, "original_candidate_tree")):
            errors.append("original_candidate_tree must be a 40 or 64 hex tree id")
        # The original is kept by a settled correction, and across a reopened one: a reopened correction_required (corrected
        # fields cleared) and the validating of its later attempt (the corrected fields hold the NEW candidate under validation).
        reopened = st == "correction_required"
        later_validation = st == "validating"
        if st != "approved" and st != "escalated" and not reopened and not later_validation:
            errors.append("the original candidate is only kept by an approval, an escalation or a reopened correction (original requires the approved, escalated, correction_required or validating state)")
        if reopened:
            if _seq(ca, 0) or has("correction_target_identity") or has("correction_candidate_tree"):
                errors.append("an original candidate on a correction_required record needs spent attempts and no pending corrected candidate")
        elif later_validation:
            if not _is_num(ca) or ca < 2:
                errors.append("an original candidate on a validating record needs a reopened correction (correction_attempts of at least 2)")
        elif not has("correction_target_identity") or not has("correction_candidate_tree"):
            errors.append("original candidate requires the corrected candidate (correction_target_identity and correction_candidate_tree)")
        elif not _seq(_g(o, "target_identity"), o["correction_target_identity"]) or not _seq(_g(o, "candidate_tree"), o["correction_candidate_tree"]):
            errors.append("target_identity and candidate_tree must be the corrected candidate when the original is kept")

    sel = _g(o, "selected_lenses")
    selected = [x for x in sel if isinstance(x, str)] if isinstance(sel, list) else []

    # admitted role results
    admitted: list[Any] = []
    arr = _g(o, "admitted_role_results")
    if not isinstance(arr, list):
        errors.append("admitted_role_results must be a list")
    else:
        if len(arr) > MAX_ADMITTED_ROLE_RESULTS:
            errors.append(f"admitted_role_results holds more than {MAX_ADMITTED_ROLE_RESULTS} entries")
        seen: set[str] = set()
        for i, entry in enumerate(arr):
            where = f"admitted_role_results[{i}]"
            if not _is_obj(entry):
                errors.append(f"{where} must be an object")
                continue
            _check_keys(entry, ["role", "result_hash"], ["lens", "artifact_digest"], where, errors)
            role = _g(entry, "role")
            if role not in ("lens", "refuter", "validator") or not isinstance(role, str):
                errors.append(f"{where}.role must be lens, refuter or validator")
                continue
            if not _is_sha(_g(entry, "result_hash")):
                errors.append(f"{where}.result_hash must be sha256:<64 hex>")
            if _g(entry, "artifact_digest") is not _U and not _is_sha(entry["artifact_digest"]):
                errors.append(f"{where}.artifact_digest must be sha256:<64 hex>")
            if role == "validator" or role == "refuter":
                if _g(entry, "lens") is not _U:
                    errors.append(f"{where}: a {role} carries no lens")
            elif not isinstance(_g(entry, "lens"), str) or entry["lens"] not in selected:
                errors.append(f"{where}.lens must be a selected lens")
            key = f"lens:{_str(_g(entry, 'lens'))}" if role == "lens" else role
            if key in seen:
                errors.append(f"{where} repeats an admitted {role} result")
            seen.add(key)
            admitted.append(entry)

    # findings
    findings: list[dict] = []
    fl = _g(o, "findings")
    if not isinstance(fl, list):
        errors.append("findings must be a list")
    else:
        ids: set[str] = set()
        for i, f in enumerate(fl):
            where = f"findings[{i}]"
            if not _is_obj(f):
                errors.append(f"{where} must be an object")
                continue
            _check_keys(f, ["id", "lens", "severity", "location", "claim"], ["evidence_class", "causal_disposition"], where, errors)
            if not _finding_shape_ok(f, lambda x: x in selected):
                errors.append(f"{where} is malformed (id, selected lens, severity, location, claim)")
                continue
            prefix = finding_id_prefix_for_lens(f["lens"])
            if not f["id"].startswith(prefix):
                errors.append(f"{where}.id must carry the {prefix} prefix of its lens")
            if f["id"] in ids:
                errors.append(f"{where}.id repeats")
            ids.add(f["id"])
            findings.append(f)

    # fix finding ids
    fix_ids: list[str] = []
    ffi = _g(o, "fix_finding_ids")
    if not isinstance(ffi, list) or not all(isinstance(x, str) for x in ffi):
        errors.append("fix_finding_ids must be a list of strings")
    else:
        fix_ids = ffi
        srt = _sorted_strs(fix_ids)
        if len(srt) != len(fix_ids) or any(v != fix_ids[i] for i, v in enumerate(srt)):
            errors.append("fix_finding_ids must be unique and sorted")
        for fid in fix_ids:
            f = next((x for x in findings if x["id"] == fid), None)
            if not f or not _is_severe(f["severity"]):
                errors.append(f"fix_finding_ids names {fid}, which is not a severe finding")
            elif isinstance(_g(o, "refuted_finding_ids"), list) and fid in o["refuted_finding_ids"]:
                errors.append(f"fix_finding_ids names {fid}, which was refuted")

    # refuted finding ids (present exactly when a refuter result is admitted)
    has_refuter = any(_g(e, "role") == "refuter" for e in admitted)
    if has("refuted_finding_ids"):
        refuted = o["refuted_finding_ids"]
        if not isinstance(refuted, list) or not all(isinstance(x, str) for x in refuted):
            errors.append("refuted_finding_ids must be a list of strings")
        else:
            srt = _sorted_strs(refuted)
            if len(srt) != len(refuted) or any(v != refuted[i] for i, v in enumerate(srt)):
                errors.append("refuted_finding_ids must be unique and sorted")
            for rid in refuted:
                f = next((x for x in findings if x["id"] == rid), None)
                if not f or finding_disposition(f) != "blocking":
                    errors.append(f"refuted_finding_ids names {rid}, which is not a refutable severe finding")
        if not has_refuter:
            errors.append("refuted_finding_ids requires an admitted refuter result")
    elif has_refuter:
        errors.append("an admitted refuter result requires refuted_finding_ids")

    # burn / token
    burned = _g(o, "burned")
    if has("approved_revision"):
        if not _is_sha(o["approved_revision"]):
            errors.append("approved_revision must be sha256:<64 hex>")
        if burned is not True:
            errors.append("approved_revision requires burned")
    if burned is True and not has("burn_receipt"):
        errors.append("burned requires burn_receipt")
    if burned is False and has("burn_receipt"):
        errors.append("burn_receipt requires burned")
    if burned is True and st != "approved":
        errors.append("burned requires the approved state")
    if st == "approved" and not has("approved_ack_token_hash"):
        errors.append("approved requires approved_ack_token_hash")
    if st != "approved" and has("approved_ack_token_hash"):
        errors.append("approved_ack_token_hash requires the approved state")
    if st != "escalated" and has("escalation_reason"):
        errors.append("escalation_reason requires the escalated state")
    if st == "escalated" and not has("escalation_reason"):
        errors.append("escalated requires escalation_reason")
    if st != "invalidated" and has("invalidation_reason"):
        errors.append("invalidation_reason requires the invalidated state")
    if st == "invalidated" and not has("invalidation_reason"):
        errors.append("invalidated requires invalidation_reason")

    # per-state invariants
    lens_admitted = all(any(_g(e, "role") == "lens" and _seq(_g(e, "lens"), x) for e in admitted) for x in selected)
    has_validator = any(_g(e, "role") == "validator" for e in admitted)
    attempts = ca  # shape errors above already reject a non-integer
    attempts_n = _to_num(attempts) if attempts is not _U else math.nan
    needs_complete = st in ("correction_required", "validating", "approved")
    if needs_complete and not lens_admitted:
        errors.append(f"{_str(_g(o, 'state'))} requires every selected lens result to be admitted")
    if st == "reviewing":
        if fix_ids or not _seq(attempts, 0) or has("actual_correction_lines") or has("ledger_hash") or has("evidence_hash"):
            errors.append("reviewing record contains post-review data")
        if any(_g(e, "role") == "validator" for e in admitted):
            errors.append("reviewing record admits no validator result")
    if st == "correction_required":
        if not fix_ids:
            errors.append("correction_required requires fix_finding_ids")
        # A reopened correction (a failed validation with attempts left) carries the attempts already spent, never the last allowed one.
        if attempts_n >= MAX_CORRECTION_ATTEMPTS or has("actual_correction_lines"):
            errors.append("correction_required precedes the correction attempt")
    if st == "validating":
        if not fix_ids:
            errors.append("validating requires fix_finding_ids")
        if attempts_n < 1:
            errors.append("validating requires correction_attempts to be at least 1 (correction_attempts)")
        acl, cb = _g(o, "actual_correction_lines"), _g(o, "correction_budget")
        if not _non_neg_int(acl) or (_non_neg_int(cb) and acl > cb):
            errors.append("actual_correction_lines must be within correction_budget")
    if needs_complete and not has("ledger_hash"):
        errors.append(f"{_str(_g(o, 'state'))} requires ledger_hash")
    if has("ledger_hash") and not _seq(o["ledger_hash"], _ledger_hash_of(findings)):
        errors.append("ledger_hash does not match findings")
    if st == "approved":
        refuted_ids = o["refuted_finding_ids"] if isinstance(_g(o, "refuted_finding_ids"), list) else []
        unresolved = any(finding_disposition(f, refuted_ids) in ("blocking", "inconclusive") for f in findings)
        if _seq(attempts, 0) and (fix_ids or unresolved):
            errors.append("approved without a correction cannot hold severe findings")
        if attempts_n >= 1 and not has_validator:
            errors.append("approved after a correction requires an admitted validator result")
        if attempts_n >= 1 and not _non_neg_int(_g(o, "actual_correction_lines")):
            errors.append("approved after a correction requires actual_correction_lines")
        if not has("evidence_hash"):
            errors.append("approved requires evidence_hash")
    if st not in ("validating", "approved", "escalated") and has_validator:
        errors.append("validator result requires a validating or later state")

    if not errors and st == "approved" and not _seq(_g(o, "evidence_hash"), _evidence_hash_of(o)):
        errors.append("evidence_hash does not match admitted results")
    try:
        if not _seq(_g(o, "revision"), state_revision(o)):
            errors.append("revision does not match the record content")
    except Exception:  # noqa: BLE001 - JS catches everything here
        errors.append("revision cannot be recomputed from the record content")
    return {"ok": False, "errors": errors} if errors else {"ok": True, "record": input}


# ---- transitions ----


def _refuse(code: str, message: str) -> Outcome:
    return {"ok": False, "refusal": {"code": code, "message": message}}


def _bad_now(now: Any) -> Outcome | None:
    return None if _is_time(now) else _refuse("invalid_input", "now must be a UTC RFC 3339 timestamp")


def _copy(record: StateRecord) -> dict:
    nxt = {k: v for k, v in record.items() if k != "revision"}
    nxt["selected_lenses"] = list(record["selected_lenses"])
    nxt["admitted_role_results"] = [dict(e) for e in record["admitted_role_results"]]
    nxt["findings"] = [dict(f) for f in record["findings"]]
    nxt["fix_finding_ids"] = list(record["fix_finding_ids"])
    if isinstance(record.get("refuted_finding_ids"), list):
        nxt["refuted_finding_ids"] = list(record["refuted_finding_ids"])
    return nxt


def _lenses_admitted(record: StateRecord) -> bool:
    return all(any(e.get("role") == "lens" and e.get("lens") == x for e in record["admitted_role_results"]) for x in record["selected_lenses"])


def _new_token(gen: Callable[[], str] | None) -> str:
    return gen() if gen else secrets.token_hex(32)


def _opt_sha_bad(v: Any) -> bool:
    return v is not _U and not _is_sha(v)


def _opt_tree_bad(v: Any) -> bool:
    return v is not _U and not _is_tree(v)


def _optional_digest(input: dict) -> dict:
    d = _g(input, "artifactDigest")
    return {} if d is _U else {"artifact_digest": d}


def start(input: dict) -> Outcome:
    """New lineage: reviewing, or directly approved (token issued) when the policy requires no lenses."""

    def invalid(m: str) -> Outcome:
        return _refuse("invalid_input", m)

    if not isinstance(_g(input, "lineageId"), str) or not _LINEAGE_RE.fullmatch(input["lineageId"]):
        return invalid("lineageId must match review-<16 hex>")
    if not _is_sha(_g(input, "targetIdentity")):
        return invalid("targetIdentity must be sha256:<64 hex>")
    if input.get("projection") != "workspace" and input.get("projection") != "staged":
        return invalid("projection must be workspace or staged")
    if not _is_tree(_g(input, "baseTree")):
        return invalid("baseTree must be a 40 or 64 hex tree id")
    if not _is_tree(_g(input, "candidateTree")):
        return invalid("candidateTree must be a 40 or 64 hex tree id")
    problem = _lens_set_problem(_g(input, "riskLevel"), _g(input, "selectedLenses"))
    if problem:
        return invalid(problem)
    if not _non_neg_int(_g(input, "originalChangedLines")):
        return invalid("originalChangedLines must be a non-negative integer")
    bad = _bad_now(_g(input, "now"))
    if bad:
        return bad
    reviewing = _seal({
        "schema": STATE_SCHEMA,
        "lineage_id": input["lineageId"],
        "state": "reviewing",
        "target_identity": input["targetIdentity"],
        "projection": input["projection"],
        "base_tree": input["baseTree"],
        "candidate_tree": input["candidateTree"],
        "risk_level": input["riskLevel"],
        "selected_lenses": list(input["selectedLenses"]),
        "original_changed_lines": input["originalChangedLines"],
        "correction_budget": correction_budget(input["originalChangedLines"]),
        "correction_budget_policy": "floor_two",
        "correction_attempts": 0,
        "admitted_role_results": [],
        "findings": [],
        "fix_finding_ids": [],
        "burned": False,
        "created_at": input["now"],
        "updated_at": input["now"],
    })
    if reviewing["selected_lenses"]:
        return {"ok": True, "record": reviewing}
    approved = approve(reviewing, {"now": input["now"], "randomToken": input.get("randomToken")})
    return {"ok": True, "record": approved["record"], "ackToken": approved["ackToken"]} if approved["ok"] else approved


def admit_lens_result(record: StateRecord, input: dict) -> Outcome:
    if _g(record, "state") != "reviewing":
        return _refuse("illegal_state", f"cannot admit a lens result from {_str(_g(record, "state"))}")
    bad = _bad_now(_g(input, "now"))
    if bad:
        return bad
    lens = _g(input, "lens")
    if not _is_lens(lens) or lens not in record["selected_lenses"]:
        return _refuse("invalid_input", f"lens {_str(lens)} is not selected")
    if not _is_sha(_g(input, "resultHash")):
        return _refuse("invalid_input", "resultHash must be sha256:<64 hex>")
    if _opt_sha_bad(_g(input, "artifactDigest")):
        return _refuse("invalid_input", "artifactDigest must be sha256:<64 hex>")
    if any(e.get("role") == "lens" and e.get("lens") == lens for e in record["admitted_role_results"]):
        return _refuse("lens_already_admitted", f"lens {lens} already has an admitted result")
    if len(record["admitted_role_results"]) >= MAX_ADMITTED_ROLE_RESULTS:
        return _refuse("capacity_exceeded", "admitted role results are full")
    in_findings = _g(input, "findings")
    if not isinstance(in_findings, list):
        return _refuse("invalid_input", "findings must be a list")
    prefix = finding_id_prefix_for_lens(lens)
    known = {f["id"] for f in record["findings"]}
    accepted: list[dict] = []
    for f in in_findings:
        if not (_is_obj(f) and _finding_shape_ok(f, lambda x: x == lens)):
            return _refuse("invalid_input", "finding is malformed or bound to another lens")
        if not f["id"].startswith(prefix):
            return _refuse("invalid_input", f"finding id {f['id']} must carry the {prefix} prefix of lens {lens}")
        if f["id"] in known:
            return _refuse("invalid_input", f"finding id {f['id']} repeats")
        known.add(f["id"])
        accepted.append({k: f[k] for k in ("id", "lens", "severity", "location", "claim", "evidence_class", "causal_disposition") if k in f})
    nxt = _copy(record)
    nxt["admitted_role_results"].append({"role": "lens", "lens": lens, "result_hash": input["resultHash"], **_optional_digest(input)})
    nxt["findings"].extend(accepted)
    nxt["updated_at"] = input["now"]
    return {"ok": True, "record": _seal(nxt)}


def admit_validator_result(record: StateRecord, input: dict) -> Outcome:
    if _g(record, "state") != "validating":
        return _refuse("illegal_state", f"cannot admit a validator result from {_str(_g(record, "state"))}")
    bad = _bad_now(_g(input, "now"))
    if bad:
        return bad
    if not _is_sha(_g(input, "resultHash")):
        return _refuse("invalid_input", "resultHash must be sha256:<64 hex>")
    if _opt_sha_bad(_g(input, "artifactDigest")):
        return _refuse("invalid_input", "artifactDigest must be sha256:<64 hex>")
    if any(e.get("role") == "validator" for e in record["admitted_role_results"]):
        return _refuse("validator_already_admitted", "a validator result is already admitted")
    if len(record["admitted_role_results"]) >= MAX_ADMITTED_ROLE_RESULTS:
        return _refuse("capacity_exceeded", "admitted role results are full")
    nxt = _copy(record)
    nxt["admitted_role_results"].append({"role": "validator", "result_hash": input["resultHash"], **_optional_digest(input)})
    nxt["updated_at"] = input["now"]
    return {"ok": True, "record": _seal(nxt)}


def admit_refuter_result(record: StateRecord, input: dict) -> Outcome:
    """One optional refuter batch, after every lens result and before the correction decision."""
    if _g(record, "state") != "reviewing":
        return _refuse("illegal_state", f"cannot admit a refuter result from {_str(_g(record, "state"))}")
    bad = _bad_now(_g(input, "now"))
    if bad:
        return bad
    if not _lenses_admitted(record):
        return _refuse("lenses_incomplete", "every selected lens result must be admitted before a refuter result")
    if not _is_sha(_g(input, "resultHash")):
        return _refuse("invalid_input", "resultHash must be sha256:<64 hex>")
    if _opt_sha_bad(_g(input, "artifactDigest")):
        return _refuse("invalid_input", "artifactDigest must be sha256:<64 hex>")
    if any(e.get("role") == "refuter" for e in record["admitted_role_results"]):
        return _refuse("refuter_already_admitted", "a refuter result is already admitted")
    if len(record["admitted_role_results"]) >= MAX_ADMITTED_ROLE_RESULTS:
        return _refuse("capacity_exceeded", "admitted role results are full")
    ids = _g(input, "refutedFindingIds")
    if not isinstance(ids, list) or not all(isinstance(x, str) for x in ids):
        return _refuse("invalid_input", "refutedFindingIds must be a list of strings")
    canon = _sorted_strs(ids)
    if len(canon) != len(ids) or any(v != ids[i] for i, v in enumerate(canon)):
        return _refuse("invalid_input", "refutedFindingIds must be unique and sorted")
    for fid in ids:
        f = next((x for x in record["findings"] if x["id"] == fid), None)
        if not f or finding_disposition(f) != "blocking":
            return _refuse("invalid_input", f"{fid} is not a refutable severe finding of this review")
    nxt = _copy(record)
    nxt["admitted_role_results"].append({"role": "refuter", "result_hash": input["resultHash"], **_optional_digest(input)})
    nxt["refuted_finding_ids"] = list(ids)
    nxt["updated_at"] = input["now"]
    return {"ok": True, "record": _seal(nxt)}


def require_correction(record: StateRecord, input: dict) -> Outcome:
    """Freezes the ledger and opens a correction phase (up to MAX_CORRECTION_ATTEMPTS per lineage) for the named severe findings."""
    if _g(record, "state") != "reviewing":
        return _refuse("illegal_state", f"cannot require a correction from {_str(_g(record, "state"))}")
    bad = _bad_now(_g(input, "now"))
    if bad:
        return bad
    if not _lenses_admitted(record):
        return _refuse("lenses_incomplete", "every selected lens result must be admitted before a correction")
    ids = _g(input, "fixFindingIds")
    if not isinstance(ids, list) or len(ids) == 0:
        return _refuse("no_fix_findings", "a correction needs at least one severe finding id")
    # JS: `new Set(ids).sort()` on arbitrary values; non-strings sort by their string form
    try:
        uniq: list[Any] = []
        for x in ids:
            if not any(_seq(x, y) for y in uniq):
                uniq.append(x)
        canon = sorted(uniq, key=lambda x: _utf16(_str(x)))
    except Exception:  # noqa: BLE001
        canon = ids
    if len(canon) != len(ids) or any(not _seq(v, ids[i]) for i, v in enumerate(canon)):
        return _refuse("invalid_input", "fixFindingIds must be unique and sorted")
    for fid in ids:
        f = next((x for x in record["findings"] if _seq(x["id"], fid)), None)
        if not f or finding_disposition(f, _refuted_of(record)) != "blocking":
            return _refuse("invalid_input", f"{_str(fid)} is not a blocking severe finding of this review")
    if _num(record, "correction_attempts") >= MAX_CORRECTION_ATTEMPTS:
        return _refuse("illegal_state", "the correction attempts are already consumed")
    if _num(record, "correction_budget") <= 0:
        return _refuse("correction_unavailable", "the correction budget is zero; escalate instead")
    nxt = _copy(record)
    nxt["state"] = "correction_required"
    nxt["fix_finding_ids"] = list(ids)
    nxt["ledger_hash"] = _ledger_hash_of(nxt["findings"])
    nxt["updated_at"] = input["now"]
    return {"ok": True, "record": _seal(nxt)}


def begin_validation(record: StateRecord, input: dict) -> Outcome:
    if _g(record, "state") != "correction_required":
        return _refuse("illegal_state", f"cannot begin validation from {_str(_g(record, "state"))}")
    bad = _bad_now(_g(input, "now"))
    if bad:
        return bad
    lines = _g(input, "actualCorrectionLines")
    if not _non_neg_int(lines):
        return _refuse("invalid_input", "actualCorrectionLines must be a non-negative integer")
    if lines > _num(record, "correction_budget"):
        return _refuse("correction_over_budget", f"correction of {_str(lines)} lines exceeds the budget of {_str(_g(record, "correction_budget"))}")
    cti, cct = _g(input, "correctionTargetIdentity"), _g(input, "correctionCandidateTree")
    if _opt_sha_bad(cti):
        return _refuse("invalid_input", "correctionTargetIdentity must be sha256:<64 hex>")
    if cct is not _U:
        if cti is _U:
            return _refuse("invalid_input", "correctionCandidateTree needs correctionTargetIdentity")
        if not _is_tree(cct):
            return _refuse("invalid_input", "correctionCandidateTree must be a 40 or 64 hex tree id")
    if _seq(cti, _g(record, "target_identity")) or (cct is not _U and _seq(cct, _g(record, "candidate_tree"))):
        return _refuse("correction_unavailable", "the corrected candidate is unchanged: make a correction before validating")
    nxt = _copy(record)
    nxt["state"] = "validating"
    nxt["correction_attempts"] = _num(record, "correction_attempts") + 1
    nxt["actual_correction_lines"] = lines
    if cti is not _U:
        nxt["correction_target_identity"] = cti
    if cct is not _U:
        nxt["correction_candidate_tree"] = cct
    nxt["updated_at"] = input["now"]
    return {"ok": True, "record": _seal(nxt)}


def _adopt_corrected(nxt: dict, record: StateRecord, tree: Any) -> bool:
    """From validating with a corrected candidate, the lineage's candidate becomes the corrected one (the reviewed original
    is kept as history). `tree` completes a record that has no `correction_candidate_tree`. False when the corrected tree is
    unknown (nothing is changed)."""
    corrected = _g(record, "correction_target_identity")
    corrected_tree = record.get("correction_candidate_tree")
    if corrected_tree is None:
        corrected_tree = tree
    if corrected is _U or corrected_tree is None:
        return False
    nxt["correction_candidate_tree"] = corrected_tree
    # The first reviewed candidate stays the history across several corrections.
    nxt["original_target_identity"] = record["original_target_identity"] if record.get("original_target_identity") is not None else record["target_identity"]
    nxt["original_candidate_tree"] = record["original_candidate_tree"] if record.get("original_candidate_tree") is not None else record["candidate_tree"]
    nxt["target_identity"] = corrected
    nxt["candidate_tree"] = corrected_tree
    return True


def approve(record: StateRecord, input: dict) -> Outcome:
    """Approves and issues the one-shot acknowledgement token; only its hash is stored."""
    if _g(record, "state") != "reviewing" and _g(record, "state") != "validating":
        return _refuse("illegal_state", f"cannot approve from {_str(_g(record, "state"))}")
    bad = _bad_now(_g(input, "now"))
    if bad:
        return bad
    if not _lenses_admitted(record):
        return _refuse("lenses_incomplete", "every selected lens result must be admitted before approval")
    if _g(record, "state") == "reviewing" and any(finding_disposition(f, _refuted_of(record)) in ("blocking", "inconclusive") for f in record["findings"]):
        return _refuse("severe_findings_open", "severe findings require a correction or escalation")
    if _g(record, "state") == "validating" and not any(e.get("role") == "validator" for e in record["admitted_role_results"]):
        return _refuse("validator_missing", "a validator result must be admitted before approval")
    token = _new_token(input.get("randomToken"))
    if not isinstance(token, str) or not _TOKEN_RE.fullmatch(token):
        return _refuse("invalid_input", "acknowledgement token must be 256 bits of lowercase hex")
    cct = _g(input, "correctionCandidateTree")
    if _opt_tree_bad(cct):
        return _refuse("invalid_input", "correctionCandidateTree must be a 40 or 64 hex tree id")
    if cct is not _U and "correction_target_identity" not in record:
        return _refuse("invalid_input", "correctionCandidateTree needs a record with a correction target")
    nxt = _copy(record)
    if _g(record, "state") == "validating" and "correction_target_identity" in record:
        # The validator judged the CORRECTED candidate: from here on the lineage's candidate is that one. The reviewed original is
        # kept only as history. Without the corrected tree the approval is refused.
        if not _adopt_corrected(nxt, record, None if cct is _U else cct):
            return _refuse("invalid_input", "an approval after a correction needs the corrected candidate tree (correction_candidate_tree)")
    nxt["state"] = "approved"
    nxt["ledger_hash"] = _ledger_hash_of(nxt["findings"])
    nxt["evidence_hash"] = _evidence_hash_of({**nxt, "revision": ""})
    nxt["approved_ack_token_hash"] = _token_hash_of(token)
    nxt["updated_at"] = input["now"]
    return {"ok": True, "record": _seal(nxt), "ackToken": token}


def reopen_correction(record: StateRecord, input: dict) -> Outcome:
    """A validating correction that failed with attempts left reopens a correction on the same frozen findings. The failed
    corrected candidate becomes the lineage's candidate. Refused when no attempt is left or the corrected tree is unknown."""
    if _g(record, "state") != "validating":
        return _refuse("illegal_state", f"cannot reopen a correction from {_str(_g(record, "state"))}")
    bad = _bad_now(_g(input, "now"))
    if bad:
        return bad
    if _num(record, "correction_attempts") >= MAX_CORRECTION_ATTEMPTS:
        return _refuse("illegal_state", "the correction attempts are already consumed")
    cct = _g(input, "correctionCandidateTree")
    if _opt_tree_bad(cct):
        return _refuse("invalid_input", "correctionCandidateTree must be a 40 or 64 hex tree id")
    nxt = _copy(record)
    if not _adopt_corrected(nxt, record, None if cct is _U else cct):
        return _refuse("invalid_input", "a reopened correction needs the corrected candidate tree (correction_candidate_tree)")
    nxt["state"] = "correction_required"
    for k in ("correction_target_identity", "correction_candidate_tree", "actual_correction_lines"):
        nxt.pop(k, None)
    nxt["updated_at"] = input["now"]
    return {"ok": True, "record": _seal(nxt)}


def _reason_bad(reason: Any) -> bool:
    return not isinstance(reason, str) or js_trim(reason) == ""


def escalate(record: StateRecord, input: dict) -> Outcome:
    if _g(record, "state") not in ("reviewing", "correction_required", "validating"):
        return _refuse("illegal_state", f"cannot escalate from {_str(_g(record, "state"))}")
    bad = _bad_now(_g(input, "now"))
    if bad:
        return bad
    if _reason_bad(_g(input, "reason")):
        return _refuse("invalid_input", "an escalation needs a reason")
    cct = _g(input, "correctionCandidateTree")
    if _opt_tree_bad(cct):
        return _refuse("invalid_input", "correctionCandidateTree must be a 40 or 64 hex tree id")
    if cct is not _U and "correction_target_identity" not in record:
        return _refuse("invalid_input", "correctionCandidateTree needs a record with a correction target")
    nxt = _copy(record)
    # An escalation after a validated correction binds the corrected candidate too; without a known corrected tree it keeps the reviewed one.
    if _g(record, "state") == "validating":
        _adopt_corrected(nxt, record, None if cct is _U else cct)
    nxt["state"] = "escalated"
    nxt["escalation_reason"] = input["reason"]
    nxt["updated_at"] = input["now"]
    return {"ok": True, "record": _seal(nxt)}


def invalidate(record: StateRecord, input: dict) -> Outcome:
    if _g(record, "state") == "approved" and _truthy(_g(record, "burned")):
        return _refuse("already_burned", "a burned approval cannot be invalidated")
    if _g(record, "state") == "escalated" or _g(record, "state") == "invalidated":
        return _refuse("illegal_state", f"cannot invalidate from {_str(_g(record, "state"))}")
    bad = _bad_now(_g(input, "now"))
    if bad:
        return bad
    if _reason_bad(_g(input, "reason")):
        return _refuse("invalid_input", "an invalidation needs a reason")
    nxt = _copy(record)
    nxt["state"] = "invalidated"
    for k in ("approved_ack_token_hash", "evidence_hash", "ledger_hash", "actual_correction_lines", "refuted_finding_ids", "correction_target_identity", "correction_candidate_tree"):
        nxt.pop(k, None)
    nxt["fix_finding_ids"] = []
    nxt["correction_attempts"] = 0
    if "original_target_identity" in nxt and "original_candidate_tree" in nxt:
        nxt["target_identity"] = nxt["original_target_identity"]
        nxt["candidate_tree"] = nxt["original_candidate_tree"]
    nxt.pop("original_target_identity", None)
    nxt.pop("original_candidate_tree", None)
    nxt["admitted_role_results"] = [e for e in nxt["admitted_role_results"] if e.get("role") == "lens"]
    nxt["invalidation_reason"] = input["reason"]
    nxt["updated_at"] = input["now"]
    return {"ok": True, "record": _seal(nxt)}


def burn(record: StateRecord, input: dict) -> Outcome:
    """Spends the approval: the raw token must hash to the stored hash (constant-time compare)."""
    if _g(record, "state") != "approved":
        return _refuse("illegal_state", f"cannot burn from {_str(_g(record, "state"))}")
    if _truthy(_g(record, "burned")):
        return _refuse("already_burned", "this approval was already burned")
    bad = _bad_now(_g(input, "now"))
    if bad:
        return bad
    token = _g(input, "token")
    if not isinstance(token, str) or not _TOKEN_RE.fullmatch(token):
        return _refuse("token_malformed", "the acknowledgement token must be 64 lowercase hex characters")
    stored_hash = record.get("approved_ack_token_hash")
    stored = ("" if stored_hash is None else stored_hash).encode("utf-8")
    given = _token_hash_of(token).encode("utf-8")
    if len(stored) != len(given) or not hmac.compare_digest(stored, given):
        return _refuse("token_mismatch", "the acknowledgement token does not match this approval")
    nxt = _copy(record)
    nxt["burned"] = True
    nxt["approved_revision"] = record["revision"]
    nxt["updated_at"] = input["now"]
    nxt["burn_receipt"] = domain_hash("review-burn-receipt", 1, {"lineage_id": record["lineage_id"], "token_hash": stored_hash, "burned_at": input["now"]})
    return {"ok": True, "record": _seal(nxt)}
