"""Capture + correction (port of v9 review/capture.ts): admits reviewer results into the authority and drives the review to its
verdict.

Flow: lens results (one per selected lens, bound to their artifact subject) -> when every lens is admitted the review settles:
nothing severe blocks -> approved (one-shot token returned once); candidate-caused severe findings -> correction_required with the
frozen ledger; severe findings of unknown causality or insufficient evidence -> escalated. An optional refuter batch can refute
blocking findings before the correction is opened (`awaitRefuter`). The single correction is planned (`plan_correction`), edited by
the user/agent, then checked against its budget and scope (`begin_correction_validation`) and judged by a targeted validator
(`capture_validator_result`): approved or escalated. Every admission is ONE store CAS (`update_state`).

Python port conventions: v9's functions are `async` only because its store is; the Python store is synchronous, so these are plain
functions (no concurrency is observable: the CAS and the store lock serialize writers, threads included). Records, results, `input`,
`opts` and `corrected` are plain dicts with v9's keys (`opts`: `awaitRefuter`, `now` and `randomToken` callables). A status is
`{"ok": True, "state", "next", "revision", "record", "pending_lenses", "ackToken"?, "pending_refutation"?}`; a refusal is
`{"ok": False, "code", "message", "errors"?, "currentRevision"?}`. `result_schema_errors` is a dict of the three validators
(v9 `resultSchemaErrors.lens`...). Reviewer results are validated against embedded copies of the provider-mirror v1.6.0 schemas.
Public API: `EMBEDDED_RESULT_SCHEMAS`, `result_schema_errors`, `capture_lens_result`, `complete_review`, `capture_refuter_result`,
`plan_correction`, `begin_correction_validation`, `preview_correction_validation`, `capture_validator_result`, `capture_correction_result`.
"""
import re
from typing import Any, Callable

from .ack import _iso_now
from .artifact import (
    artifact_subject_for,
    artifact_subject_problems,
    finding_path,
    manifest_for,
    refuter_request_hash,
    targeted_validation_request_hash,
    tree_diff_paths,
)
from .canonical import _js_string, domain_hash
from .lineage import has_role, lenses_pending
from .schema import ValidateOptions, validate
from .snapshot import SnapshotError, count_changed_lines
from .state import (
    LENSES,
    MAX_ADMITTED_ROLE_RESULTS,
    MAX_CORRECTION_ATTEMPTS,
    RangeError,
    _sorted_strs,
    admit_lens_result,
    admit_refuter_result,
    admit_validator_result,
    approve,
    begin_validation,
    blocking_finding_ids,
    escalate,
    finding_id_prefix_for_lens,
    inconclusive_finding_ids,
    reopen_correction,
    require_correction,
)
from .store import StoreConcurrentUpdateError, StoreTransitionRefusedError, read_state, update_state

# Embedded copies of the provider-mirror v1.6.0 result schemas (only $id and title renamed); test_capture.py pins them to the
# vendored corpus under test-fixtures/review/vendor/provider-mirror.
LENS_SCHEMA: dict = {'$schema': 'https://json-schema.org/draft/2020-12/schema',
 '$id': 'https://odd-claude.dev/schema/review/reviewer/v1',
 'title': 'odd-claude reviewer result',
 'type': 'object',
 'additionalProperties': False,
 'required': ['subject_hash', 'inspection', 'findings', 'evidence'],
 'properties': {'subject_hash': {'type': 'string', 'pattern': '^sha256:[0-9a-f]{64}$'},
                'inspection': {'type': 'object',
                               'additionalProperties': False,
                               'required': ['status', 'paths'],
                               'allOf': [{'if': {'properties': {'status': {'const': 'unavailable'}}, 'required': ['status']},
                                          'then': {'required': ['reason']}}],
                               'properties': {'status': {'type': 'string',
                                                         'enum': ['completed', 'unavailable'],
                                                         'description': '"completed" asserts every changed_path_manifest path was actually '
                                                                        'inspected. "unavailable" asserts the candidate could not be '
                                                                        'inspected at all and requires a non-empty reason; this is the '
                                                                        'typed admission-completeness signal; evidence prose is not a '
                                                                        'substitute for it.'},
                                              'paths': {'type': 'array',
                                                        'description': 'Complete unique unordered set of every changed_path_manifest.path '
                                                                       'when status is "completed"; empty when status is "unavailable".',
                                                        'uniqueItems': True,
                                                        'items': {'type': 'string', 'minLength': 1}},
                                              'reason': {'type': 'string',
                                                         'minLength': 1,
                                                         'description': 'Required and non-empty only when status is "unavailable": why the '
                                                                        'candidate could not be inspected.'}}},
                'lens': {'type': 'string',
                         'description': 'Optional selected lens binding. Omission canonicalizes to the selected subject lens.',
                         'enum': ['risk',
                                  'resilience',
                                  'readability',
                                  'reliability',
                                  'review-risk',
                                  'review-resilience',
                                  'review-readability',
                                  'review-reliability']},
                'findings': {'type': 'array',
                             'items': {'type': 'object',
                                       'additionalProperties': False,
                                       'required': ['location', 'severity', 'claim', 'proof_refs'],
                                       'allOf': [{'if': {'properties': {'severity': {'enum': ['BLOCKER', 'CRITICAL']}},
                                                         'required': ['severity']},
                                                  'then': {'required': ['evidence_class', 'causal_disposition']}}],
                                       'properties': {'id': {'type': 'string',
                                                             'pattern': '^R[1-4]-[A-Za-z0-9][A-Za-z0-9._-]*$',
                                                             'description': 'Optional explicit ID; omit it to receive a native-assigned '
                                                                            'ID. When present it must carry the prefix bound to the '
                                                                            'selected lens, not the selection order: review-risk=R1-, '
                                                                            'review-readability=R2-, review-reliability=R3-, '
                                                                            'review-resilience=R4-.'},
                                                      'lens': {'type': 'string',
                                                               'enum': ['risk',
                                                                        'resilience',
                                                                        'readability',
                                                                        'reliability',
                                                                        'review-risk',
                                                                        'review-resilience',
                                                                        'review-readability',
                                                                        'review-reliability']},
                                                      'location': {'type': 'string',
                                                                   'description': 'One canonical repository-relative path:line or '
                                                                                  'inclusive path:start-end span.',
                                                                   'pattern': '^.+:[1-9][0-9]*(?:-[1-9][0-9]*)?$'},
                                                      'severity': {'type': 'string',
                                                                   'enum': ['BLOCKER', 'CRITICAL', 'WARNING', 'SUGGESTION']},
                                                      'claim': {'type': 'string', 'minLength': 1},
                                                      'proof_refs': {'type': 'array',
                                                                     'minItems': 1,
                                                                     'items': {'type': 'string',
                                                                               'pattern': '\\S',
                                                                               'not': {'pattern': '^\\s*(?:[nN]/[aA]|[nN][aA]|[nN][oO][nN][eE]|[tT][oO][dD][oO]|[tT][bB][dD]|[pP][aA][sS][sS]|[pP][aA][sS][sS][eE][dD]|[sS][uU][cC][cC][eE][sS][sS]|[pP][lL][aA][cC][eE][hH][oO][lL][dD][eE][rR])\\s*$'}}},
                                                      'evidence_class': {'type': 'string',
                                                                         'enum': ['deterministic', 'inferential', 'insufficient']},
                                                      'causal_disposition': {'type': 'string',
                                                                             'enum': ['introduced',
                                                                                      'behavior-activated',
                                                                                      'worsened',
                                                                                      'pre-existing',
                                                                                      'base-only',
                                                                                      'unknown']}}}},
                'evidence': {'type': 'array',
                             'minItems': 1,
                             'items': {'type': 'string',
                                       'pattern': '\\S',
                                       'not': {'pattern': '^\\s*(?:[nN]/[aA]|[nN][aA]|[nN][oO][nN][eE]|[tT][oO][dD][oO]|[tT][bB][dD]|[pP][aA][sS][sS]|[pP][aA][sS][sS][eE][dD]|[sS][uU][cC][cC][eE][sS][sS]|[pP][lL][aA][cC][eE][hH][oO][lL][dD][eE][rR])\\s*$'}}}},
 'examples': [{'subject_hash': 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
               'inspection': {'status': 'completed', 'paths': ['internal/example.go']},
               'findings': [],
               'evidence': ['reviewed the complete candidate scope']},
              {'subject_hash': 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
               'inspection': {'status': 'unavailable',
                              'paths': [],
                              'reason': 'the immutable inspection command timed out before any path could be read'},
               'findings': [],
               'evidence': ['inspection was unavailable; see inspection.reason']}]}

REFUTER_SCHEMA: dict = {'$schema': 'https://json-schema.org/draft/2020-12/schema',
 '$id': 'https://odd-claude.dev/schema/review/refuter/v1',
 'title': 'odd-claude refuter result',
 'type': 'object',
 'additionalProperties': False,
 'required': ['refuter_request_hash', 'results'],
 'properties': {'refuter_request_hash': {'$ref': '#/$defs/sha256'},
                'results': {'type': 'array',
                            'items': {'type': 'object',
                                      'additionalProperties': False,
                                      'required': ['finding_id', 'outcome', 'proof_refs'],
                                      'properties': {'finding_id': {'type': 'string'},
                                                     'outcome': {'type': 'string', 'enum': ['corroborated', 'refuted', 'inconclusive']},
                                                     'proof_refs': {'type': 'array',
                                                                    'minItems': 1,
                                                                    'items': {'type': 'string', 'pattern': '\\S'}}}}}},
 '$defs': {'sha256': {'type': 'string', 'pattern': '^sha256:[0-9a-f]{64}$'}},
 'examples': [{'refuter_request_hash': 'sha256:0000000000000000000000000000000000000000000000000000000000000000', 'results': []}]}

VALIDATOR_SCHEMA: dict = {'$schema': 'https://json-schema.org/draft/2020-12/schema',
 '$id': 'https://odd-claude.dev/schema/review/validator/v1',
 'title': 'odd-claude targeted validator result',
 'type': 'object',
 'additionalProperties': False,
 'required': ['targeted_validation_request_hash', 'correction_target_identity', 'original_criteria', 'correction_regression', 'follow_ups'],
 'properties': {'targeted_validation_request_hash': {'$ref': '#/$defs/sha256'},
                'correction_target_identity': {'$ref': '#/$defs/sha256'},
                'original_criteria': {'$ref': '#/$defs/check'},
                'correction_regression': {'$ref': '#/$defs/check'},
                'follow_ups': {'type': 'array',
                               'items': {'type': 'object',
                                         'additionalProperties': False,
                                         'required': ['observation', 'proof_refs'],
                                         'properties': {'observation': {'type': 'string'},
                                                        'proof_refs': {'type': 'array',
                                                                       'minItems': 1,
                                                                       'items': {'type': 'string', 'pattern': '\\S'}}}}}},
 'allOf': [{'if': {'properties': {'correction_regression': {'type': 'object',
                                                            'properties': {'passed': {'const': False}},
                                                            'required': ['passed']}},
                   'required': ['correction_regression']},
            'then': {'properties': {'correction_regression': {'type': 'object',
                                                              'properties': {'regressions': {'minItems': 1}},
                                                              'required': ['regressions']}}}}],
 '$defs': {'sha256': {'type': 'string', 'pattern': '^sha256:[0-9a-f]{64}$'},
           'check': {'type': 'object',
                     'additionalProperties': False,
                     'required': ['passed', 'evidence'],
                     'properties': {'passed': {'type': 'boolean',
                                               'description': 'true means the named check passed; false means the named check failed.'},
                                    'evidence': {'type': 'array', 'minItems': 1, 'items': {'type': 'string'}},
                                    'regressions': {'type': 'array',
                                                    'items': {'$ref': '#/$defs/regression'},
                                                    'description': 'Required with at least one entry when this is correction_regression '
                                                                   'and passed is false: one entry per observed regression, omitted or '
                                                                   'empty otherwise.'},
                                    'inspection': {'$ref': '#/$defs/inspection'}},
                     'allOf': [{'if': {'properties': {'inspection': {'type': 'object',
                                                                     'properties': {'status': {'const': 'unavailable'}},
                                                                     'required': ['status']}},
                                       'required': ['inspection']},
                                'then': {'properties': {'inspection': {'type': 'object', 'required': ['reason']}}}}]},
           'inspection': {'type': 'object',
                          'additionalProperties': False,
                          'required': ['status'],
                          'properties': {'status': {'type': 'string',
                                                    'enum': ['completed', 'unavailable'],
                                                    'description': "completed means this check's verdict came from actually reading the "
                                                                   'frozen candidate trees. unavailable means it did not, and this check '
                                                                   'produced no verdict.'},
                                         'reason': {'type': 'string',
                                                    'minLength': 1,
                                                    'description': 'Required when status is unavailable: why the frozen candidate trees '
                                                                   'could not be read.'}},
                          'description': 'Optional. Omit this field entirely when inspection completed normally -- every check that '
                                         'predates this field already assumed that default. Never infer unavailable from evidence wording; '
                                         'only this typed field marks a check inconclusive.'},
           'regression': {'type': 'object',
                          'additionalProperties': False,
                          'required': ['location', 'claim', 'proof_refs'],
                          'properties': {'id': {'type': 'string',
                                                'description': 'Optional explicit ID; omit it to receive a native-assigned ID.'},
                                         'location': {'type': 'string',
                                                      'description': 'One canonical repository-relative path:line or inclusive '
                                                                     'path:start-end span.',
                                                      'pattern': '^.+:[1-9][0-9]*(?:-[1-9][0-9]*)?$'},
                                         'claim': {'type': 'string', 'minLength': 1},
                                         'proof_refs': {'type': 'array', 'minItems': 1, 'items': {'type': 'string', 'pattern': '\\S'}}}}},
 'examples': [{'targeted_validation_request_hash': 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
               'correction_target_identity': 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
               'original_criteria': {'passed': True, 'evidence': ['acceptance test passed']},
               'correction_regression': {'passed': True, 'evidence': ['regression test passed']},
               'follow_ups': []}]}

EMBEDDED_RESULT_SCHEMAS = {"lens": LENS_SCHEMA, "refuter": REFUTER_SCHEMA, "validator": VALIDATOR_SCHEMA}

_UNDEF: Any = object()  # JS `undefined`: a key that is not there


def _get(obj: Any, key: str) -> Any:
    """JS `obj?.key` (undefined when `obj` is not an object or has no such key)."""
    return obj.get(key, _UNDEF) if isinstance(obj, dict) else _UNDEF


def _str(v: Any) -> str:
    return "undefined" if v is _UNDEF else _js_string(v)


def _load(_id: str) -> Any:
    raise Exception("embedded schemas have no external references")


def _schema_errors(schema: dict, value: Any, name: str) -> list[str]:
    if value is _UNDEF:  # `typeOf(undefined)`: the only error a missing result can produce against these `type: object` schemas
        return [": expected type object, got undefined"]
    return validate(schema, value, ValidateOptions(base=f"embedded://{name}", load=_load))


#: Errors of a lens / refuter / targeted-validator result against the embedded provider-mirror schema.
result_schema_errors: dict[str, Callable[[Any], list[str]]] = {
    "lens": lambda value: _schema_errors(LENS_SCHEMA, value, "lens"),
    "refuter": lambda value: _schema_errors(REFUTER_SCHEMA, value, "refuter"),
    "validator": lambda value: _schema_errors(VALIDATOR_SCHEMA, value, "targeted-validator"),
}


def _refusal(code: str, message: str, **extra: Any) -> dict:
    return {"ok": False, "code": code, "message": message, **extra}


def _clock(opts: dict | None) -> str:
    now = (opts or {}).get("now")
    return now() if now is not None else _iso_now()


def _next_of(record: dict) -> str:
    s = record["state"]
    if s in ("approved", "correction_required", "validating"):
        return s
    return "escalated" if s in ("escalated", "invalidated") else "collect"


def _status_of(record: dict, ack_token: Any = None) -> dict:
    status = {"ok": True, "state": record["state"], "next": _next_of(record), "revision": record["revision"], "record": record, "pending_lenses": lenses_pending(record)}
    if ack_token is not None:
        status["ackToken"] = ack_token
    if record["state"] == "reviewing" and len(status["pending_lenses"]) == 0:
        blocking = blocking_finding_ids(record)
        if len(blocking) > 0:
            status["pending_refutation"] = blocking
    return status


def _commit(run: Callable[[], dict]) -> dict:
    """Maps the store's typed failures to capture refusals; anything else (not found, corrupt, I/O) propagates."""
    try:
        return run()
    except StoreConcurrentUpdateError as e:
        return _refusal("concurrent_update", str(e), currentRevision=e.current_revision)
    except StoreTransitionRefusedError as e:
        return _refusal(e.refusal["code"], e.refusal["message"])


def _finish(done: dict) -> dict:
    return done if "record" not in done else _status_of(done["record"], done.get("ackToken"))


def _settle_review(record: dict, now: str, await_refuter: bool, random_token: Callable[[], str] | None = None) -> dict:
    """Settles a fully reviewed record. Inconclusive severe findings escalate; nothing blocking approves (follow-ups do not block);
    blocking findings open a correction, unless the caller waits for an optional refuter batch."""
    inconclusive = inconclusive_finding_ids(record)
    if len(inconclusive) > 0:
        return escalate(record, {"now": now, "reason": f"severe findings with unknown causality or insufficient evidence: {', '.join(inconclusive)}"})
    blocking = blocking_finding_ids(record)
    if len(blocking) == 0:
        return approve(record, {"now": now, "randomToken": random_token})
    if await_refuter and not has_role(record, "refuter"):
        return {"ok": True, "record": record}
    correction = require_correction(record, {"now": now, "fixFindingIds": blocking})
    if correction["ok"]:
        return correction
    return escalate(record, {"now": now, "reason": correction["refusal"]["message"]})


def _normalize_lens(lens: Any) -> str:
    return re.sub(r"^review-", "", lens, count=1) if isinstance(lens, str) else ""


def _map_findings(lens: str, result: dict) -> list[dict] | dict:
    prefix = finding_id_prefix_for_lens(lens)
    explicit = {f["id"] for f in result["findings"] if isinstance(f.get("id"), str)}
    counter = 0
    out: list[dict] = []
    for f in result["findings"]:
        if "lens" in f and _normalize_lens(f["lens"]) != lens:
            return _refusal("binding_drift", f"a finding is bound to lens {f['lens']}, not {lens}")
        id_ = f.get("id")
        if id_ is None:
            while True:
                counter += 1
                id_ = f"{prefix}{counter}"
                if id_ not in explicit:
                    break
            explicit.add(id_)
        out.append({
            "id": id_, "lens": lens, "severity": f["severity"], "location": f["location"], "claim": f["claim"],
            **({"evidence_class": f["evidence_class"]} if "evidence_class" in f else {}),
            **({"causal_disposition": f["causal_disposition"]} if "causal_disposition" in f else {}),
        })
    return out


def _stale(current: dict) -> dict:
    return _refusal("concurrent_update", "the review changed since the expected revision", currentRevision=current["revision"])


# ---- lens ----


def capture_lens_result(common_dir: str, lineage: str, expected_revision: str, input: dict, opts: dict | None = None) -> dict:
    """`input`: `{"lens", "subject", "result"}` (the subject the reviewer was handed, and its lens-schema result)."""
    opts = opts or {}
    current = read_state(common_dir, lineage)
    if current["revision"] != expected_revision:
        return _stale(current)
    if current["state"] != "reviewing":
        return _refusal("illegal_state", f"cannot capture a lens result from {current['state']}")
    lens = _normalize_lens(_get(input, "lens"))
    if lens not in LENSES or lens not in current["selected_lenses"]:
        return _refusal("invalid_input", f"lens {_str(_get(input, 'lens'))} is not selected for this review")
    if any(e.get("role") == "lens" and e.get("lens") == lens for e in current["admitted_role_results"]):
        return _refusal("lens_already_admitted", f"lens {lens} already has an admitted result")
    if len(current["admitted_role_results"]) >= MAX_ADMITTED_ROLE_RESULTS:
        return _refusal("capacity_exceeded", "admitted role results are full")

    raw = _get(input, "result")
    errors = _schema_errors(LENS_SCHEMA, raw, "lens")
    if len(errors) > 0:
        return _refusal("schema_invalid", "the lens result does not match the lens schema", errors=errors)
    result = raw
    if "lens" in result and _normalize_lens(result["lens"]) != lens:
        return _refusal("binding_drift", f"the result is bound to lens {result['lens']}, not {lens}")

    subject = _get(input, "subject")
    problems = artifact_subject_problems(None if subject is _UNDEF else subject)
    if len(problems) > 0:
        return _refusal("binding_drift", "the presented artifact subject is malformed", errors=problems)
    try:
        manifest = manifest_for(common_dir, current)
    except SnapshotError as e:
        return _refusal("snapshot_unavailable", f"the frozen trees cannot be read: {e}")
    expected = artifact_subject_for(current, lens, manifest["digest"])
    if not expected:
        return _refusal("invalid_input", f"lens {lens} is not selected for this review")
    if subject["subject_hash"] != expected["subject_hash"] or result["subject_hash"] != expected["subject_hash"]:
        return _refusal("binding_drift", "the result does not echo this lineage's artifact subject for the lens")

    if result["inspection"]["status"] == "unavailable":
        return _refusal("inspection_unavailable", result["inspection"].get("reason") or "the candidate could not be inspected")
    inspected = set(result["inspection"]["paths"])
    if len(inspected) != len(manifest["paths"]) or any(p not in inspected for p in manifest["paths"]):
        return _refusal("inspection_incomplete", "inspection.paths must be exactly the changed-path manifest")

    findings = _map_findings(lens, result)
    if not isinstance(findings, list):
        return findings
    result_hash = domain_hash("lens-result", 1, {"lineage_id": lineage, "lens": lens, "result": raw})
    now = _clock(opts)

    def transition(record: dict) -> dict:
        admitted = admit_lens_result(record, {"lens": lens, "findings": findings, "resultHash": result_hash, "artifactDigest": expected["subject_hash"], "now": now})
        if not admitted["ok"]:
            return admitted
        if len(lenses_pending(admitted["record"])) > 0:
            return admitted
        return _settle_review(admitted["record"], now, opts.get("awaitRefuter") is True, opts.get("randomToken"))

    return _finish(_commit(lambda: update_state(common_dir, lineage, expected_revision, transition)))


def complete_review(common_dir: str, lineage: str, expected_revision: str, opts: dict | None = None) -> dict:
    """Settles a fully reviewed lineage that was held for a refuter (skip the refuter: correction, approval or escalation)."""
    opts = opts or {}
    now = _clock(opts)

    def transition(record: dict) -> dict:
        if record["state"] != "reviewing":
            return {"ok": False, "refusal": {"code": "illegal_state", "message": f"cannot complete a review from {record['state']}"}}
        if len(lenses_pending(record)) > 0:
            return {"ok": False, "refusal": {"code": "lenses_incomplete", "message": "every selected lens result must be admitted first"}}
        return _settle_review(record, now, False, opts.get("randomToken"))

    return _finish(_commit(lambda: update_state(common_dir, lineage, expected_revision, transition)))


# ---- refuter ----


def capture_refuter_result(common_dir: str, lineage: str, expected_revision: str, input: dict, opts: dict | None = None) -> dict:
    """Admits the optional refuter batch. Refuted findings drop out of the blocking set; corroborated, inconclusive and unanswered
    ones stay blocking. Then the review settles (approval when nothing blocks, else the correction)."""
    opts = opts or {}
    current = read_state(common_dir, lineage)
    if current["revision"] != expected_revision:
        return _stale(current)
    if current["state"] != "reviewing":
        return _refusal("illegal_state", f"cannot capture a refuter result from {current['state']}")
    if len(lenses_pending(current)) > 0:
        return _refusal("lenses_incomplete", "every selected lens result must be admitted before a refuter result")
    if has_role(current, "refuter"):
        return _refusal("refuter_already_admitted", "a refuter result is already admitted")
    if len(current["admitted_role_results"]) >= MAX_ADMITTED_ROLE_RESULTS:
        return _refusal("capacity_exceeded", "admitted role results are full")

    raw = _get(input, "result")
    errors = _schema_errors(REFUTER_SCHEMA, raw, "refuter")
    if len(errors) > 0:
        return _refusal("schema_invalid", "the refuter result does not match the refuter schema", errors=errors)
    result = raw
    request_hash = refuter_request_hash(current)
    if result["refuter_request_hash"] != request_hash:
        return _refusal("binding_drift", "the result does not echo this review's refuter request")
    blocking = set(blocking_finding_ids(current))
    seen: set[str] = set()
    for r in result["results"]:
        if r["finding_id"] in seen:
            return _refusal("invalid_input", f"the refuter answered {r['finding_id']} twice")
        seen.add(r["finding_id"])
        if r["finding_id"] not in blocking:
            return _refusal("unknown_finding", f"{r['finding_id']} is not a blocking severe finding of this review")
    refuted = _sorted_strs([r["finding_id"] for r in result["results"] if r["outcome"] == "refuted"])
    result_hash = domain_hash("refuter-result", 1, {"lineage_id": lineage, "result": raw})
    now = _clock(opts)

    def transition(record: dict) -> dict:
        admitted = admit_refuter_result(record, {"resultHash": result_hash, "artifactDigest": request_hash, "refutedFindingIds": refuted, "now": now})
        if not admitted["ok"]:
            return admitted
        return _settle_review(admitted["record"], now, False, opts.get("randomToken"))

    return _finish(_commit(lambda: update_state(common_dir, lineage, expected_revision, transition)))


# ---- correction ----


def plan_correction(common_dir: str, lineage: str) -> dict:
    """The frozen blocking findings, the line budget, the attempts left and the only paths a correction may touch."""
    record = read_state(common_dir, lineage)
    if record["state"] != "correction_required":
        return _refusal("illegal_state", f"no correction is pending in state {record['state']}")
    ids = set(record["fix_finding_ids"])
    findings = [dict(f) for f in record["findings"] if f["id"] in ids]
    paths: set[str] = set()
    for f in findings:
        p = finding_path(f["location"])
        if p is not None:
            paths.add(p)
    return {
        "ok": True, "lineage_id": record["lineage_id"], "revision": record["revision"], "findings": findings,
        "ledger_hash": record.get("ledger_hash") if record.get("ledger_hash") is not None else "",
        "budget": record["correction_budget"], "attempts_remaining": max(0, MAX_CORRECTION_ATTEMPTS - record["correction_attempts"]),
        "allowed_paths": _sorted_strs(list(paths)),
    }


def _check_correction(repo: dict, current: dict, corrected: Any) -> dict:
    """The budget and scope checks of a correction against the frozen findings (no write): `{"ok": True, "lines"}` or a refusal."""
    common_dir = repo["commonDir"]
    if current["state"] != "correction_required":
        return _refusal("illegal_state", f"cannot begin validation from {current['state']}")
    tree, identity = _get(corrected, "candidateTree"), _get(corrected, "identity")
    if not isinstance(tree, str) or not isinstance(identity, str):
        return _refusal("invalid_input", "the corrected candidate needs a tree and an identity")
    # Reference engine (compact.go: "compact correction has an unchanged candidate tree"): an unchanged candidate is not a
    # correction, and approving it would consume the defective original.
    if tree == current["candidate_tree"] or identity == current["target_identity"]:
        return _refusal("correction_unavailable", "the corrected candidate is unchanged: make a correction before validating")
    try:
        touched = tree_diff_paths(common_dir, current["candidate_tree"], tree)
        lines = count_changed_lines(repo, current["candidate_tree"], tree)
    except (SnapshotError, RangeError) as e:
        return _refusal("snapshot_unavailable", f"the corrected candidate cannot be compared: {e}")
    ids = set(current["fix_finding_ids"])
    allowed: set[str] = set()
    for f in current["findings"]:
        if f["id"] in ids:
            p = finding_path(f["location"])
            if p is not None:
                allowed.add(p)
    outside = [p for p in touched if p not in allowed]
    if len(outside) > 0:
        return _refusal("correction_out_of_scope", f"the correction touches paths outside the frozen findings: {', '.join(outside)}", errors=outside)
    return {"ok": True, "lines": lines}


def _begin_input(corrected: dict, lines: int, now: str) -> dict:
    return {"now": now, "actualCorrectionLines": lines, "correctionTargetIdentity": corrected["identity"], "correctionCandidateTree": corrected["candidateTree"]}


def begin_correction_validation(repo: dict, lineage: str, expected_revision: str, corrected: dict, opts: dict | None = None) -> dict:
    """Checks the corrected candidate against the frozen correction (budget in changed lines against the ORIGINAL candidate; only
    paths of the frozen findings) and opens validation. One correction attempt is consumed here."""
    common_dir = repo["commonDir"]
    current = read_state(common_dir, lineage)
    if current["revision"] != expected_revision:
        return _stale(current)
    checked = _check_correction(repo, current, corrected)
    if not checked["ok"]:
        return checked
    now = _clock(opts)
    return _finish(_commit(lambda: update_state(common_dir, lineage, expected_revision, lambda record: begin_validation(record, _begin_input(corrected, checked["lines"], now)))))


def preview_correction_validation(repo: dict, lineage: str, expected_revision: str, corrected: dict, opts: dict | None = None) -> dict:
    """What `capture_correction_result` would validate, with NO write: the budget and scope checks and the in-memory validating
    record (its targeted-validation request hash is what the validator echoes). A forecast uses this, so it never spends a
    correction attempt. Returns `{"ok": True, "record"}` or a refusal."""
    current = read_state(repo["commonDir"], lineage)
    if current["revision"] != expected_revision:
        return _stale(current)
    checked = _check_correction(repo, current, corrected)
    if not checked["ok"]:
        return checked
    began = begin_validation(current, _begin_input(corrected, checked["lines"], _clock(opts)))
    if not began["ok"]:
        return _refusal(began["refusal"]["code"], began["refusal"]["message"])
    return {"ok": True, "record": began["record"]}


# ---- targeted validator ----


def _judge_validator_result(current: dict, lineage: str, input: Any) -> dict:
    """Checks a validator result against a validating record (schema, echoed request and target, inspection). No write."""
    raw = _get(input, "result")
    errors = _schema_errors(VALIDATOR_SCHEMA, raw, "targeted-validator")
    if len(errors) > 0:
        return _refusal("schema_invalid", "the validator result does not match the targeted-validator schema", errors=errors)
    result = raw
    request_hash = targeted_validation_request_hash(current)
    if request_hash is None:
        return _refusal("binding_drift", "this review has no correction target to validate")
    if result["targeted_validation_request_hash"] != request_hash or result["correction_target_identity"] != current.get("correction_target_identity"):
        return _refusal("binding_drift", "the result does not echo this correction's validation request and target")
    for name in ("original_criteria", "correction_regression"):
        inspection = result[name].get("inspection")
        if inspection is not None and inspection.get("status") == "unavailable":
            return _refusal("inspection_unavailable", f"{name}: {inspection.get('reason') or 'the corrected candidate could not be inspected'}")
    return {
        "ok": True, "requestHash": request_hash, "resultHash": domain_hash("validator-result", 1, {"lineage_id": lineage, "result": raw}),
        "passed": result["original_criteria"]["passed"] and result["correction_regression"]["passed"],
        "failure": "the targeted validator found the blocking findings unresolved" if not result["original_criteria"]["passed"] else "the targeted validator found regressions introduced by the correction",
    }


def capture_validator_result(common_dir: str, lineage: str, expected_revision: str, input: dict, opts: dict | None = None) -> dict:
    """Admits the targeted validator result: approved when every blocking finding is resolved without regression, else escalated.
    `input`: `{"result", "correctionCandidateTree"?}` (the frozen tree of the judged candidate completes a record that lacks it)."""
    opts = opts or {}
    current = read_state(common_dir, lineage)
    if current["revision"] != expected_revision:
        return _stale(current)
    if current["state"] != "validating":
        return _refusal("illegal_state", f"cannot capture a validator result from {current['state']}")
    if has_role(current, "validator"):
        return _refusal("validator_already_admitted", "a validator result is already admitted")
    if len(current["admitted_role_results"]) >= MAX_ADMITTED_ROLE_RESULTS:
        return _refusal("capacity_exceeded", "admitted role results are full")

    judged = _judge_validator_result(current, lineage, input)
    if not judged["ok"]:
        return judged
    now = _clock(opts)
    request_hash, result_hash, passed, failure = judged["requestHash"], judged["resultHash"], judged["passed"], judged["failure"]
    tree = _get(input, "correctionCandidateTree")
    tree_input = {} if tree is _UNDEF else {"correctionCandidateTree": tree}

    def transition(record: dict) -> dict:
        admitted = admit_validator_result(record, {"resultHash": result_hash, "artifactDigest": request_hash, "now": now})
        if not admitted["ok"]:
            return admitted
        if passed:
            return approve(admitted["record"], {"now": now, "randomToken": opts.get("randomToken"), **tree_input})
        # A failed validation with attempts left reopens a correction; the last attempt escalates.
        reopened = reopen_correction(record, {"now": now, **tree_input})
        return reopened if reopened["ok"] else escalate(admitted["record"], {"now": now, "reason": failure, **tree_input})

    return _finish(_commit(lambda: update_state(common_dir, lineage, expected_revision, transition)))


def capture_correction_result(repo: dict, lineage: str, expected_revision: str, corrected: dict, input: dict, opts: dict | None = None) -> dict:
    """Opens validation AND admits the validator result in ONE transition from `correction_required` (reference engine: the attempt
    is recorded together with the validator's outcome). Nothing is written when the correction is refused or the result does not
    match; a runner that never answered never spends a correction attempt. The validator must echo the request hash of
    `preview_correction_validation` for the same corrected candidate."""
    opts = opts or {}
    common_dir = repo["commonDir"]
    preview = preview_correction_validation(repo, lineage, expected_revision, corrected, opts)
    if not preview["ok"]:
        return preview
    judged = _judge_validator_result(preview["record"], lineage, input)
    if not judged["ok"]:
        return judged
    now = _clock(opts)
    request_hash, result_hash, passed, failure = judged["requestHash"], judged["resultHash"], judged["passed"], judged["failure"]
    lines = preview["record"].get("actual_correction_lines")
    lines = 0 if lines is None else lines

    def transition(record: dict) -> dict:
        began = begin_validation(record, _begin_input(corrected, lines, now))
        if not began["ok"]:
            return began
        admitted = admit_validator_result(began["record"], {"resultHash": result_hash, "artifactDigest": request_hash, "now": now})
        if not admitted["ok"]:
            return admitted
        if passed:
            return approve(admitted["record"], {"now": now, "randomToken": opts.get("randomToken")})
        reopened = reopen_correction(began["record"], {"now": now})
        return reopened if reopened["ok"] else escalate(admitted["record"], {"now": now, "reason": failure})

    return _finish(_commit(lambda: update_state(common_dir, lineage, expected_revision, transition)))
