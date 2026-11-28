"""Run loop / relay (port of v9 review/run.ts): drives ONE ordinary review end to end over the verified modules.

Routing comes only from `review_status`: its `next_transition` is followed, never invented. The loop starts a fresh target, runs the
reviewer slots status offers, admits their outputs through capture and acknowledges an approval. It is bounded (`MAX_TRANSITIONS`) and
ends in a typed outcome: closed | not-due | consent-required | input-required | forecast | stopped | blocked | binding-drift |
transition-limit | cancelled | captured.

Invariants (as v9): consent is never answered here; reviewers cost money, so the first time a batch is due the run returns a `forecast`
and runs nothing until called again with `reviewerRunAcknowledged: true` AND the forecast's `reviewerRunBinding`; a group runs
concurrently (bounded) but is admitted strictly in provider order after the candidate was re-frozen and the slot bindings re-verified
(a moved candidate is `binding-drift`, nothing captured); a failed or malformed reviewer output never reaches acknowledgement; model and
effort are validated before anything starts.

Python port conventions: `run_review(input, deps=None)` is synchronous; `input` and `deps` are plain dicts with v9's camelCase keys (a
missing key is JS `undefined`). v9 runs the reviewers of a group as concurrent promises (`boundedAll`); here each reviewer runs in a
daemon thread, at most `concurrency` at a time, started in slot order, and the loop admits their results strictly in slot order. As in
v9 the runner has no abort: a child already spawned finishes (or times out) on its own bound and its output is discarded, but once the
run is aborted, a slot failed or the batch returned, no QUEUED reviewer starts. Cancellation: `input["signal"]` is an `AbortSignal`
(below) or a `threading.Event`; it is checked between steps and polled (10 ms) while a batch runs, the Python stand-in for v9's race
against the `abort` event. `deps` keys: `runner(prompt, opts) -> outcome`, `riskAssessor`, `concurrency`, `maxTransitions`,
`profileState` (a `StateOptions` or `{"dataDir", "env"}`), `hooks: {"beforeCapture", "beforeAcknowledge"}`, `stopAfterBatch`.
"""
import math
import os
import threading
from typing import Any, Callable

from ..lib.profiles import read_profile
from ..lib.state import StateOptions
from .ack import AckRefusedError, acknowledge_approved
from .artifact import manifest_for, refuter_request_hash, targeted_validation_request_hash, tree_diff_paths
from .canonical import domain_hash
from .capture import (
    capture_correction_result,
    capture_lens_result,
    capture_refuter_result,
    capture_validator_result,
    complete_review,
    plan_correction,
    preview_correction_validation,
)
from .contract import REASON_DESCRIPTIONS, encode_ack_envelope, encode_binding, encode_capture_envelope, forecast_for, is_terminal_stop, verify_binding
from .lineage import read_raw_state
from .lock import StoreLockContended, StoreLockError
from .reviewer_model import reviewer_route
from .risk import assess_risk
from .runner import build_reviewer_prompt, parse_reviewer_output, run_reviewer
from .snapshot import SnapshotError, digest_paths, freeze_snapshot, resolve_repository, snapshot_identity
from .start import snapshot_target_of, start_review
from .state import RangeError, blocking_finding_ids
from .status import _to_string, review_status
from .store import (
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
    store_root_for,
)

#: Bound of the status-driven loop (same as the reference relay).
MAX_TRANSITIONS = 24
#: Reviewers of one group running at the same time.
DEFAULT_CONCURRENCY = 2

REVIEWER_MODELS: list[str] = ["fable", "opus", "sonnet", "haiku"]
REVIEWER_EFFORTS: list[str] = ["low", "medium", "high", "xhigh", "max"]

_U: Any = object()  # JS `undefined`
_POLL_S = 0.01

_STORE_ERRORS = (
    StoreInvalidLineageError, StoreNotFoundError, StoreAlreadyExistsError, StoreCorruptError, StoreConcurrentUpdateError,
    StoreTransitionRefusedError, StoreInvalidRecordError, StoreIoError, StoreLockContended, StoreLockError,
)


class AbortSignal:
    """Minimal stand-in for JS `AbortSignal`/`AbortController` in one object: `abort()` flips `aborted` for good."""

    def __init__(self) -> None:
        self._event = threading.Event()

    @property
    def aborted(self) -> bool:
        return self._event.is_set()

    def abort(self) -> None:
        self._event.set()


def _is_aborted(signal: Any) -> bool:
    if signal is _U or signal is None:
        return False
    flag = getattr(signal, "aborted", None)
    if isinstance(flag, bool):
        return flag
    is_set = getattr(signal, "is_set", None)
    return bool(is_set()) if callable(is_set) else False


def validate_reviewer_options(opts: dict) -> str | None:
    """Error text for a user-supplied model/effort the runner cannot honour, or None when valid. Stricter than the runner on purpose
    (it silently ignores what it does not know): only a known family, an effort only with a family that has levels."""
    model, effort = opts.get("model", _U), opts.get("effort", _U)
    if model is not _U and (not isinstance(model, str) or model not in REVIEWER_MODELS):
        return f"model must be one of {', '.join(REVIEWER_MODELS)}"
    if effort is not _U and effort != "":
        if not isinstance(effort, str) or effort not in REVIEWER_EFFORTS:
            return f"effort must be one of {', '.join(REVIEWER_EFFORTS)}"
        if model is _U:
            return "effort needs a model"
        if model == "haiku":
            return "haiku has no effort levels"
    return None


def _raw_correction_matches(common_dir: str, id: str, base_tree: str, projection: str) -> bool:
    """Best-effort look at an unreadable state file (read only; secure bounded reader). True: the raw record claims a pending correction
    on this base/projection, or the file is unsafe (fail closed); otherwise skipped."""
    raw = read_raw_state(os.path.join(store_root_for(common_dir), id, "review-state.json"))
    if raw == "unsafe":
        return True
    if raw is None:
        return False
    return (
        raw.get("state") in ("correction_required", "validating")
        and base_tree in (raw.get("base_tree"), raw.get("candidate_tree"), raw.get("original_candidate_tree"))
        and raw.get("projection") == projection
    )


def pending_correction_lineage(cwd: str, target: dict) -> dict | None:
    """A lineage still waiting for its correction whose reviewed base is this candidate's base (newest first): `{"rec"}`, or
    `{"unreadable": id}` for a lineage the store cannot read whose raw record claims the same (fail closed), else None. Read-only."""
    frozen = freeze_snapshot(cwd, target)
    if frozen["status"] != "frozen":
        return None
    common_dir = frozen["repository"]["commonDir"]
    snap = frozen["snapshot"]
    found: dict | None = None
    unreadable: str | None = None
    for id in list_lineages(common_dir)["lineages"]:
        try:
            rec = read_state(common_dir, id)
        except Exception:  # noqa: BLE001 - v9 `catch {}`
            if unreadable is None and _raw_correction_matches(common_dir, id, snap["baseTree"], snap["projection"]):
                unreadable = id
            continue
        if rec["state"] not in ("correction_required", "validating"):
            continue
        if snap["baseTree"] not in (rec["base_tree"], rec["candidate_tree"], rec.get("original_candidate_tree")) or rec["projection"] != snap["projection"]:
            continue
        if found is None or rec["updated_at"] > found["updated_at"]:
            found = rec
    if unreadable is not None:
        return {"unreadable": unreadable}
    return None if found is None else {"rec": found}


def _bounded_all(count: int, limit: int, task: Callable[[int], Any], skip: Callable[[], Any]) -> tuple[list, list[threading.Event]]:
    """Starts tasks in index order, at most `limit` at a time (daemon threads); every slot settles (tasks must not raise).
    `skip` is asked when a queued task would start: a non-None answer is its result and the task never runs."""
    results: list = [None] * count
    done = [threading.Event() for _ in range(count)]
    lock = threading.Lock()
    first = min(limit, count)
    nxt = [first]
    # v9 acquires the first `limit` slots in the same tick, before any reviewer outcome is processed: their skip answers are decided
    # here, not racing the other workers (a reviewer that fails at once never stops its concurrent siblings)
    initial = [skip() for _ in range(first)]

    def run_one(i: int, skipped: Any) -> None:
        try:
            results[i] = task(i) if skipped is None else skipped
        finally:
            done[i].set()

    def worker(i0: int) -> None:
        run_one(i0, initial[i0])
        while True:
            with lock:
                i = nxt[0]
                if i >= count:
                    return
                nxt[0] += 1
            run_one(i, skip())

    for i0 in range(first):
        threading.Thread(target=worker, args=(i0,), daemon=True).start()
    return results, done


def _slot_view(s: dict, o: dict) -> dict:
    view = {"role": s["role"]}
    if s.get("lens") is not None:
        view["lens"] = s["lens"]
    view["binding"] = s["binding"]
    if "model" in o:
        view["model"] = o["model"]
    if "effort" in o:
        view["effort"] = o["effort"]
    return view


def _slot_ref(s: dict) -> dict:
    return {"role": s["role"], **({"lens": s["lens"]} if s.get("lens") is not None else {})}


def _profile_state(v: Any) -> Any:
    if isinstance(v, dict):
        return StateOptions(data_dir=v.get("dataDir"), env=v.get("env"))
    return v


def run_review(input: dict, deps: dict | None = None) -> dict:
    """Drives one review. Never raises for typed failures; see the module header for the outcomes."""
    deps = {} if deps is None else deps
    st: dict[str, Any] = {"lineage": input.get("lineageId", _U), "target": _U, "transitions": 0, "ack": None, "batches": 0}
    max_transitions = deps["maxTransitions"] if deps.get("maxTransitions") is not None else MAX_TRANSITIONS
    signal = input.get("signal")

    def aborted() -> bool:
        return _is_aborted(signal)

    def finish(body: dict) -> dict:
        return {
            **body,
            **({"lineage_id": st["lineage"]} if st["lineage"] is not _U else {}),
            **({"target_identity": st["target"]} if st["target"] is not _U else {}),
            "transitions": st["transitions"],
        }

    def blocked(code: str, message: str, **extra: Any) -> dict:
        return finish({"outcome": "blocked", "code": code, "message": message, **extra})

    def drift(field: str, message: str) -> dict:
        return finish({"outcome": "binding-drift", "field": field, "message": message})

    def cancelled() -> dict:
        return finish({"outcome": "cancelled"})

    def stopped(reason: str) -> dict:
        body = {"outcome": "stopped", "reason_code": reason, "terminal": is_terminal_stop(reason)}
        if reason in REASON_DESCRIPTIONS:
            body["description"] = REASON_DESCRIPTIONS[reason]
        return finish(body)

    options_error = validate_reviewer_options(input)
    if options_error is not None:
        return blocked("invalid_option", options_error)
    if aborted():
        return cancelled()

    snap_target = snapshot_target_of(input)
    start_target = input.get("target") if input.get("target") is not None else {"kind": "current-changes"}

    def status_of() -> dict:
        o: dict = {"target": start_target}
        if "projection" in input:
            o["projection"] = input["projection"]
        if st["ack"] is not None:
            o["acknowledgement"] = st["ack"]
        return review_status(input["cwd"], o)

    try:
        repo = resolve_repository(input.get("cwd"))
        common_dir = repo["commonDir"]
        run = deps["runner"] if deps.get("runner") is not None else run_reviewer
        runner_opts = {k: input[k] for k in ("claudePath", "model", "effort", "timeoutMs") if k in input}
        # without an explicit caller model every reviewer child follows the active profile route of its role, read once per run
        profile = read_profile(_profile_state(deps.get("profileState"))) if "model" not in input else None

        def options_for(slot: dict) -> dict:
            return runner_opts if profile is None else {**runner_opts, **reviewer_route(profile, slot["role"], slot.get("lens"))}

        def current_identity() -> str | None:
            frozen = freeze_snapshot(input["cwd"], snap_target)
            return frozen["snapshot"]["identity"] if frozen["status"] == "frozen" else None

        def remember_ack(last: dict) -> None:
            if last.get("ackToken") is not None:
                st["ack"] = {"lineage_id": last["record"]["lineage_id"], "target_identity": last["record"]["target_identity"], "expected_revision": last["revision"], "token": last["ackToken"]}

        def run_batch(slots: list[dict], ctx: dict) -> dict:
            def out(outcome: dict) -> dict:
                return {"done": False, "outcome": outcome}

            def nn(v: Any) -> Any:  # `x ?? ""`
                return "" if v is None or v is _U else v

            # model/effort are part of what the user authorized; `routes` is what each slot will actually run under
            batch_binding = domain_hash("run-reviewer-batch", 2, {
                "lineage_id": ctx["lineage"],
                "bindings": [s["binding"] for s in slots],
                "model": nn(input.get("model", _U)),
                "effort": nn(input.get("effort", _U)),
                "routes": [f"{options_for(s).get('model', '')}/{options_for(s).get('effort', '')}" for s in slots],
            })
            if input.get("reviewerRunAcknowledged") is not True or st["batches"] > 0:
                return out(finish({
                    "outcome": "forecast",
                    "forecast": ctx["forecast"],
                    "reviewer_run_binding": batch_binding,
                    "reviewers": [_slot_view(s, options_for(s)) for s in slots],
                    **({"model": input["model"]} if "model" in input else {}),
                    **({"effort": input["effort"]} if "effort" in input else {}),
                }))
            if "reviewerRunBinding" not in input:
                return out(blocked("invalid_input", "reviewerRunAcknowledged needs the reviewerRunBinding of the forecast"))
            if input["reviewerRunBinding"] != batch_binding:
                return out(drift("forecast", "the acknowledged forecast is not the reviewer batch that is due now"))
            st["batches"] += 1

            prompts: list[str] = []
            for slot in slots:
                built = build_reviewer_prompt({"commonDir": common_dir, "role": slot["role"], **({"lens": slot["lens"]} if slot.get("lens") is not None else {}), **slot["prompt"]})
                if not built["ok"]:
                    return out(blocked("reviewer_prompt_unavailable", built["message"], detail=built["code"], slot=_slot_ref(slot)))
                prompts.append(built["prompt"])

            def failure(slot: dict, code: str, message: str, detail: Any = None, errors: Any = None) -> dict:
                try:
                    after = ctx["recheck"]()
                except Exception:  # noqa: BLE001
                    after = None
                extra: dict = {"slot": _slot_ref(slot)}
                if detail is not None:
                    extra["detail"] = detail
                if errors is not None:
                    extra["errors"] = errors
                if after is not None:
                    extra["status_after"] = after
                return out(blocked(code, message, **extra))

            conc = deps["concurrency"] if deps.get("concurrency") is not None else DEFAULT_CONCURRENCY
            limit = (max(1, math.floor(conc)) if conc < float("inf") else 1 << 30) if isinstance(conc, (int, float)) and conc == conc else DEFAULT_CONCURRENCY
            # no queued reviewer starts once the run is aborted, a slot failed, or the batch returned (`halted`)
            halted = [False]
            not_started = {"ok": False, "code": "nonzero_exit", "message": "the reviewer was not started: the run stopped first", "elapsedMs": 0}

            def task(i: int) -> dict:
                try:
                    res = run(prompts[i], options_for(slots[i]))
                    if not res.get("ok"):
                        halted[0] = True
                    return res
                except Exception as e:  # noqa: BLE001
                    halted[0] = True
                    return {"ok": False, "code": "claude_unavailable", "message": f"the reviewer runner failed: {e}", "elapsedMs": 0}

            results, done = _bounded_all(len(slots), limit, task, lambda: dict(not_started) if halted[0] or aborted() else None)

            def await_result(i: int) -> Any:
                while not done[i].wait(_POLL_S):
                    if aborted():
                        return "aborted"
                return results[i]

            try:
                revision = ctx["revision"]
                last = None
                for i, slot in enumerate(slots):
                    got = await_result(i)
                    if got == "aborted" or aborted():
                        return out(cancelled())
                    if not got.get("ok"):
                        return failure(slot, "reviewer_failed", got.get("message"), got.get("code"))

                    # the candidate and the slot bindings must still be the world the slots were issued for
                    if current_identity() != ctx["expectedIdentity"]:
                        return out(drift("target", "the candidate changed while the reviewers ran; nothing was captured"))
                    rec = read_state(common_dir, ctx["lineage"])
                    if i == 0:
                        for s in slots:
                            v = verify_binding(s["binding"], {"targetIdentity": ctx["expectedIdentity"], "lineage": rec, "commonDir": common_dir})
                            if not v["ok"]:
                                return out(drift(v["field"] if v.get("field") is not None else "revision", v["message"]) if v["code"] == "binding_drift" else blocked("invalid_binding", v["message"]))
                    elif rec["revision"] != revision:
                        return out(drift("revision", "the review changed while the reviewers ran; nothing more was captured"))

                    parsed = parse_reviewer_output(got.get("stdout"), slot["role"], slot["echo"])
                    if not parsed["ok"]:
                        return failure(slot, "reviewer_output_invalid", parsed["message"], parsed["code"], parsed.get("errors"))
                    hook = (deps.get("hooks") or {}).get("beforeCapture")
                    if hook is not None:
                        hook()
                    if aborted():
                        return out(cancelled())
                    captured = slot["capture"](revision, parsed["value"])
                    if not captured["ok"]:
                        return failure(slot, "capture_refused", captured["message"], captured.get("code"), captured.get("errors"))
                    revision = captured["revision"]
                    last = captured
                return {"done": True, "last": last}
            finally:
                halted[0] = True

        def acknowledge(lineage_id: str, target_identity: str, revision: str, token: str) -> dict:
            hook = (deps.get("hooks") or {}).get("beforeAcknowledge")
            if hook is not None:
                hook()
            if aborted():
                return cancelled()
            res = acknowledge_approved(common_dir, {"lineage": lineage_id, "target": target_identity, "expectedRevision": revision, "token": token})
            st["target"] = res["record"]["target_identity"]
            return finish({"outcome": "closed", "risk_level": res["record"]["risk_level"], "acknowledgement": encode_ack_envelope(res)})

        def after_correction(rec: dict) -> dict:
            """Resume after the correction: the candidate is no longer the lineage's target, so the lineage record routes."""
            st["lineage"] = rec["lineage_id"]
            st["target"] = rec["target_identity"]
            if rec["state"] in ("escalated", "invalidated"):
                return stopped(rec["state"])
            frozen = freeze_snapshot(input["cwd"], snap_target)
            if frozen["status"] == "empty":
                return blocked("correction_unavailable", "the corrected candidate has no changes")
            snap = frozen["snapshot"]
            # the corrected snapshot must be the same kind of candidate as the reviewed one
            if snap["projection"] != rec["projection"]:
                return drift("projection", f"the corrected candidate is a {snap['projection']} snapshot, the lineage reviewed a {rec['projection']} one")
            # upstream accepts a base that is the reviewed base or the reviewed candidate itself; after a reopened correction the
            # reviewed original stays a valid base too; any other base is drift. The lineage keeps its original base_tree.
            if snap["baseTree"] not in (rec["base_tree"], rec["candidate_tree"], rec.get("original_candidate_tree")):
                return drift("base", "the corrected candidate is based on neither the reviewed base nor the reviewed candidate")
            # reference: the corrected candidate is the INITIAL snapshot's base plus the corrected tree
            corrected_identity = snap["identity"]
            if snap["baseTree"] != rec["base_tree"]:
                try:
                    corrected_identity = snapshot_identity(snap["kind"], snap["projection"], rec["base_tree"], snap["candidateTree"], digest_paths(tree_diff_paths(common_dir, rec["base_tree"], snap["candidateTree"])))
                except (SnapshotError, RangeError) as e:
                    return blocked("correction_unavailable", f"the corrected candidate cannot be compared with the reviewed base: {e}")
            corrected = {"candidateTree": snap["candidateTree"], "identity": corrected_identity}
            lineage_id = rec["lineage_id"]
            if rec["state"] == "correction_required":
                preview = preview_correction_validation(repo, lineage_id, rec["revision"], corrected)
                if not preview["ok"]:
                    return blocked("correction_refused", preview["message"], detail=preview["code"], **({"errors": preview["errors"]} if preview.get("errors") is not None else {}))
                validating = preview["record"]
                binding_role = "correction"

                def capture(revision: str, value: dict) -> dict:
                    return capture_correction_result(repo, lineage_id, revision, corrected, {"result": value})
            elif rec["state"] == "validating":
                if corrected_identity != rec.get("correction_target_identity"):
                    return drift("target", "the candidate is not the corrected candidate under validation")
                validating = rec
                binding_role = "validator"

                def capture(revision: str, value: dict) -> dict:
                    return capture_validator_result(common_dir, lineage_id, revision, {"result": value, "correctionCandidateTree": snap["candidateTree"]})
            else:
                return drift("state", f"the lineage is {rec['state']}, not awaiting a validator")
            request_hash = targeted_validation_request_hash(validating)
            if request_hash is None:
                return drift("state", "the lineage has no correction target to validate")
            echo = {"targeted_validation_request_hash": request_hash, "correction_target_identity": corrected_identity}
            fixed = set(rec["fix_finding_ids"])
            slot = {
                "role": "validator",
                "binding": encode_binding({"role": binding_role, "target_identity": snap["identity"], "lineage_id": lineage_id, "revision": rec["revision"]}),
                "echo": echo,
                "prompt": {
                    "subject": {**echo, "lineage_id": lineage_id},
                    "binding": echo,
                    "baseTree": rec["candidate_tree"],
                    "candidateTree": snap["candidateTree"],
                    "paths": tree_diff_paths(common_dir, rec["candidate_tree"], snap["candidateTree"]),
                    "findings": [f for f in rec["findings"] if f["id"] in fixed],
                },
                "capture": capture,
            }

            def recheck() -> dict:
                s = read_state(common_dir, lineage_id)["state"]
                return {"kind": "collect", "reason_code": "validator_result_required" if s == "validating" else "correction_required" if s == "correction_required" else "corrupted_or_unverifiable_authority"}

            batch = run_batch([slot], {
                "lineage": lineage_id, "revision": rec["revision"], "expectedIdentity": snap["identity"],
                "forecast": forecast_for("collect", "validator_result_required"), "recheck": recheck,
            })
            if not batch["done"]:
                return batch["outcome"]
            last = batch["last"]
            if deps.get("stopAfterBatch") is True:
                return finish({"outcome": "captured", "capture": encode_capture_envelope(last)})
            # the validator passed: the lineage's candidate is now the corrected one, and that identity is what is acknowledged
            if last["next"] == "approved" and last.get("ackToken") is not None:
                return acknowledge(lineage_id, last["record"]["target_identity"], last["revision"], last["ackToken"])
            if last["next"] == "escalated":
                return stopped("escalated")
            # the validator failed with a correction attempt left: the lineage asks for the next correction
            if last["next"] == "correction_required":
                plan = plan_correction(common_dir, lineage_id)
                if not plan["ok"]:
                    return blocked("correction_unavailable", plan["message"], detail=plan["code"])
                return finish({"outcome": "input-required", "correction": plan})
            return blocked("unexpected_state", f"the validator left the lineage {last['state']}")

        # ---- resume by lineage ----
        if st["lineage"] is not _U:
            if "requestContextPath" in input:
                return blocked("request_context_requires_fresh_review", "a request context is only accepted when a fresh review starts")
            try:
                rec = read_state(common_dir, st["lineage"])
            except (StoreNotFoundError, StoreInvalidLineageError):
                return blocked("unknown_lineage", f"no review authority exists for lineage {_to_string(st['lineage'])}")
            if current_identity() != rec["target_identity"]:
                if rec["state"] in ("correction_required", "validating"):
                    return after_correction(rec)
                st["target"] = rec["target_identity"]
                return drift("target", "the candidate changed since this lineage was started")

        started = False
        for _count in range(math.ceil(max_transitions) if max_transitions != float("inf") else 1 << 62):
            if aborted():
                return cancelled()
            env = status_of()
            st["transitions"] += 1
            offered = (env.get("authority") or {}).get("lineage_id")
            if offered is not None:
                if st["lineage"] is not _U and st["lineage"] != offered:
                    return drift("lineage", "status offered another lineage than the one this run follows")
                st["lineage"] = offered
            if st["target"] is not _U and st["target"] != env["target_identity"]:
                return drift("target", "the candidate changed during the run")
            st["target"] = env["target_identity"]
            nxt = env["next_transition"]

            if "requestContextPath" in input and not started and env.get("authority") is not None:
                return blocked("request_context_requires_fresh_review", "a review already exists for this candidate; a request context needs a fresh review")

            if nxt["kind"] == "stop":
                return finish({"outcome": "not-due"}) if nxt["reason_code"] == "not_due" else stopped(nxt["reason_code"])

            if nxt["kind"] == "execute":
                exe = nxt["execute"]
                if exe["operation"] == "review.start":
                    if started or st["lineage"] is not _U:
                        return blocked("unexpected_start", "status offered a start for a candidate that already has a lineage")
                    pending = pending_correction_lineage(input["cwd"], snap_target)
                    if pending is not None:
                        if "unreadable" in pending:
                            st["lineage"] = pending["unreadable"]
                            return blocked("authority_error", f"lineage {pending['unreadable']} cannot be read safely; no new review is opened until it is repaired", detail="StoreCorruptError")
                        st["lineage"] = pending["rec"]["lineage_id"]
                        return blocked("correction_lineage_pending", f"lineage {pending['rec']['lineage_id']} is waiting for its correction ({pending['rec']['state']}); resume it with lineageId instead of opening a new review")
                    started = True
                    risk_assessor = deps["riskAssessor"] if deps.get("riskAssessor") is not None else (lambda snapshot, repository: assess_risk(snapshot, repository))
                    outcome = start_review({
                        "cwd": input["cwd"],
                        "target": start_target,
                        **({"projection": input["projection"]} if "projection" in input else {}),
                        **({"lenses": input["lenses"]} if "lenses" in input else {}),
                        **({"lensesReason": input["lensesReason"]} if "lensesReason" in input else {}),
                        "consent": "relay",
                        **({"locale": input["locale"]} if "locale" in input else {}),
                        **({"requestContext": input["requestContextPath"]} if "requestContextPath" in input else {}),
                        "riskAssessor": risk_assessor,
                    })
                    s = outcome["status"]
                    if s == "consent_required":
                        return finish({"outcome": "consent-required", "envelope": outcome["envelope"]})
                    if s == "not_due":
                        return finish({"outcome": "not-due"})
                    if s == "declined":
                        return stopped("consent_declined")
                    if s == "refused":
                        return blocked("start_refused", outcome["message"], detail=outcome["code"])
                    if s == "started":
                        st["lineage"] = outcome["result"]["lineage_id"]
                        st["target"] = outcome["result"]["target_identity"]
                        if outcome["result"].get("acknowledgement") is not None:
                            st["ack"] = dict(outcome["result"]["acknowledgement"])
                    continue
                if exe["operation"] == "review.validate":
                    done = complete_review(common_dir, exe["binding"]["lineage_id"], exe["binding"]["revision"])
                    if not done["ok"]:
                        return blocked("capture_refused", done["message"], detail=done["code"])
                    remember_ack(done)
                    continue
                if exe["operation"] == "review.acknowledge-approved":
                    if st["ack"] is None:
                        return stopped("acknowledgement_token_unavailable")
                    return acknowledge(exe["binding"]["lineage_id"], exe["binding"]["target_identity"], exe["binding"]["revision"], st["ack"]["token"])
                return blocked("unsupported_transition", f"status offered the unsupported operation {exe['operation']}")

            # collect
            inputs = nxt["collect"]["inputs"]
            if st["lineage"] is _U:
                return blocked("unsupported_transition", "status offered a collect without a lineage")
            lineage_id = st["lineage"]
            if any(i["name"] == "corrected_candidate" for i in inputs):
                plan = plan_correction(common_dir, lineage_id)
                if not plan["ok"]:
                    return blocked("correction_unavailable", plan["message"], detail=plan["code"])
                return finish({"outcome": "input-required", "correction": plan})
            if any(i["name"] == "validator_result" for i in inputs):
                return after_correction(read_state(common_dir, lineage_id))

            rec = read_state(common_dir, lineage_id)
            manifest = manifest_for(common_dir, rec)["paths"]
            slots: list[dict] = []
            for inp in inputs:
                binding = next((a["value"] for a in inp["arguments"] if a["name"] == "binding"), None)
                if binding is None:
                    return blocked("unsupported_transition", f"status offered {inp['name']} without a binding")
                if inp["name"].startswith("reviewer_result_"):
                    subject = inp["artifact_subject"]
                    echo = {"subject_hash": subject["subject_hash"]}

                    def capture_lens(revision: str, value: dict, subject: dict = subject, lineage_id: str = lineage_id) -> dict:
                        return capture_lens_result(common_dir, lineage_id, revision, {"lens": subject["lens"], "subject": subject, "result": value})

                    slots.append({
                        "role": "lens", "lens": subject["lens"], "binding": binding, "echo": echo,
                        "prompt": {"subject": subject, "binding": echo, "baseTree": inp["base_tree"], "candidateTree": inp["candidate_tree"], "paths": manifest},
                        "capture": capture_lens,
                    })
                elif inp["name"] == "refuter_result":
                    echo = {"refuter_request_hash": refuter_request_hash(rec)}
                    blocking = set(blocking_finding_ids(rec))

                    def capture_refuter(revision: str, value: dict, lineage_id: str = lineage_id) -> dict:
                        return capture_refuter_result(common_dir, lineage_id, revision, {"result": value})

                    slots.append({
                        "role": "refuter", "binding": binding, "echo": echo,
                        "prompt": {
                            "subject": {**echo, "lineage_id": lineage_id, "target_identity": rec["target_identity"]},
                            "binding": echo, "baseTree": rec["base_tree"], "candidateTree": rec["candidate_tree"], "paths": manifest,
                            "findings": [f for f in rec["findings"] if f["id"] in blocking],
                        },
                        "capture": capture_refuter,
                    })
                else:
                    return blocked("unsupported_transition", f"status offered the unsupported collect input {inp['name']}")

            def recheck_status() -> dict:
                after = status_of()["next_transition"]
                return {"kind": after["kind"], "reason_code": after["reason_code"]}

            batch = run_batch(slots, {"lineage": lineage_id, "revision": rec["revision"], "expectedIdentity": env["target_identity"], "forecast": env["forecast"], "recheck": recheck_status})
            if not batch["done"]:
                return batch["outcome"]
            if deps.get("stopAfterBatch") is True:
                return finish({"outcome": "captured", "capture": encode_capture_envelope(batch["last"])})
            remember_ack(batch["last"])
        return finish({"outcome": "transition-limit", "limit": max_transitions})
    except SnapshotError as e:
        return blocked("snapshot_error", str(e), detail=e.code)
    except AckRefusedError as e:
        return blocked("acknowledge_refused", str(e), detail=e.code)
    except _STORE_ERRORS as e:
        return blocked("authority_error", str(e), detail=type(e).__name__)


__all__ = [
    "MAX_TRANSITIONS", "DEFAULT_CONCURRENCY", "REVIEWER_MODELS", "REVIEWER_EFFORTS", "AbortSignal", "validate_reviewer_options",
    "pending_correction_lineage", "run_review",
]
