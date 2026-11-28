"""Differential: review/contract against v9 dist/review/contract.js through the oracle: every exported function (forecastFor,
isTerminalStop, isRecoverableStop, encode/decode/verifyBinding, the five envelope encoders) over Unicode, malformed, crafted-payload
and missing-key inputs, the exported constants, and `encodeAckEnvelope` with a real v9 `AckRefusedError`. `verifyBinding` subject
checks run against a real temp git repo and store shared by both sides."""
import base64
import json
import os
import subprocess
from pathlib import Path

import pytest
from lib.v9_oracle import DIST, needs_v9
from odd_claude.review import contract as C
from odd_claude.review.ack import AckRefusedError
from odd_claude.review.artifact import lens_artifact_subject
from odd_claude.review.canonical import domain_hash
from odd_claude.review.store import read_state

from review.conftest import diff_cases
from review.test_start import assess, base, git, make_repo  # noqa: F401
from odd_claude.review.start import start_review

pytestmark = needs_v9
MOD = "review/contract"


def same(fn, py_fn, calls):
    diff_cases(MOD, fn, py_fn, calls)


def sha(c):
    return "sha256:" + c * 64


LIN = "review-0123456789abcdef"
B = {"role": "lens", "lens": "risk", "target_identity": sha("b"), "lineage_id": LIN, "revision": sha("a")}


def crafted(raw: bytes) -> str:
    """A binding string whose payload is `raw` and whose tag is right, so only the payload rules are exercised."""
    pl = base64.urlsafe_b64encode(raw).rstrip(b"=").decode()
    return f"odd1.{pl}.{domain_hash('transition-binding', 1, pl)[7:]}"


def tagged(pl: str) -> str:
    return f"odd1.{pl}.{domain_hash('transition-binding', 1, pl)[7:]}"


def rec(**over):
    return {"lineage_id": LIN, "revision": sha("a"), "target_identity": sha("b"), "state": "reviewing", "burned": False, **over}


BINDINGS = [
    B, {**B, "role": "start"}, {"role": "start", "target_identity": sha("b")}, {**B, "role": "acknowledge"}, {**B, "role": "refuter"}, {**B, "role": "complete"},
    {**B, "role": "correction"}, {**B, "role": "validator"}, {**B, "subject_hash": sha("9")}, {**B, "lens": "é\U0001f600\ud800"}, {**B, "lens": ""}, {**B, "lineage_id": ""},
    {**B, "extra": 1}, {**B, "role": "x"}, {**B, "role": 5}, {**B, "target_identity": "x"}, {**B, "revision": "sha256:" + "G" * 64}, {**B, "subject_hash": 5}, {**B, "lens": 5},
    {"role": "lens", "target_identity": sha("b")}, {**B, "revision": None}, {**B, "lens": None}, {"z": 1, "a": 2, **B}, {**B, "é": 1}, {**B, "__proto__": 1}, {**B, "target_identity": sha("b") + "\n"},
]


def test_forecast_and_stop_predicates():
    codes = [*C.TERMINAL_STOP_CODES, *C.RECOVERABLE_STOP_CODES, *C.ACTIVE_REASON_CODES, "nope", "", "constructor", "toString", "__proto__", "é", None, 5, True]
    same("forecastFor", C.forecast_for, [[k, c] for k in ("stop", "collect", "execute", "", "other", None, 1) for c in codes])
    same("isTerminalStop", C.is_terminal_stop, [[c] for c in codes])
    same("isRecoverableStop", C.is_recoverable_stop, [[c] for c in codes])


def test_encode_binding_equals_v9():
    same("encodeBinding", C.encode_binding, [[b] for b in BINDINGS])


def binding_strings():
    out = [encode for encode in (C.encode_binding(b) for b in BINDINGS)]
    s = C.encode_binding(B)
    p, pl, tag = s.split(".")
    out += [
        s, "", "nope", "a.b", "a.b.c.d", f"{p}.{pl}", f"{p}.{pl}.{tag}.", f"{p}.{pl}\n.{tag}", f"{p}.{pl} .{tag}", f"{p}.{pl}.{'0' * 64}", f"{p}.{pl}.{tag.upper()}", f"x1.{pl}.{tag}",
        f"{p}..{domain_hash('transition-binding', 1, '')[7:]}", f"{p}.é.{tag}", f"{p}.a=.{tag}", f"{p}.{pl}=.{tag}", f"{p}.a+b/c.{tag}", f"{p}.\n.{tag}",
    ]
    # crafted payloads with a valid tag: JSON forms and byte-level oddities
    good = json.dumps(B, separators=(",", ":")).encode()
    for raw in (
        good, b"[1]", b"null", b"1", b'"s"', b"nope", b"", b"{}", b"\xef\xbb\xbf" + good, b" " + good + b" ", good + b"x", b'{"a":1,"a":2}', b"\xff\xfe", good.replace(b'"risk"', b'"\xff"'),
        good.replace(b'"risk"', b'"\\ud800"'), good.replace(b'"risk"', b'"\xe2\x82"'), b'{"__proto__":{"role":"lens"}}', json.dumps({**B, "role": "start"}).encode(), b'{"role":"start","target_identity":"' + sha("b").encode() + b'","lens":"x"}',
        b'{"role":"start","target_identity":"' + sha("b").encode() + b'","lineage_id":"l","revision":null}', b"[" * 3000 + b"]" * 3000, b"\x00" + good, good.replace(b"risk", "é\U0001f600".encode()),
    ):
        out.append(crafted(raw))
    # alphabet-only payloads that are not canonical base64 (length % 4 == 1, dangling bits, url alphabet characters)
    enc = base64.urlsafe_b64encode(good).rstrip(b"=").decode()
    for pl2 in (enc + "A", enc[:-1], enc[:-2], enc + "AA", enc + "AAA", "e30", "e30A", "e31", "e3", "-_-_", "____", "A", "AA", "AAA", "AAAA", enc.replace("e", "-", 3)):
        out.append(tagged(pl2))
    return out


def test_decode_binding_equals_v9():
    same("decodeBinding", C.decode_binding, [[s] for s in binding_strings()] + [[v] for v in (None, 5, 1.5, True, [], {}, ["odd1"], {"a": 1})])


def test_verify_binding_equals_v9():
    cur = {"targetIdentity": sha("b"), "lineage": rec()}
    currents = [
        cur, {**cur, "targetIdentity": sha("d")}, {**cur, "lineage": None}, {"targetIdentity": sha("b")}, {}, {**cur, "lineage": rec(lineage_id="review-ffffffffffffffff")},
        {**cur, "lineage": rec(revision=sha("e"))}, {**cur, "lineage": rec(state="escalated")}, {**cur, "lineage": rec(state="approved")}, {**cur, "lineage": rec(state="approved", burned=True)},
        {**cur, "lineage": rec(state="validating")}, {**cur, "lineage": rec(state="correction_required")}, {**cur, "lineage": rec(burned=1)}, {**cur, "lineage": rec(burned="")},
        {**cur, "lineage": {}}, {**cur, "lineage": rec(state=None)}, {**cur, "commonDir": "/nonexistent-odd-claude-dir"}, {**cur, "commonDir": None}, {**cur, "commonDir": ""},
        {**cur, "commonDir": 5}, {**cur, "lineage": 0}, {**cur, "lineage": ""},
    ]
    strings = [C.encode_binding(b) for b in BINDINGS] + ["junk", None, 5]
    same("verifyBinding", C.verify_binding, [[s, c] for s in strings for c in currents])


def test_verify_binding_subject_against_a_real_store(make_repo):  # noqa: F811
    r = make_repo()
    result = start_review(base(r, "high"))["result"]
    record = read_state(r.common_dir, result["lineage_id"])
    subject = lens_artifact_subject(r.common_dir, record, "risk")
    assert subject is not None
    good = {"role": "lens", "lens": "risk", "target_identity": record["target_identity"], "lineage_id": record["lineage_id"], "revision": record["revision"]}
    cur = {"targetIdentity": record["target_identity"], "lineage": record, "commonDir": r.common_dir}
    calls = []
    for b in (
        {**good, "subject_hash": subject["subject_hash"]}, {**good, "subject_hash": sha("9")}, {**good, "subject_hash": subject["subject_hash"], "lens": "nolens"},
        {**good, "subject_hash": subject["subject_hash"], "lens": "reliability"}, {**good, "subject_hash": subject["subject_hash"], "lens": "é"}, good,
        {**good, "subject_hash": subject["subject_hash"], "role": "refuter"},
    ):
        for c in (cur, {**cur, "commonDir": str(Path(r.common_dir) / "missing")}, {**cur, "commonDir": str(Path(r.common_dir).parent)}, {k: v for k, v in cur.items() if k != "commonDir"}):
            calls.append([C.encode_binding(b), c])
    same("verifyBinding", C.verify_binding, calls)
    assert C.verify_binding(calls[0][0], cur)["ok"] is True


ENVELOPE_INPUTS = [
    {"cwd": "/r", "targetIdentity": sha("b"), "projection": "workspace", "riskLevel": "high", "changedFiles": 1, "changedLines": 2, "riskEvidence": ["e"], "targetArgs": ["--target", "current-changes"]},
    {"cwd": "/my repo é", "targetIdentity": sha("b"), "projection": "staged", "riskLevel": "medium", "changedFiles": 0, "changedLines": 0, "riskEvidence": [], "targetArgs": ["--target", "base-diff", "--base-ref", "main"],
     "lenses": {"names": ["risk", "reliability"], "reason": "it's é\U0001f600"}, "locale": "es-MX", "agent": "other"},
    {"cwd": "/r", "targetIdentity": sha("c"), "projection": "workspace", "riskLevel": "high", "changedFiles": 3, "changedLines": 9, "riskEvidence": ["a", "b"], "targetArgs": ["--target", "current-changes"], "locale": "en-US"},
]


def test_encode_consent_envelope_equals_v9():
    same("encodeConsentEnvelope", C.encode_consent_envelope, [[i] for i in ENVELOPE_INPUTS])


def test_encode_start_envelope_equals_v9():
    result = {"schema": "s", "x": [1, {"y": None}], "é": "\U0001f600"}
    env = C.encode_consent_envelope(ENVELOPE_INPUTS[1])
    outcomes = [
        {"status": "started", "result": result}, {"status": "started", "result": {}}, {"status": "started"}, {"status": "started", "result": None}, {"status": "started", "result": "ab"}, {"status": "started", "result": [1, 2]},
        {"status": "consent_required", "envelope": env}, {"status": "consent_required"},
        {"status": "not_due", "reason": "no_changes", "kind": "current-changes", "projection": "workspace"}, {"status": "not_due"}, {"status": "not_due", "reason": None, "kind": "é", "projection": 5},
        {"status": "declined", "target_identity": sha("b"), "projection": "workspace", "risk_level": "high", "record_path": "/p"}, {"status": "declined"}, {"status": "declined", "target_identity": None},
        {"status": "refused", "code": "target_already_acknowledged", "message": "m", "lineage_id": LIN}, {"status": "refused", "code": "c", "message": "é\U0001f600"}, {"status": "refused"},
        {"status": "refused", "code": "c", "message": "m", "lineage_id": None}, {"status": "weird"}, {"status": None}, {}, {"status": "started", "result": result, "extra": 1},
    ]
    same("encodeStartEnvelope", C.encode_start_envelope, [[o] for o in outcomes])


def test_encode_capture_envelope_equals_v9():
    ok = {"ok": True, "state": "approved", "next": "approved", "ackToken": "f" * 64, "revision": sha("a"), "record": rec(state="approved"), "pending_lenses": ["resilience", "review-risk"]}
    outcomes = [
        ok, {**ok, "ackToken": None}, {k: v for k, v in ok.items() if k != "ackToken"}, {**ok, "pending_refutation": ["f1", "é"]}, {**ok, "pending_refutation": []}, {**ok, "pending_lenses": []},
        {**ok, "pending_lenses": ["é", "review-é", ""]}, {**ok, "state": None, "next": None}, {k: v for k, v in ok.items() if k not in ("state", "next", "revision")}, {**ok, "record": {}},
        {**ok, "record": {"lineage_id": LIN}}, {**ok, "ok": 1}, {**ok, "ok": "x"},
        {"ok": False, "code": "concurrent_update", "message": "m", "currentRevision": sha("c")}, {"ok": False, "code": "invalid_input", "message": "m", "errors": ["e1", "é"]},
        {"ok": False, "code": "c", "message": "m", "errors": []}, {"ok": False}, {"ok": 0, "code": "c"}, {"ok": None, "code": "c", "message": "m", "currentRevision": None}, {}, {"ok": False, "code": "c", "errors": "ab"},
    ]
    same("encodeCaptureEnvelope", C.encode_capture_envelope, [[o] for o in outcomes])


def test_encode_capture_dry_run_equals_v9():
    calls = [
        [{"lineage_id": LIN, "lens": "risk", "selected_order": 0, "subject_hash": sha("1")}], [{"lineage_id": LIN, "lens": "review-risk", "selected_order": 3, "subject_hash": sha("1")}],
        [{"lineage_id": LIN, "lens": "é", "selected_order": -1, "subject_hash": "h"}], [{"lens": "risk"}], [{"lens": "", "lineage_id": None, "selected_order": None}], [{"lens": "review-", "selected_order": 1.5}],
    ]
    same("encodeCaptureDryRun", C.encode_capture_dry_run, calls)


RECEIPT = {
    "schema": "odd-claude.review-receipt/v1", "lineage_id": LIN, "target_identity": sha("b"), "projection": "workspace", "base_tree": "1" * 40, "candidate_tree": "2" * 40,
    "approved_revision": sha("a"), "burned_at": "2026-11-19T10:00:00.000Z", "selected_lenses": ["risk", "é"], "risk_level": "high", "ledger_hash": sha("3"), "evidence_hash": sha("4"),
    "burn_receipt": sha("5"), "receipt_hash": sha("6"),
}


def test_encode_ack_envelope_equals_v9():
    results = [
        {"ok": True, "record": rec(state="approved", burned=True), "receipt": RECEIPT}, {"ok": True, "record": rec(), "receipt": {**RECEIPT, "selected_lenses": []}},
        {"ok": True, "record": {}, "receipt": RECEIPT}, {"record": rec(burned=None), "receipt": {**RECEIPT, "x": 1}}, {"record": rec(), "receipt": {"selected_lenses": ["a"], "z": 1}},
    ]
    same("encodeAckEnvelope", C.encode_ack_envelope, [[r] for r in results])


NODE = r"""
const [dist, payload] = process.argv.slice(1);
const ack = await import(dist + "/review/ack.js");
const c = await import(dist + "/review/contract.js");
const esc = (s) => s.replace(/[\u0080-￿]/g, (ch) => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0"));
const out = [];
for (const [code, msg] of JSON.parse(payload)) out.push(c.encodeAckEnvelope(new ack.AckRefusedError(code, msg)));
const consts = {};
for (const [k, v] of Object.entries(c)) if (typeof v !== "function") consts[k] = v;
process.stdout.write(esc(JSON.stringify({ out, consts })));
"""


def test_ack_refusal_and_constants_equal_v9():
    cases = [["wrong_token", "bad"], ["invalid_input", ""], ["not_approved", "é\U0001f600 multi\nline"], ["corrupt_receipt", "x" * 300]]
    r = subprocess.run(["node", "--input-type=module", "-e", NODE, DIST.as_uri(), json.dumps(cases)], capture_output=True, text=True, encoding="ascii", timeout=60)
    assert r.returncode == 0, r.stderr
    v9 = json.loads(r.stdout)
    assert v9["out"] == [C.encode_ack_envelope(AckRefusedError(c, m)) for c, m in cases]
    py = {k: v for k, v in vars(C).items() if k.isupper() and not k.startswith("_") and not isinstance(v, (type, type(C)))}
    norm = lambda v: json.loads(json.dumps(v))  # noqa: E731  (tuples -> lists)
    assert {k: norm(v) for k, v in py.items()} == v9["consts"]
