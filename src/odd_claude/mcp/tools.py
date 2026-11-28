"""The review MCP tools (port of v9 mcp/tools.ts): thin adapters over the verified review modules. Nothing here decides review policy.

Rules every tool follows (as v9):
 - Input is validated against the tool's JSON schema (jsonschema.py) before anything runs; a violation is the typed tool error
   `invalid_input` listing the problems (never a protocol error, so the model can correct the call).
 - Routing comes only from `review_status` transitions. Consent is never answered here: `review_start` always relays (the consent envelope
   comes back untouched) and only `review_answer_consent`, which takes the human's explicit answer plus the exact target identity the
   question was asked for, records it. Exception (guidance only): a standing consent recorded in the feature document `## Log` lets the
   parent answer for that feature branch's work-unit commit candidates, never on its own judgment.
 - A direct start never duplicates a lineage waiting for its correction: `pending_correction_lineage` (run.py) is checked first and the
   pending lineage is returned as the typed error `correction_lineage_pending`.
 - Reviewer runs cost money: `review_run`, `review_capture` and `review_capture_group` return a forecast first and run reviewers only
   when called again with `reviewer_run_acknowledged: true` and the forecast's `reviewer_run_binding`.
 - Reviewers run through the injected runner (default: the isolated `claude -p` runner of review/runner.py).
 - Outputs are bounded (MAX_OUTPUT_BYTES), errors are typed (`{error:{code,message,...}}` with `isError: true`), nothing is reported to anyone.

Python port conventions: tools run synchronously (a call is one thread, see server_core); `args` are the parsed wire arguments (a missing
key is JS `undefined`); `ToolDeps` is a dict with v9's keys (`runner`, `riskAssessor`, `concurrency`, `modeOptions`); the signal is a
`run.AbortSignal`; a tool result is the MCP `{"content": [...], "isError"?: true}` dict."""
import re
from dataclasses import dataclass, field
from typing import Any, Callable

from ..lib.js import js_double, js_json_loads, js_keys, js_stringify, js_trim, utf16_head
from ..review.ack import AckRefusedError, acknowledge_approved
from ..review.capture import complete_review
from ..review.consent import REVIEW_CONTRACT, REVIEW_TOOL_NAMES, consent_binding
from ..review.contract import decode_binding, encode_ack_envelope, encode_capture_envelope, encode_start_envelope
from ..review.lock import StoreLockContended, StoreLockError
from ..review.mode import ReviewModeError, read_review_mode
from ..review.risk import assess_candidate, assess_risk
from ..review.run import pending_correction_lineage, run_review, validate_reviewer_options
from ..review.snapshot import SnapshotError, resolve_repository
from ..review.start import snapshot_target_of, start_review
from ..review.status import review_status
from ..review.store import (
    StoreAlreadyExistsError,
    StoreConcurrentUpdateError,
    StoreCorruptError,
    StoreInvalidLineageError,
    StoreInvalidRecordError,
    StoreIoError,
    StoreNotFoundError,
    StoreTransitionRefusedError,
    list_lineages,
    read_state,
)
from .jsonschema import JsonSchema, validate_schema

#: Largest tool result text (bytes). Bigger results become the typed error `output_too_large`.
MAX_OUTPUT_BYTES = 256 * 1024
MAX_PATHS = 200

ToolResult = dict
ToolDeps = dict


@dataclass
class ToolContext:
    deps: ToolDeps
    #: Aborted when the client cancels the request (a `run.AbortSignal`).
    signal: Any = None
    #: Directory used when a call gives no `cwd`.
    default_cwd: str = "."


@dataclass
class ToolDefinition:
    name: str
    description: str
    input_schema: JsonSchema
    annotations: dict
    run: Callable[[dict, ToolContext], ToolResult] = field(repr=False)


# ---- results ----


def _byte_length(text: str) -> int:
    return len(text.encode("utf-8", "surrogatepass"))


def ok(body: Any) -> ToolResult:
    text = js_stringify(body)
    if _byte_length(text) > MAX_OUTPUT_BYTES:
        return fail("output_too_large", f"the result is larger than {MAX_OUTPUT_BYTES} bytes and was dropped")
    return {"content": [{"type": "text", "text": text}]}


def fail(code: str, message: str, extra: dict | None = None) -> ToolResult:
    return {"content": [{"type": "text", "text": js_stringify({"error": {"code": code, "message": utf16_head(message, 1000), **(extra or {})}})}], "isError": True}


_STORE_ERRORS = (
    StoreInvalidLineageError, StoreNotFoundError, StoreAlreadyExistsError, StoreCorruptError, StoreConcurrentUpdateError,
    StoreTransitionRefusedError, StoreInvalidRecordError, StoreIoError, StoreLockContended, StoreLockError,
)


def error_result(e: BaseException) -> ToolResult:
    """Every failure becomes a typed tool error; unknown exceptions only expose their message."""
    if isinstance(e, SnapshotError):
        return fail("snapshot_error", str(e), {"detail": e.code})
    if isinstance(e, AckRefusedError):
        return fail(e.code, str(e))
    if isinstance(e, ReviewModeError):
        return fail("mode_error", str(e))
    if isinstance(e, (StoreNotFoundError, StoreInvalidLineageError)):
        return fail("unknown_lineage", str(e))
    if isinstance(e, _STORE_ERRORS):
        return fail("authority_error", str(e), {"detail": type(e).__name__})
    return fail("internal_error", str(e))


# ---- schema pieces ----

LINEAGE_PATTERN = "^[A-Za-z0-9._-]{1,128}$"
SHA_PATTERN = "^sha256:[0-9a-f]{64}$"
CWD: JsonSchema = {"type": "string", "minLength": 1, "maxLength": 4096, "description": "Absolute path of the repository (or a directory inside it). Defaults to the server's working directory."}
TARGET_PROPS: dict[str, JsonSchema] = {
    "cwd": CWD,
    "target": {"type": "string", "enum": ["current-changes", "base-diff"], "description": "What to review. Default current-changes."},
    "base_ref": {"type": "string", "minLength": 1, "maxLength": 256, "description": "Base ref for target base-diff (required there, rejected otherwise)."},
    "committed_only": {"type": "boolean", "description": "base-diff only: review the committed range, ignoring the worktree."},
    "projection": {"type": "string", "enum": ["workspace", "staged"], "description": "current-changes only. Default workspace."},
}
LENS_PROPS: dict[str, JsonSchema] = {
    "lenses": {"type": "array", "items": {"type": "string", "minLength": 1, "maxLength": 40}, "minItems": 1, "maxItems": 4, "description": "Explicit pertinent lenses (risk, resilience, readability, reliability), canonical order, no repeats; needs lenses_reason."},
    "lenses_reason": {"type": "string", "minLength": 1, "maxLength": 500},
    "locale": {"type": "string", "minLength": 2, "maxLength": 35, "pattern": "^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8})*$"},
}
RUN_PROPS: dict[str, JsonSchema] = {
    "model": {"type": "string", "enum": ["fable", "opus", "sonnet", "haiku"], "description": "Reviewer model family for every reviewer of this run. Omit it to follow the active model profile per role (balanced by default)."},
    "effort": {"type": "string", "enum": ["low", "medium", "high", "xhigh", "max"], "description": "Reviewer effort (needs a model; not for haiku)."},
    "timeout_ms": {"type": "integer", "minimum": 1000, "maximum": 7200000},
    "reviewer_run_acknowledged": {"type": "boolean", "description": "Authorizes the reviewer batch of the forecast named by reviewer_run_binding. Never set it before the user saw the forecast, unless a standing consent recorded in the feature document `## Log` covers that feature branch's work-unit commit candidates (never on your own judgment)."},
    "reviewer_run_binding": {"type": "string", "minLength": 1, "maxLength": 200, "description": "reviewer_run_binding of the forecast being acknowledged."},
}
DETAIL: JsonSchema = {"type": "string", "enum": ["concise", "full"], "description": "Response size. full (default) is the complete status; concise drops only the projection detail and the per-slot schema, capture operation and artifact subject, and keeps every id, binding, identity, argument, next_transition, forecast, repair and consumed field."}
NOTE = " The `arguments` of a review_status transition are exactly this tool's properties (values as strings; \"true\", integers and JSON arrays are coerced), so a transition can be passed as given."


def _object(properties: dict[str, JsonSchema], required: list[str] | None = None) -> JsonSchema:
    return {"type": "object", "properties": properties, "required": [] if required is None else required, "additionalProperties": False}


# ---- helpers ----

_CONCISE_STATUS_DROPS = ("projection",)
_CONCISE_INPUT_DROPS = ("schema", "capture_operation", "artifact_subject", "base_tree", "candidate_tree")


def concise_status(status: dict) -> dict:
    """review_status detail "concise": drops descriptive fields only; everything the next call needs (ids, bindings, arguments, next_transition) stays."""
    out = dict(status)
    for k in _CONCISE_STATUS_DROPS:
        out.pop(k, None)
    nxt = out.get("next_transition")
    collect = nxt.get("collect") if isinstance(nxt, dict) else None
    if isinstance(collect, dict) and collect.get("inputs") is not None:
        inputs = []
        for i in collect["inputs"]:
            c = dict(i)
            for k in _CONCISE_INPUT_DROPS:
                c.pop(k, None)
            inputs.append(c)
        out["next_transition"] = {**nxt, "collect": {**collect, "inputs": inputs}}
    return out


Args = dict


def _str(a: Args, k: str) -> str | None:
    v = a.get(k)
    return v if isinstance(v, str) else None


def _bool(a: Args, k: str) -> bool | None:
    v = a.get(k)
    return v if isinstance(v, bool) else None


def _cwd_of(a: Args, ctx: ToolContext) -> str:
    v = _str(a, "cwd")
    return ctx.default_cwd if v is None else v


def _target_of(a: Args) -> dict | str:
    """Cross-field target rules the flat schema cannot state. A string is a violation."""
    kind = "current-changes" if _str(a, "target") is None else _str(a, "target")
    if kind == "base-diff":
        if _str(a, "base_ref") is None:
            return "target base-diff needs base_ref"
        if "projection" in a:
            return "projection is only for target current-changes"
        return {"target": {"kind": "base-diff", "baseRef": _str(a, "base_ref"), **({"committedOnly": True} if _bool(a, "committed_only") is True else {})}}
    if "base_ref" in a or "committed_only" in a:
        return "base_ref and committed_only are only for target base-diff"
    return {"target": {"kind": "current-changes"}, **({"projection": _str(a, "projection")} if "projection" in a else {})}


def _invalid(message: str) -> ToolResult:
    return fail("invalid_input", message)


def _lenses_of(a: Args) -> dict | str:
    lenses = a.get("lenses")
    reason = _str(a, "lenses_reason")
    if lenses is None and reason is not None:
        return "lenses_reason needs lenses"
    if lenses is not None and reason is None:
        return "lenses needs lenses_reason"
    return {**({"lenses": lenses} if lenses is not None else {}), **({"lensesReason": reason} if reason is not None else {})}


def _default_assessor(snapshot: dict, repository: dict) -> dict:
    return assess_risk(snapshot, repository)


def _snapshot_target(t: dict) -> dict:
    return snapshot_target_of({"target": t["target"], **({"projection": t["projection"]} if "projection" in t else {})})


def _guarded_start(a: Args, ctx: ToolContext, consent: str, expected_target_identity: str | None = None) -> ToolResult:
    """START behind the pending-correction guard. A candidate that is the correction of a lineage still in correction_required/validating
    must not open a second lineage: the pending lineage is returned instead."""
    t = _target_of(a)
    if isinstance(t, str):
        return _invalid(t)
    lens = _lenses_of(a)
    if isinstance(lens, str):
        return _invalid(lens)
    cwd = _cwd_of(a, ctx)
    pending = pending_correction_lineage(cwd, _snapshot_target(t))
    if pending is not None:
        if "unreadable" in pending:
            return fail("authority_error", f"lineage {pending['unreadable']} cannot be read safely; no new review is opened until it is repaired", {"lineage_id": pending["unreadable"]})
        r = pending["rec"]
        return fail(
            "correction_lineage_pending",
            f"lineage {r['lineage_id']} is waiting for its correction ({r['state']}); resume it with review_run and lineage_id instead of opening a new review",
            {"lineage": {"lineage_id": r["lineage_id"], "state": r["state"], "revision": r["revision"], "target_identity": r["target_identity"], "projection": r["projection"], "risk_level": r["risk_level"]}},
        )
    outcome = start_review({
        "cwd": cwd,
        "target": t["target"],
        **({"projection": t["projection"]} if "projection" in t else {}),
        **lens,
        "consent": consent,
        **({"locale": _str(a, "locale")} if _str(a, "locale") is not None else {}),
        **({"expectedTargetIdentity": expected_target_identity} if expected_target_identity is not None else {}),
        "riskAssessor": ctx.deps.get("riskAssessor") or _default_assessor,
    })
    if outcome["status"] == "refused":
        return fail(outcome["code"], outcome["message"], {"lineage_id": outcome["lineage_id"]} if "lineage_id" in outcome else {})
    return ok(encode_start_envelope(outcome))


def _run_result(out: dict) -> ToolResult:
    """A run outcome as a tool result: blocked / binding-drift are typed errors, every other outcome is a normal result."""
    if out["outcome"] == "blocked":
        extra: dict = {}
        if "detail" in out:
            extra["detail"] = out["detail"]
        if "errors" in out:
            extra["errors"] = out["errors"][:20]
        for k in ("slot", "status_after", "lineage_id"):
            if k in out:
                extra[k] = out[k]
        return fail(out["code"], out["message"], extra)
    if out["outcome"] == "binding-drift":
        extra = {}
        if "field" in out:
            extra["field"] = out["field"]
        if "lineage_id" in out:
            extra["lineage_id"] = out["lineage_id"]
        return fail("binding_drift", out["message"], extra)
    return ok(out)


def _run_input(a: Args, ctx: ToolContext, extra: dict | None = None) -> dict | ToolResult:
    t = _target_of(a)
    if isinstance(t, str):
        return _invalid(t)
    lens = _lenses_of(a)
    if isinstance(lens, str):
        return _invalid(lens)
    bad = validate_reviewer_options({k: a[k] for k in ("model", "effort") if k in a})
    if bad is not None:
        return _invalid(bad)
    timeout = a.get("timeout_ms")
    return {
        "cwd": _cwd_of(a, ctx),
        "target": t["target"],
        **({"projection": t["projection"]} if "projection" in t else {}),
        **lens,
        **({"lineageId": _str(a, "lineage_id")} if _str(a, "lineage_id") is not None else {}),
        **({"locale": _str(a, "locale")} if _str(a, "locale") is not None else {}),
        **({"model": _str(a, "model")} if _str(a, "model") is not None else {}),
        **({"effort": _str(a, "effort")} if _str(a, "effort") is not None else {}),
        **({"timeoutMs": js_double(timeout)} if isinstance(timeout, (int, float)) and not isinstance(timeout, bool) else {}),
        **({"reviewerRunAcknowledged": _bool(a, "reviewer_run_acknowledged")} if _bool(a, "reviewer_run_acknowledged") is not None else {}),
        **({"reviewerRunBinding": _str(a, "reviewer_run_binding")} if _str(a, "reviewer_run_binding") is not None else {}),
        **({"signal": ctx.signal} if ctx.signal is not None else {}),
        **(extra or {}),
    }


def _is_result(v: Any) -> bool:
    return isinstance(v, dict) and "content" in v


def _run_deps(ctx: ToolContext, extra: dict | None = None) -> dict:
    out: dict = {}
    for k in ("runner", "riskAssessor", "concurrency"):
        if ctx.deps.get(k) is not None:
            out[k] = ctx.deps[k]
    return {**out, **(extra or {})}


def _binding_of_input(i: dict) -> Any:
    for x in i["arguments"]:
        if x.get("name") == "binding":
            return x.get("value")
    return None


def _capture_batch(a: Args, ctx: ToolContext, given: list[str], single: bool) -> ToolResult:
    """review_capture / review_capture_group: admit the one reviewer batch status (or the run's forecast) issued, and stop. The given
    bindings must be exactly the current collect set; a group is never partially selected or reordered."""
    lineage = _str(a, "lineage_id")
    inp = _run_input(a, ctx, {"lineageId": lineage})
    if _is_result(inp):
        return inp
    cwd = inp["cwd"]
    repo = resolve_repository(cwd)
    rec = read_state(repo["commonDir"], lineage)
    status = review_status(cwd, {"target": inp["target"], **({"projection": inp["projection"]} if "projection" in inp else {})})
    nxt = status["next_transition"]
    authority = status.get("authority")
    if isinstance(authority, dict) and authority.get("lineage_id") == lineage and nxt["kind"] == "collect":
        bindings = [_binding_of_input(i) for i in nxt["collect"]["inputs"]]
        if any(b is None for b in bindings):
            return fail("not_a_reviewer_collect", "the current collect needs no reviewer batch here; follow review_status or use review_run")
        expected = bindings
    elif rec["state"] in ("correction_required", "validating"):
        # The corrected candidate has another identity than the lineage target: status cannot route it, the lineage record does.
        for g in given:
            d = decode_binding(g)
            if not d["ok"] or d["binding"].get("role") not in ("correction", "validator") or d["binding"].get("lineage_id") != lineage or d["binding"].get("revision") != rec["revision"]:
                return fail("binding_mismatch", "the binding is not the correction validator binding of this lineage's current revision; take it from the review_run forecast")
        expected = given
    else:
        return fail("no_collect_pending", f"lineage {lineage} has no reviewer batch to capture (state {rec['state']}); call review_status")
    if single and len(expected) > 1:
        return fail("group_required", "the current collect issued several reviewer slots; use review_capture_group with every binding in order", {"expected_count": len(expected)})
    if len(expected) != len(given) or any(b != given[i] for i, b in enumerate(expected)):
        return fail("binding_mismatch", "the bindings are not exactly the current collect set, in order", {"expected_bindings": expected})
    return _run_result(run_review(inp, _run_deps(ctx, {"stopAfterBatch": True})))


# ---- tools ----

_READ_ONLY = {"readOnlyHint": True, "destructiveHint": False, "idempotentHint": True, "openWorldHint": False}
_WRITES = {"readOnlyHint": False, "destructiveHint": False, "idempotentHint": False, "openWorldHint": False}


def _review_assess(a: Args, ctx: ToolContext) -> ToolResult:
    t = _target_of(a)
    if isinstance(t, str):
        return _invalid(t)
    r = assess_candidate(_cwd_of(a, ctx), _snapshot_target(t))
    if r["status"] == "not_due":
        return ok({"outcome": "not_due", "reason": r["reason"], "review_due": False, "kind": r["kind"], "projection": r["projection"]})
    return ok({
        "outcome": "assessed", "risk_level": r["risk"], "review_due": r["reviewDue"], "reasons": r["reasons"], "evidence": r["evidence"][:50],
        **({"focus_lens": r["focusLens"]} if "focusLens" in r else {}),
        "kind": r["kind"], "projection": r["projection"], "target_identity": r["targetIdentity"], "base_tree": r["baseTree"], "candidate_tree": r["candidateTree"],
        "changed_lines": r["changedLines"], "changed_paths": r["changedPaths"][:MAX_PATHS], "changed_paths_total": len(r["changedPaths"]), "changed_paths_truncated": len(r["changedPaths"]) > MAX_PATHS,
    })


def _review_inspect(a: Args, ctx: ToolContext) -> ToolResult:
    cwd = _cwd_of(a, ctx)
    repo = resolve_repository(cwd)
    limit = a.get("limit")
    listing = list_lineages(repo["commonDir"], limit=js_double(limit) if isinstance(limit, (int, float)) and not isinstance(limit, bool) else 25)
    lineages: list[dict] = []
    unreadable: list[dict] = []
    for id in listing["lineages"]:
        try:
            r = read_state(repo["commonDir"], id)
            lineages.append({
                "lineage_id": id, "state": r["state"], "risk_level": r["risk_level"], "projection": r["projection"], "target_identity": r["target_identity"],
                "revision": r["revision"], "burned": r.get("burned") is True, "updated_at": r["updated_at"],
            })
        except Exception as e:  # noqa: BLE001 - v9 `catch (e)`: reported by name, never hidden
            unreadable.append({"lineage_id": id, "error": type(e).__name__})
    mode = read_review_mode(cwd, ctx.deps.get("modeOptions"))
    return ok({"rdd_mode": {"effective": mode["effective"], "source": mode["source"], "problems": mode["problems"][:10]}, "lineages": lineages, "unreadable": unreadable, "truncated": listing["truncated"]})


def _review_status(a: Args, ctx: ToolContext) -> ToolResult:
    t = _target_of(a)
    if isinstance(t, str):
        return _invalid(t)
    status = review_status(_cwd_of(a, ctx), {"target": t["target"], **({"projection": t["projection"]} if "projection" in t else {}), **({"acknowledgement": a["acknowledgement"]} if "acknowledgement" in a else {})})
    return ok(concise_status(status) if _str(a, "detail") == "concise" else status)


def _review_answer_consent(a: Args, ctx: ToolContext) -> ToolResult:
    lenses = a.get("lenses")
    asked = consent_binding(_str(a, "target_identity"), {"names": lenses, "reason": _str(a, "lenses_reason") or ""} if lenses is not None else None)
    if asked != _str(a, "consent_binding"):
        return fail("binding_drift", "the answer is not bound to this candidate and lens selection: pass the arguments of the chosen consent invocation exactly as given", {"field": "consent_binding"})
    return _guarded_start(a, ctx, _str(a, "consent"), _str(a, "target_identity"))


def _review_acknowledge_approved(a: Args, ctx: ToolContext) -> ToolResult:
    repo = resolve_repository(_cwd_of(a, ctx))
    res = acknowledge_approved(repo["commonDir"], {"lineage": _str(a, "lineage_id"), "target": _str(a, "target_identity"), "expectedRevision": _str(a, "expected_revision"), "token": _str(a, "token")})
    return ok(encode_ack_envelope(res))


def _review_complete(a: Args, ctx: ToolContext) -> ToolResult:
    repo = resolve_repository(_cwd_of(a, ctx))
    out = complete_review(repo["commonDir"], _str(a, "lineage_id"), _str(a, "expected_revision"))
    if not out["ok"]:
        extra: dict = {}
        if "errors" in out:
            extra["errors"] = out["errors"][:20]
        if "currentRevision" in out:
            extra["current_revision"] = out["currentRevision"]
        return fail(out["code"], out["message"], extra)
    return ok(encode_capture_envelope(out))


def _review_run(a: Args, ctx: ToolContext) -> ToolResult:
    inp = _run_input(a, ctx)
    if _is_result(inp):
        return inp
    return _run_result(run_review(inp, _run_deps(ctx)))


TOOLS: tuple[ToolDefinition, ...] = (
    ToolDefinition(
        "review_assess",
        "Read-only: freeze the candidate in a private index and classify its risk (low/medium/high), with the reasons and changed paths. Starts nothing, creates no review lineage and writes nothing; it never touches the worktree.",
        _object({**TARGET_PROPS}), _READ_ONLY, _review_assess,
    ),
    ToolDefinition(
        "review_inspect",
        "Read-only: list the review authority of this repository (lineages with state, risk, target identity, revision) and the RDD mode. Unreadable lineages are reported, never hidden.",
        _object({"cwd": CWD, "limit": {"type": "integer", "minimum": 1, "maximum": 100, "description": "Lineages to list (default 25)."}}), _READ_ONLY, _review_inspect,
    ),
    ToolDefinition(
        "review_start",
        "Start a review of the candidate. It ALWAYS relays consent: a medium/high-risk candidate returns the consent envelope untouched (show it to the human losslessly) and creates nothing; only review_answer_consent, with the human's explicit answer, can grant or decline (the one exception: a standing consent recorded in the feature document `## Log` for a tracked feature's work-unit commit candidates, see review_answer_consent). A low-risk candidate is approved at once and returns its one-shot acknowledgement. Refuses to open a second lineage while one waits for its correction.",
        _object({
            **TARGET_PROPS, **LENS_PROPS,
            "contract": {"type": "string", "const": REVIEW_CONTRACT},
            "target_identity": {"type": "string", "pattern": SHA_PATTERN, "description": "When given (status passes it), the candidate must still have exactly this identity (binding_drift otherwise)."},
        }),
        _WRITES, lambda a, ctx: _guarded_start(a, ctx, "relay", _str(a, "target_identity")),
    ),
    ToolDefinition(
        "review_status",
        "Read-only: the review status of the candidate. Follow ONLY the next_transition it returns (its `command` names the tool to call); never infer a step. Pass `acknowledgement` (from start/capture) to be offered the approval acknowledgement. Optional `detail`: \"full\" (default) or \"concise\" (smaller: drops only the projection detail and per-slot artifact subjects; keeps every id, binding, next_transition, forecast and repair)." + NOTE,
        _object({
            **TARGET_PROPS,
            "detail": DETAIL,
            "acknowledgement": _object({
                "lineage_id": {"type": "string", "pattern": LINEAGE_PATTERN}, "target_identity": {"type": "string", "pattern": SHA_PATTERN},
                "expected_revision": {"type": "string", "minLength": 1, "maxLength": 200}, "token": {"type": "string", "minLength": 1, "maxLength": 200},
            }, ["lineage_id", "target_identity", "expected_revision", "token"]),
        }),
        _READ_ONLY, _review_status,
    ),
    ToolDefinition(
        "review_answer_consent",
        "Record the HUMAN's explicit answer to a consent question (granted or declined) for the exact candidate it was asked for. Call it only with the answer the human gave, never on your own judgment and never to 'relay'. The one exception: a standing consent recorded in the feature document `## Log` (asked once per feature, human's verbatim answer) covers only that feature branch's work-unit commit candidates, up to 3 passes each; without it, after a decline, or for any other candidate, relay to the human. target_identity must be the one in the consent envelope; if the candidate moved, nothing is recorded (binding_drift).",
        _object(
            {
                **TARGET_PROPS, **LENS_PROPS,
                "contract": {"type": "string", "const": REVIEW_CONTRACT},
                "target_identity": {"type": "string", "pattern": SHA_PATTERN, "description": "target_identity of the consent envelope."},
                "consent": {"type": "string", "enum": ["granted", "declined"], "description": "The human's explicit answer (or the standing consent recorded in the feature document `## Log`, for that feature branch's work-unit commit candidates only)."},
                "consent_binding": {"type": "string", "pattern": SHA_PATTERN, "description": "consent-binding of the chosen consent invocation: binds the answer to the target and the lens selection the human saw."},
            },
            ["target_identity", "consent", "consent_binding"],
        ),
        _WRITES, _review_answer_consent,
    ),
    ToolDefinition(
        "review_capture",
        "Admit exactly one reviewer slot issued by review_status or a review_run forecast: pass its exact binding. First returns a forecast; call again with reviewer_run_acknowledged and its reviewer_run_binding to run the reviewer (after the user saw the forecast, or under a standing consent recorded in the feature document `## Log` that covers that feature branch's work-unit commit candidates). Stops after the batch (never acknowledges or follows another transition); the result may carry the one-shot approval acknowledgement.",
        _object({**TARGET_PROPS, "lineage_id": {"type": "string", "pattern": LINEAGE_PATTERN}, "binding": {"type": "string", "minLength": 1, "maxLength": 8192}, **RUN_PROPS}, ["lineage_id", "binding"]),
        _WRITES, lambda a, ctx: _capture_batch(a, ctx, [_str(a, "binding")], True),
    ),
    ToolDefinition(
        "review_capture_group",
        "Admit one complete reviewer group: pass lineage_id and ALL bindings of the current collect, in order, never partial. First returns a forecast; call again with reviewer_run_acknowledged and its reviewer_run_binding (same rule: the user saw the forecast, or a standing consent recorded in the feature document `## Log` covers that feature branch's work-unit commit candidates). Reviewers run concurrently (bounded) and are admitted in order; stops after the batch.",
        _object(
            {**TARGET_PROPS, "lineage_id": {"type": "string", "pattern": LINEAGE_PATTERN}, "bindings": {"type": "array", "items": {"type": "string", "minLength": 1, "maxLength": 8192}, "minItems": 1, "maxItems": 8, "uniqueItems": True}, **RUN_PROPS},
            ["lineage_id", "bindings"],
        ),
        _WRITES, lambda a, ctx: _capture_batch(a, ctx, a["bindings"], False),
    ),
    ToolDefinition(
        "review_acknowledge_approved",
        "Acknowledge an approved review once (burns the lineage, writes the receipt). Needs the one-shot token returned when the review was approved, the exact revision and target identity.",
        _object(
            {
                "cwd": CWD, "lineage_id": {"type": "string", "pattern": LINEAGE_PATTERN}, "target_identity": {"type": "string", "pattern": SHA_PATTERN},
                "expected_revision": {"type": "string", "minLength": 1, "maxLength": 200}, "token": {"type": "string", "minLength": 1, "maxLength": 200},
            },
            ["lineage_id", "target_identity", "expected_revision", "token"],
        ),
        _WRITES, _review_acknowledge_approved,
    ),
    ToolDefinition(
        "review_complete",
        "Settle a fully reviewed lineage that status offers as `review.validate` (all lens results admitted). Needs the exact expected_revision from status.",
        _object({"cwd": CWD, "lineage_id": {"type": "string", "pattern": LINEAGE_PATTERN}, "expected_revision": {"type": "string", "minLength": 1, "maxLength": 200}}, ["lineage_id", "expected_revision"]),
        _WRITES, _review_complete,
    ),
    ToolDefinition(
        "review_run",
        "Drive one review end to end by following status transitions: start, reviewers, capture, acknowledge. It returns a typed outcome: closed, not-due, consent-required (relay the envelope to the human; consent is never answered here, except under a standing consent recorded in the feature document `## Log` for that feature branch's work-unit commit candidates), input-required (a correction is needed), forecast (reviewers cost money: call again with reviewer_run_acknowledged and the forecast's reviewer_run_binding), stopped, binding-drift, transition-limit or cancelled. Resume a consented or corrected review with lineage_id.",
        _object({**TARGET_PROPS, **LENS_PROPS, "lineage_id": {"type": "string", "pattern": LINEAGE_PATTERN}, **RUN_PROPS}),
        _WRITES, _review_run,
    ),
)

TOOL_BY_NAME: dict[str, ToolDefinition] = {t.name: t for t in TOOLS}

_COMMA_LISTS = frozenset(["lenses"])
_INT_RE = re.compile(r"-?[0-9]{1,15}")


def coerce_arguments(schema: JsonSchema, args: Any) -> Any:
    """Status transitions carry every argument as a string. Before validation a string is coerced to the type its property declares:
    boolean ("true"/"false"), integer (digits), array (a JSON array, or a comma list for `lenses`). Anything else is left as is and
    fails validation."""
    if not isinstance(args, dict):
        return args
    out: dict = {}
    props = schema.get("properties", {})
    for k in js_keys(args):
        v = args[k]
        prop = props.get(k)
        out[k] = v
        if prop is None or not isinstance(v, str):
            continue
        ptype = prop.get("type")
        if ptype == "boolean" and v in ("true", "false"):
            out[k] = v == "true"
        elif ptype == "integer" and _INT_RE.fullmatch(v):
            out[k] = int(v)
        elif ptype == "array":
            if v.startswith("["):
                try:
                    out[k] = js_json_loads(v)
                except ValueError:
                    pass  # left as a string: validation reports it
            elif k in _COMMA_LISTS:
                out[k] = [x for x in (js_trim(p) for p in v.split(",")) if x != ""]
    return out


def call_tool(tool: ToolDefinition, raw_args: Any, ctx: ToolContext) -> ToolResult:
    """Validates the arguments against the tool's schema, then runs it. Never raises: failures are typed tool errors."""
    args = coerce_arguments(tool.input_schema, {} if raw_args is None else raw_args)
    errors = validate_schema(tool.input_schema, args)
    if errors:
        return fail("invalid_input", f"invalid arguments for {tool.name}", {"errors": errors})
    try:
        return tool.run({} if args is None else args, ctx)
    except Exception as e:  # noqa: BLE001
        return error_result(e)


# The registry must be exactly the names the invocation strings use (consent.py).
if ",".join(t.name for t in TOOLS) != ",".join(REVIEW_TOOL_NAMES):
    raise RuntimeError("review tool registry differs from REVIEW_TOOL_NAMES")
