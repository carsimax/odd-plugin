"""Acknowledge / burn (port of v9 review/ack.ts): spends an approval exactly once and leaves a receipt that gates can check.

The raw token is checked against the stored domain hash (constant-time, `state.burn`), the target identity and the live
revision must match, and the approval can be spent once.

Crash-safe ordering: RECEIPT FIRST, BURN SECOND, both inside ONE store lock (`update_state`):
  1. token / target / state / revision are verified with no side effect;
  2. `review-receipt.json` is written create-only and atomically (inert while the state is still unburned);
  3. the burned state is written (the CAS commit; the irreversible step, last).
A crash between 2 and 3 leaves "approved + receipt, unburned": a retry with the same token and revision finds the receipt,
verifies it equals what it would write (reusing its `burned_at`) and only commits the burn. "Burned without a receipt" is
unreachable through this module. Gates read consumption from the BURNED STATE plus a VALID matching receipt, never from the
receipt alone. The bound candidate is the record's `target_identity` (after a validated correction, the corrected one).

Python shapes: `acknowledge_approved(common_dir, input, options)` is synchronous; `input` is v9's camelCase dict
(`lineage`, `target`, `expectedRevision`, `token`); `options` is `AcknowledgeOptions` (`StoreOptions` plus `now`, a zero-argument
clock returning an RFC 3339 UTC string) and the result `{"ok": True, "record", "receipt"}`. Scan options are v9's dict
`{"limit", "maxScan"}`; results use v9's keys (`burnedLineages`, `status`, `consumed`, `truncated`, `problems`,
`correctionBudget`, ...). Receipts are plain dicts with v9's snake_case keys.
Public API: `RECEIPT_SCHEMA`, `AckRefusedError`, `AcknowledgeOptions`, `validate_receipt`, `acknowledge_approved`, `scan_target`,
`find_receipt_for_target`, `is_target_consumed`, `budget_status`.
"""
import hmac
import os
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable

from ..lib.js import js_keys
from .canonical import canonical_json, domain_hash
from .state import LENSES, MAX_CORRECTION_ATTEMPTS, _is_time, burn
from .store import (
    _UNDEF,
    StoreConcurrentUpdateError,
    StoreCorruptError,
    StoreInvalidLineageError,
    StoreNotFoundError,
    StoreOptions,
    list_lineages,
    read_receipt,
    read_state,
    store_root_for,
    update_state,
    write_atomic,
)

RECEIPT_SCHEMA = "odd-claude.review-receipt/v1"
_RECEIPT_FILE = "review-receipt.json"
_SHA_RE = re.compile(r"sha256:[0-9a-f]{64}")
_TREE_RE = re.compile(r"(?:[0-9a-f]{40}|[0-9a-f]{64})")
_LINEAGE_RE = re.compile(r"review-[0-9a-f]{16}")


class AckRefusedError(Exception):
    """`code` is one of invalid_input, wrong_token, wrong_target, concurrent_update, not_approved, authority_absent,
    target_already_acknowledged, corrupt_receipt."""

    def __init__(self, code: str, message: str, cause: BaseException | None = None):
        super().__init__(f"acknowledge refused ({code}): {message}")
        self.code = code
        if cause is not None:
            self.__cause__ = cause


@dataclass
class AcknowledgeOptions(StoreOptions):
    #: Test seam: RFC 3339 UTC clock for `burned_at`.
    now: Callable[[], str] | None = None


def _receipt_hash_of(body: dict) -> str:
    return domain_hash("review-receipt", 1, body)


def _build_receipt(approved: dict, burned: dict, burned_at: str) -> dict:
    body = {
        "schema": RECEIPT_SCHEMA, "lineage_id": approved["lineage_id"], "target_identity": approved["target_identity"], "projection": approved["projection"],
        "base_tree": approved["base_tree"], "candidate_tree": approved["candidate_tree"], "approved_revision": approved["revision"], "burned_at": burned_at,
        "selected_lenses": list(approved["selected_lenses"]), "risk_level": approved["risk_level"], "ledger_hash": approved.get("ledger_hash") or "",
        "evidence_hash": approved.get("evidence_hash") or "", "burn_receipt": burned.get("burn_receipt") or "",
    }
    return {**body, "receipt_hash": _receipt_hash_of(body)}


_RECEIPT_KEYS = ["schema", "lineage_id", "target_identity", "projection", "base_tree", "candidate_tree", "approved_revision",
                 "burned_at", "selected_lenses", "risk_level", "ledger_hash", "evidence_hash", "burn_receipt", "receipt_hash"]


def validate_receipt(input: Any) -> dict:
    """Strict structural validation plus recomputation of `receipt_hash`: `{"ok": True, "receipt"}` or `{"ok": False, "errors"}`."""
    if not isinstance(input, dict):
        return {"ok": False, "errors": ["receipt must be an object"]}
    o = input
    errors = [f"unknown field {k}" for k in js_keys(o) if k not in _RECEIPT_KEYS] + [f"missing field {k}" for k in _RECEIPT_KEYS if k not in o]
    if errors:
        return {"ok": False, "errors": errors}
    if o["schema"] != RECEIPT_SCHEMA:
        errors.append(f"schema must be {RECEIPT_SCHEMA}")
    if not isinstance(o["lineage_id"], str) or not _LINEAGE_RE.fullmatch(o["lineage_id"]):
        errors.append("lineage_id must match review-<16 hex>")
    for k in ("target_identity", "approved_revision", "ledger_hash", "evidence_hash", "burn_receipt", "receipt_hash"):
        if not isinstance(o[k], str) or not _SHA_RE.fullmatch(o[k]):
            errors.append(f"{k} must be sha256:<64 hex>")
    if o["projection"] != "workspace" and o["projection"] != "staged":
        errors.append("projection must be workspace or staged")
    for k in ("base_tree", "candidate_tree"):
        if not isinstance(o[k], str) or not _TREE_RE.fullmatch(o[k]):
            errors.append(f"{k} must be a tree id")
    if not _is_time(o["burned_at"]):
        errors.append("burned_at must be a UTC RFC 3339 timestamp")
    if o["risk_level"] not in ("low", "medium", "high") or not isinstance(o["risk_level"], str):
        errors.append("risk_level must be low, medium or high")
    ls = o["selected_lenses"]
    if not isinstance(ls, list) or not all(isinstance(x, str) and x in LENSES for x in ls):
        errors.append("selected_lenses must be a list of known lenses")
    if not errors and o["receipt_hash"] != _receipt_hash_of({k: v for k, v in o.items() if k != "receipt_hash"}):
        errors.append("receipt_hash does not match the receipt content")
    return {"ok": False, "errors": errors} if errors else {"ok": True, "receipt": o}


def _refusal_for(code: str, message: str) -> AckRefusedError:
    if code in ("token_malformed", "token_mismatch"):
        return AckRefusedError("wrong_token", message)
    if code == "illegal_state":
        return AckRefusedError("not_approved", message)
    if code == "already_burned":
        return AckRefusedError("target_already_acknowledged", message)
    return AckRefusedError("invalid_input", message)


def _iso_now() -> str:
    t = datetime.now(timezone.utc)
    return t.strftime("%Y-%m-%dT%H:%M:%S.") + f"{t.microsecond // 1000:03d}Z"


def _same_json(a: Any, b: Any) -> bool:
    return hmac.compare_digest(canonical_json(a).encode("utf-8"), canonical_json(b).encode("utf-8"))


def _lstat_exists(path: str) -> bool:
    try:
        os.lstat(path)
        return True
    except FileNotFoundError:
        return False


def _safe_read_state(common_dir: str, lineage: Any) -> dict | None:
    try:
        return read_state(common_dir, lineage)
    except Exception:  # noqa: BLE001
        return None


def acknowledge_approved(common_dir: str, input: dict, options: AcknowledgeOptions | None = None) -> dict:
    """Burns the approved lineage with its one-shot token and writes the receipt (see the ordering note above). Returns
    `{"ok": True, "record", "receipt"}` or raises `AckRefusedError` with a typed code (state unchanged). Idempotent completion:
    after a crash between receipt and burn, retry with the SAME token and revision."""
    options = options or AcknowledgeOptions()
    inp = input if isinstance(input, dict) else {}
    target, expected = inp.get("target"), inp.get("expectedRevision")
    if not isinstance(target, str) or not _SHA_RE.fullmatch(target):
        raise AckRefusedError("invalid_input", "target must be sha256:<64 hex>")
    if not isinstance(expected, str) or not _SHA_RE.fullmatch(expected):
        raise AckRefusedError("invalid_input", "expectedRevision must be sha256:<64 hex>")
    clock = options.now or _iso_now
    lineage = inp.get("lineage", _UNDEF)
    burn_input = {"token": inp["token"]} if "token" in inp else {}
    box: dict = {}

    def transition(record: dict) -> dict:
        if record["state"] != "approved":
            raise AckRefusedError("not_approved", f"the review is {record['state']}, not approved")
        if record["burned"]:
            raise AckRefusedError("target_already_acknowledged", "this approval was already acknowledged")
        if record["target_identity"] != target:
            raise AckRefusedError("wrong_target", "the target does not match this lineage")
        # 1. verify the token with no side effect (burn is pure; the compare is constant-time).
        probe = burn(record, {**burn_input, "now": clock()})
        if not probe["ok"]:
            raise _refusal_for(probe["refusal"]["code"], probe["refusal"]["message"])
        # 2. an existing receipt is a crashed earlier attempt: it must be exactly what we would write; reuse its burned_at.
        file = os.path.join(store_root_for(common_dir), record["lineage_id"], _RECEIPT_FILE)
        existing = None
        try:
            existing = read_receipt(common_dir, record["lineage_id"])
        except StoreCorruptError as e:
            raise AckRefusedError("corrupt_receipt", str(e), e) from e
        except StoreNotFoundError:
            pass
        burned_at = probe["record"]["updated_at"]
        if existing is not None:
            v = validate_receipt(existing)
            if not v["ok"]:
                raise AckRefusedError("corrupt_receipt", f"existing receipt is invalid: {'; '.join(v['errors'])}")
            burned_at = v["receipt"]["burned_at"]
        burned = probe if existing is None else burn(record, {**burn_input, "now": burned_at})
        if not burned["ok"]:
            raise _refusal_for(burned["refusal"]["code"], burned["refusal"]["message"])
        built = _build_receipt(record, burned["record"], burned_at)
        if existing is not None:
            if not _same_json(existing, built):
                raise AckRefusedError("corrupt_receipt", "an existing receipt does not match this approval")
        else:
            if _lstat_exists(file):
                raise AckRefusedError("corrupt_receipt", "a receipt path exists but could not be read as a receipt")
            write_atomic(file, canonical_json(built) + "\n")
        box["receipt"] = built
        # 3. the CAS commit of the burn is written by update_state right after this returns.
        return burned

    try:
        out = update_state(common_dir, lineage, expected, transition, options)
        return {"ok": True, "record": out["record"], "receipt": box["receipt"]}
    except StoreConcurrentUpdateError as e:
        cur = _safe_read_state(common_dir, lineage)
        if cur is not None and cur["state"] == "approved" and cur["burned"]:
            raise AckRefusedError("target_already_acknowledged", "this approval was already acknowledged", e) from e
        raise AckRefusedError("concurrent_update", str(e), e) from e
    except StoreInvalidLineageError as e:
        raise AckRefusedError("invalid_input", str(e), e) from e
    except StoreNotFoundError as e:
        raise AckRefusedError("authority_absent", "no review authority exists for this lineage", e) from e


# ---- gate helpers ----


def scan_target(common_dir: str, target_identity: str, options: dict | None = None) -> dict:
    """Bounded scan (`store.list_lineages`). Consumption is read from the burned state; the receipt must also match it.
    `{"receipts" (valid, newest `burned_at` first), "burnedLineages", "truncated", "problems": [{"lineage","code","message"}]}`;
    problem codes: state_unreadable, receipt_missing, receipt_corrupt, receipt_mismatch."""
    opts = options or {}
    listing = list_lineages(common_dir, opts.get("limit"), opts.get("maxScan"))
    scan: dict = {"receipts": [], "burnedLineages": [], "truncated": listing["truncated"], "problems": []}
    for lineage in listing["lineages"]:
        try:
            state = read_state(common_dir, lineage)
        except StoreNotFoundError:
            continue
        except Exception as e:  # noqa: BLE001
            scan["problems"].append({"lineage": lineage, "code": "state_unreadable", "message": str(e)})
            continue
        if state["target_identity"] != target_identity or state["state"] != "approved" or not state["burned"]:
            continue
        scan["burnedLineages"].append(lineage)
        try:
            raw = read_receipt(common_dir, lineage)
        except Exception as e:  # noqa: BLE001
            scan["problems"].append({"lineage": lineage, "code": "receipt_missing" if isinstance(e, StoreNotFoundError) else "receipt_corrupt", "message": str(e)})
            continue
        v = validate_receipt(raw)
        if not v["ok"]:
            scan["problems"].append({"lineage": lineage, "code": "receipt_corrupt", "message": "; ".join(v["errors"])})
            continue
        r = v["receipt"]
        if not (
            r["lineage_id"] == lineage and r["target_identity"] == state["target_identity"] and r["burn_receipt"] == state.get("burn_receipt")
            and r["burned_at"] == state["updated_at"] and r["candidate_tree"] == state["candidate_tree"] and r["base_tree"] == state["base_tree"]
            and r["projection"] == state["projection"] and r["risk_level"] == state["risk_level"] and _same_json(r["selected_lenses"], state["selected_lenses"])
            and r["ledger_hash"] == state.get("ledger_hash") and r["evidence_hash"] == state.get("evidence_hash")
            and r["approved_revision"] == state.get("approved_revision")
        ):
            scan["problems"].append({"lineage": lineage, "code": "receipt_mismatch", "message": "the receipt does not match the burned state"})
            continue
        scan["receipts"].append(r)
    scan["receipts"].sort(key=lambda r: r["burned_at"], reverse=True)
    return scan


def find_receipt_for_target(common_dir: str, target_identity: str, options: dict | None = None) -> dict:
    """The newest valid receipt of a burned lineage for the target, ignoring every other lineage: `{"receipt"?, "truncated", "problems"}`."""
    scan = scan_target(common_dir, target_identity, options)
    return {**({"receipt": scan["receipts"][0]} if scan["receipts"] else {}), "truncated": scan["truncated"], "problems": scan["problems"]}


def is_target_consumed(common_dir: str, target_identity: str, options: dict | None = None) -> dict:
    """`status` "consumed": a burned lineage for the target has a valid receipt matching its burned state. "unknown": no such
    receipt, and some lineage could not be proven (a gate must treat it as blocked). "not_consumed": nothing is burned and
    nothing is in doubt (still check `truncated`). `consumed` is True ONLY for "consumed". A receipt alone never counts."""
    scan = scan_target(common_dir, target_identity, options)
    status = "consumed" if scan["receipts"] else "unknown" if scan["problems"] else "not_consumed"
    return {"status": status, "consumed": status == "consumed", "truncated": scan["truncated"], "problems": scan["problems"]}


def budget_status(record: dict) -> dict:
    used = record.get("actual_correction_lines")
    used = 0 if used is None else used
    return {
        "correctionBudget": record["correction_budget"], "actualCorrectionLines": used, "linesRemaining": max(0, record["correction_budget"] - used),
        "attempts": record["correction_attempts"], "attemptsRemaining": max(0, MAX_CORRECTION_ATTEMPTS - record["correction_attempts"]),
    }
