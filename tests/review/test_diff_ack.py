"""Differential: review/ack against v9 dist/review/ack.js. `validateReceipt` and `budgetStatus` go through the oracle. Everything that
touches a store runs a JSON list of operations (seed, ack, raw file edits, scans) against v9 through a node driver on one fresh
directory and against Python on another; per-operation results (value or typed error, the directory replaced by `<CD>`) and the
final directory trees (names, modes, bytes: `tree_hash`) must be identical, so the receipt and the burned state are compared byte
for byte. Messages that wrap an OS or JSON-parser text are compared without that text. Cross-reads: an approval acknowledged by v9
is scanned by Python and the reverse."""
import json
import os
import subprocess
import tempfile

import pytest
from lib.v9_oracle import DIST, needs_v9
from odd_claude.review import ack as A
from odd_claude.review.canonical import canonical_json, domain_hash
from odd_claude.review.lock import StoreLockOptions
from odd_claude.review.state import admit_lens_result, admit_validator_result, approve, begin_validation, require_correction, start
from odd_claude.review.store import StoreOptions, create_state, read_receipt, read_state, store_root_for

from review.conftest import clone, diff_cases, tree_hash

pytestmark = needs_v9
MOD = "review/ack"
NOW = "2026-11-19T10:00:00.000Z"
BURN_AT = "2026-11-19T10:05:00.000Z"
LOCK = StoreOptions(lock=StoreLockOptions(timeout_ms=30_000, poll_ms=5))


def hx(c, n=64):
    return (c * n)[:n]


def lin(n):
    return f"review-{n:016x}"


def tgt(n):
    return f"sha256:{n:064x}"


def sha(c):
    return f"sha256:{hx(c)}"


# ---- seeds (built once with the Python state machine; both sides receive the same JSON) ----


def low(n, target=None):
    o = start({"lineageId": lin(n), "targetIdentity": target or tgt(n), "projection": "workspace", "baseTree": hx("b", 40), "candidateTree": hx("c", 40),
               "riskLevel": "low", "selectedLenses": [], "originalChangedLines": 6, "now": NOW})
    assert o["ok"]
    return {"record": o["record"], "token": o["ackToken"], "lineage": lin(n), "target": o["record"]["target_identity"], "revision": o["record"]["revision"]}


def medium(n, lens="reliability", findings=()):
    s = start({"lineageId": lin(n), "targetIdentity": tgt(n), "projection": "staged", "baseTree": hx("b", 40), "candidateTree": hx("d", 40),
               "riskLevel": "medium", "selectedLenses": [lens], "originalChangedLines": 30, "now": NOW})["record"]
    a = admit_lens_result(s, {"now": NOW, "lens": lens, "findings": list(findings), "resultHash": sha("e")})
    ap = approve(a["record"], {"now": NOW})
    assert ap["ok"], ap
    return {"record": ap["record"], "token": ap["ackToken"], "lineage": lin(n), "target": tgt(n), "revision": ap["record"]["revision"]}


def high(n):
    s = start({"lineageId": lin(n), "targetIdentity": tgt(n), "projection": "workspace", "baseTree": hx("1", 64), "candidateTree": hx("2", 64),
               "riskLevel": "high", "selectedLenses": ["risk", "resilience", "readability", "reliability"], "originalChangedLines": 400, "now": NOW})["record"]
    for lens in ("risk", "resilience", "readability", "reliability"):
        s = admit_lens_result(s, {"now": NOW, "lens": lens, "findings": [], "resultHash": sha("a")})["record"]
    ap = approve(s, {"now": NOW})
    assert ap["ok"], ap
    return {"record": ap["record"], "token": ap["ackToken"], "lineage": lin(n), "target": tgt(n), "revision": ap["record"]["revision"]}


def corrected(n):
    s = start({"lineageId": lin(n), "targetIdentity": tgt(n), "projection": "workspace", "baseTree": hx("b", 40), "candidateTree": hx("c", 40),
               "riskLevel": "medium", "selectedLenses": ["reliability"], "originalChangedLines": 8, "now": NOW})["record"]
    f = {"id": "R3-001", "lens": "reliability", "severity": "CRITICAL", "location": "a.ts:1", "claim": "boom é"}
    a = admit_lens_result(s, {"now": NOW, "lens": "reliability", "findings": [f], "resultHash": sha("e")})["record"]
    c = require_correction(a, {"fixFindingIds": ["R3-001"], "now": NOW})["record"]
    v = begin_validation(c, {"actualCorrectionLines": 2, "correctionTargetIdentity": tgt(n + 1000), "correctionCandidateTree": hx("d", 40), "now": NOW})["record"]
    adm = admit_validator_result(v, {"now": NOW, "resultHash": sha("f")})["record"]
    ap = approve(adm, {"now": NOW})
    return {"record": ap["record"], "token": ap["ackToken"], "lineage": lin(n), "target": tgt(n + 1000), "revision": ap["record"]["revision"], "original": tgt(n)}


# ---- the two executors ----

NODE_DRIVER = r"""
import { pathToFileURL } from "node:url";
import { readFileSync, writeFileSync, mkdirSync, symlinkSync, rmSync, linkSync, renameSync } from "node:fs";
import { join } from "node:path";
const [dist, cd] = process.argv.slice(1);
const ops = JSON.parse(readFileSync(0, "utf8"));
const ack = await import(pathToFileURL(dist + "/review/ack.js").href);
const store = await import(pathToFileURL(dist + "/review/store.js").href);
const LOCK = { lock: { timeoutMs: 30000, pollMs: 5 } };
const scrub = (v) => JSON.parse(JSON.stringify(v === undefined ? "__undefined__" : v).split(cd).join("<CD>"));
const info = (e) => scrub({ name: e && e.name, code: e && e.code, message: String(e && e.message) });
const out = [];
for (const op of ops) {
  try {
    if (op.op === "seed") { await store.createState(cd, op.record, LOCK); out.push({ ok: null }); }
    else if (op.op === "ack") {
      const o = { ...LOCK, ...(op.now ? { now: () => op.now } : {}) };
      const input = op.input === null || typeof op.input !== "object" || Array.isArray(op.input) ? op.input : { ...op.input };
      out.push({ ok: scrub(await ack.acknowledgeApproved(cd, input, o)) });
    }
    else if (op.op === "scan") out.push({ ok: scrub(ack[op.fn](cd, op.target, op.options === null ? undefined : op.options)) });
    else if (op.op === "raw") {
      const root = join(cd, "odd-plugin", "review-transactions", "v2");
      const f = join(root, op.rel);
      if (op.kind === "file") writeFileSync(f, op.text);
      else if (op.kind === "dir") mkdirSync(f);
      else if (op.kind === "symlink") symlinkSync(op.text, f);
      else if (op.kind === "hardlink") linkSync(join(root, op.text), f);
      else if (op.kind === "rm") rmSync(f, { recursive: true, force: true });
      else if (op.kind === "copy") writeFileSync(f, readFileSync(join(root, op.text)));
      out.push({ ok: null });
    }
  } catch (e) { out.push({ err: info(e) }); }
}
process.stdout.write(JSON.stringify(out));
"""


def v9_ops(cd, ops):
    r = subprocess.run(["node", "--input-type=module", "-e", NODE_DRIVER, str(DIST), cd], input=json.dumps(ops), capture_output=True, text=True, timeout=300)
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout)


def scrub(v, cd):
    return json.loads(json.dumps("__undefined__" if v is None and False else v).replace(cd, "<CD>"))


def py_ops(cd, ops):
    out = []
    for op in ops:
        try:
            k = op["op"]
            if k == "seed":
                create_state(cd, op["record"], LOCK)
                out.append({"ok": None})
            elif k == "ack":
                inp = clone(op["input"]) if isinstance(op["input"], (dict, list)) else op["input"]
                o = A.AcknowledgeOptions(lock=LOCK.lock, now=(lambda t=op.get("now"): t) if op.get("now") else None)
                out.append({"ok": scrub(A.acknowledge_approved(cd, inp, o), cd)})
            elif k == "scan":
                out.append({"ok": scrub(getattr(A, {"scanTarget": "scan_target", "findReceiptForTarget": "find_receipt_for_target", "isTargetConsumed": "is_target_consumed"}[op["fn"]])(cd, op["target"], op.get("options")), cd)})
                # python-only key renames are not needed: scan results already use v9's keys
            else:
                root = store_root_for(cd)
                f = os.path.join(root, op["rel"])
                kind = op["kind"]
                if kind == "file":
                    open(f, "w").write(op["text"])
                elif kind == "dir":
                    os.mkdir(f)
                elif kind == "symlink":
                    os.symlink(op["text"], f)
                elif kind == "hardlink":
                    os.link(os.path.join(root, op["text"]), f)
                elif kind == "rm":
                    import shutil

                    shutil.rmtree(f, ignore_errors=True) if os.path.isdir(f) and not os.path.islink(f) else (os.path.lexists(f) and os.unlink(f))
                elif kind == "copy":
                    open(f, "wb").write(open(os.path.join(root, op["text"]), "rb").read())
                out.append({"ok": None})
        except Exception as e:  # noqa: BLE001
            out.append({"err": scrub({"name": type(e).__name__, "code": getattr(e, "code", None), "message": str(e)}, cd)})
    return out


# error classes: node names -> python names (identical in this port); codes compared as is
WRAPPED = ("invalid-json", "unreadable", "EACCES", "ENOENT")


def norm(results):
    """Messages that embed parser/OS text are compared by code only."""
    out = []
    for r in results:
        r = json.loads(json.dumps(r))
        if "err" in r and any(w in r["err"]["message"] for w in WRAPPED):
            r["err"]["message"] = "<wrapped>"
        if "ok" in r and isinstance(r["ok"], dict):
            for p in r["ok"].get("problems", []):
                if any(w in p["message"] for w in WRAPPED):
                    p["message"] = "<wrapped>"
        out.append(r)
    return out


def run_both(ops, tag=""):
    with tempfile.TemporaryDirectory(prefix="odd-diffack-") as t:
        d9, dpy = os.path.join(os.path.realpath(t), "v9"), os.path.join(os.path.realpath(t), "py")
        os.mkdir(d9)
        os.mkdir(dpy)
        want, got = norm(v9_ops(d9, ops)), norm(py_ops(dpy, ops))
        for i, (w, g) in enumerate(zip(want, got)):
            assert g == w, f"{tag} op {i} {ops[i].get('op')} {json.dumps(ops[i])[:300]}:\npython={json.dumps(g)[:800]}\nv9={json.dumps(w)[:800]}"
        assert len(got) == len(want)
        assert tree_hash(dpy).replace(dpy, "") == tree_hash(d9).replace(d9, ""), f"{tag}: directory trees differ"
        return want


def seed(s):
    return {"op": "seed", "record": s["record"]}


def ackop(s, now=BURN_AT, **over):
    return {"op": "ack", "now": now, "input": {"lineage": s["lineage"], "target": s["target"], "expectedRevision": s["revision"], "token": s["token"], **over}}


def rcpt(s):
    return f"{s['lineage']}/review-receipt.json"


def state_rel(s):
    return f"{s['lineage']}/review-state.json"


def scanops(target, *opts):
    return [{"op": "scan", "fn": fn, "target": target, "options": o} for fn in ("scanTarget", "findReceiptForTarget", "isTargetConsumed") for o in opts]


SCAN_OPTS = (None, {}, {"limit": 1}, {"maxScan": 1}, {"limit": 0}, {"limit": 5, "maxScan": 5})


# ---- pure functions through the oracle ----


def valid_receipt(s):
    with tempfile.TemporaryDirectory() as t:
        cd = os.path.realpath(t)
        create_state(cd, s["record"], LOCK)
        return A.acknowledge_approved(cd, {"lineage": s["lineage"], "target": s["target"], "expectedRevision": s["revision"], "token": s["token"]}, A.AcknowledgeOptions(lock=LOCK.lock, now=lambda: BURN_AT))["receipt"]


def rehash(body):
    return {**body, "receipt_hash": domain_hash("review-receipt", 1, body)}


def test_constants_and_schema_match_v9():
    assert f'export const RECEIPT_SCHEMA = "{A.RECEIPT_SCHEMA}";' in (DIST / "review" / "ack.js").read_text()


def test_validate_receipt_exhaustive():
    r = valid_receipt(medium(1))
    body = {k: v for k, v in r.items() if k != "receipt_hash"}
    cases = [r, None, "x", 1, True, [], [r], {}, {"schema": 1}, {**r, "extra": 1}, {**r, "é\U0001f600": 1, "z": 2, "10": 1, "2": 2}, {k: v for k, v in r.items() if k != "burned_at"},
             {k: v for k, v in r.items() if k not in ("burned_at", "schema", "receipt_hash")}, {**r, "receipt_hash": sha("0")}, {**r, "risk_level": "high"}]
    for k, vals in {
        "schema": ["x", None, 1, "odd-claude.review-receipt/v2"], "lineage_id": ["review-ABCDEF0123456789", "review-" + "a" * 17, None, 5, lin(1) + "\n"],
        "target_identity": [sha("g"), "x", None, 7, sha("a") + "\n"], "approved_revision": ["", None, sha("A")], "ledger_hash": [None, "sha256:", sha("1")], "evidence_hash": [1, []],
        "burn_receipt": ["x"], "receipt_hash": ["sha256:abc", None, 3], "projection": ["workspace", "staged", "other", None, 1, "Workspace"],
        "base_tree": ["z" * 40, hx("a", 39), hx("a", 64), hx("a", 40) + "\n", None, 3], "candidate_tree": ["", hx("F", 40)],
        "burned_at": ["2026-11-19T10:05:00Z", "2026-11-19T10:05:00.1Z", "2026-11-19T10:05:00.123456789Z", "2026-11-19T10:05:00", "2026-02-30T10:05:00.000Z", "2026-02-31T10:05:00.000Z",
                      "2026-13-01T10:05:00.000Z", "2026-00-01T10:05:00.000Z", "2026-01-00T10:05:00.000Z", "2026-01-32T10:05:00.000Z", "2026-11-19T24:00:00.000Z", "2026-11-19T24:00:01.000Z",
                      "2026-11-19T25:00:00.000Z", "2026-11-19T10:60:00.000Z", "2026-11-19T10:05:60.000Z", "0000-01-01T00:00:00.000Z", "9999-12-31T23:59:59.999Z", "2026-11-19T10:05:00١Z",
                      "2026-11-19T10:05:00.000Z\n", " 2026-11-19T10:05:00.000Z", None, 5, True, ["2026-11-19T10:05:00.000Z"]],
        "risk_level": ["low", "medium", "high", "HIGH", "", None, ["low"], 1],
        "selected_lenses": [[], ["risk"], ["risk", "risk"], ["nope"], ["risk", 1], "risk", None, {}, ["RISK"], ["resilience", "risk"], [["risk"]]],
    }.items():
        cases += [{**r, k: v} for v in vals]
        cases += [rehash({**body, k: v}) for v in vals]  # re-hashed so only the field check can object (and the hash accepts)
    cases += [rehash({**body, "projection": "staged", "risk_level": "low"}), rehash({**body, "burned_at": "2026-02-31T10:05:00.000Z"}), rehash({**body, "x": 1})]
    cases += [valid_receipt(s) for s in (low(2), high(3), corrected(4), medium(5, lens="risk"))]
    diff_cases(MOD, "validateReceipt", A.validate_receipt, [[clone(c)] for c in cases])


def test_budget_status():
    recs = [low(1)["record"], {**low(1)["record"], "correction_attempts": 1, "actual_correction_lines": 2}, {**low(1)["record"], "correction_attempts": 5, "actual_correction_lines": 9},
            {**low(1)["record"], "actual_correction_lines": None}, {k: v for k, v in low(1)["record"].items() if k != "actual_correction_lines"}, high(2)["record"],
            {**low(1)["record"], "correction_budget": 200, "actual_correction_lines": 150, "correction_attempts": 2}, {**low(1)["record"], "correction_attempts": 0, "correction_budget": 0}]
    diff_cases(MOD, "budgetStatus", A.budget_status, [[clone(r)] for r in recs])


# ---- store scenarios ----


def test_ack_happy_paths_and_repeated_acks():
    for make, name in ((lambda: low(1), "low"), (lambda: medium(2), "medium"), (lambda: medium(3, lens="readability"), "medium-readability"), (lambda: high(4), "high"),
                       (lambda: corrected(5), "corrected")):
        s = make()
        ops = [seed(s), ackop(s), ackop(s), {"op": "ack", "now": BURN_AT, "input": {"lineage": s["lineage"], "target": s["target"], "expectedRevision": s["revision"], "token": hx("a")}}]
        ops += scanops(s["target"], *SCAN_OPTS)
        run_both(ops, name)


def test_ack_refusals_leave_identical_directories():
    s, o = low(1), low(2)
    base = {"lineage": s["lineage"], "target": s["target"], "expectedRevision": s["revision"], "token": s["token"]}
    inputs = [
        {**base, "token": hx("a")}, {**base, "token": "nope"}, {**base, "token": s["token"].upper()}, {**base, "target": tgt(99)}, {**base, "expectedRevision": sha("1")},
        {**base, "target": "x"}, {**base, "expectedRevision": "x"}, {**base, "target": None}, {**base, "target": 5}, {**base, "expectedRevision": ["x"]},
        {**base, "lineage": "not-a-lineage"}, {**base, "lineage": lin(999)}, {**base, "lineage": None}, {**base, "lineage": 5}, {**base, "lineage": lin(1).upper()},
        {**base, "lineage": lin(1) + "\n"}, {**base, "lineage": "é\U0001f600"}, {**base, "lineage": "../" + lin(1)},
        *[{**base, "token": t} for t in (s["token"] + "\n", s["token"] + "\0", "\0" + s["token"][1:], s["token"] + " ", 12345, None, {}, [s["token"]], "", o["token"], "é" * 64, True, False, 1.5, "0" * 64)],
        {k: v for k, v in base.items() if k != "token"}, {k: v for k, v in base.items() if k != "target"}, {k: v for k, v in base.items() if k != "expectedRevision"},
        {k: v for k, v in base.items() if k != "lineage"}, {}, {"extra": 1}, None, "x", 5, [], True,
    ]
    ops = [seed(s), seed(o)] + [{"op": "ack", "now": BURN_AT, "input": i} for i in inputs]
    ops += [ackop(s)] + [{"op": "ack", "now": BURN_AT, "input": i} for i in inputs[:6]]
    run_both(ops, "refusals")


def test_ack_on_stores_without_state_and_unapproved_lineages():
    s = low(1)
    run_both([ackop(s)] + scanops(s["target"], None), "no store")
    pending = start({"lineageId": lin(4), "targetIdentity": tgt(4), "projection": "workspace", "baseTree": hx("b", 40), "candidateTree": hx("c", 40),
                     "riskLevel": "medium", "selectedLenses": ["risk"], "originalChangedLines": 6, "now": NOW})["record"]
    p = {"record": pending, "lineage": lin(4), "target": tgt(4), "revision": pending["revision"], "token": hx("a")}
    run_both([seed(p), ackop(p), ackop(p, token=hx("b"))] + scanops(tgt(4), None), "not approved")


def test_ack_default_clock_is_not_compared_but_shape_is():
    s = low(1)
    with tempfile.TemporaryDirectory() as t:
        d9 = os.path.join(os.path.realpath(t), "v9")
        os.mkdir(d9)
        want = v9_ops(d9, [seed(s), {"op": "ack", "input": {"lineage": s["lineage"], "target": s["target"], "expectedRevision": s["revision"], "token": s["token"]}}])
        stamp = want[1]["ok"]["receipt"]["burned_at"]
        dpy = os.path.join(os.path.realpath(t), "py")
        os.mkdir(dpy)
        create_state(dpy, s["record"], LOCK)
        got = A.acknowledge_approved(dpy, {"lineage": s["lineage"], "target": s["target"], "expectedRevision": s["revision"], "token": s["token"]}, A.AcknowledgeOptions(lock=LOCK.lock))
        assert len(got["receipt"]["burned_at"]) == len(stamp) == 24 and got["receipt"]["burned_at"].endswith("Z") and stamp.endswith("Z")
        assert A.validate_receipt(got["receipt"])["ok"] and A.validate_receipt(want[1]["ok"]["receipt"])["ok"]


def test_ack_with_pre_existing_receipts_of_every_kind():
    s, other = low(1), low(2)
    other_ack = ackop(other)
    good = [seed(other), other_ack, {"op": "raw", "kind": "copy", "rel": rcpt(s) + ".src", "text": rcpt(other)}]
    for kind, text in (("file", "{not json"), ("file", ""), ("file", "{}"), ("file", "[]"), ("file", "null"), ("file", '{"a":"é😀"}'), ("file", "x" * 2_000_000), ("file", "﻿{}"),
                       ("dir", None), ("symlink", "elsewhere"), ("symlink", rcpt(other)), ("copy", rcpt(other))):
        ops = good[:2] + [seed(s), {"op": "raw", "kind": kind, "rel": rcpt(s), "text": text if kind != "copy" else rcpt(other)}, ackop(s), ackop(s, token=hx("a"))]
        ops += scanops(s["target"], None, {"limit": 1})
        run_both(ops, f"receipt {kind} {str(text)[:20]!r}")


def test_ack_reuses_the_receipt_of_a_crashed_earlier_attempt():
    s = low(1)
    approved_state = canonical_json(s["record"]) + "\n"
    ops = [seed(s), ackop(s, now="2026-11-19T10:05:00.000Z"),
           {"op": "raw", "kind": "file", "rel": state_rel(s), "text": approved_state},  # rewind to "approved + receipt, unburned"
           ackop(s, now="2030-01-01T00:00:00.000Z"), ackop(s, now="2030-01-01T00:00:00.000Z")] + scanops(s["target"], None)
    run_both(ops, "reuse")
    # the surviving receipt belongs to a different approval: it must be refused, and a tampered one too
    t = low(2)
    ops = [seed(s), ackop(s), seed(t), {"op": "raw", "kind": "copy", "rel": rcpt(t), "text": rcpt(s)}, ackop(t)]
    run_both(ops, "foreign receipt")


def test_scans_over_forged_missing_corrupt_and_mismatching_receipts():
    a, b, c = low(1), medium(2), high(3)
    ops = [seed(a), seed(b), seed(c), ackop(a), ackop(b), ackop(c)] + scanops(a["target"], *SCAN_OPTS) + scanops(b["target"], None)
    body = valid_receipt(b)
    forged = lambda patch: canonical_json(rehash({**{k: v for k, v in body.items() if k != "receipt_hash"}, **patch})) + "\n"  # noqa: E731
    for patch in [{"risk_level": "low", "selected_lenses": []}, {"risk_level": "high"}, {"selected_lenses": ["risk"]}, {"projection": "workspace"}, {"ledger_hash": sha("7")},
                  {"evidence_hash": sha("7")}, {"approved_revision": sha("f")}, {"base_tree": hx("9", 40)}, {"candidate_tree": hx("9", 40)}, {"burned_at": "2026-11-19T10:06:00.000Z"},
                  {"burn_receipt": sha("7")}, {"lineage_id": lin(99)}, {"target_identity": tgt(98)}, {}]:
        ops += [{"op": "raw", "kind": "file", "rel": rcpt(b), "text": forged(patch)}] + scanops(b["target"], None, {"limit": 1})
    for text in ("{garbage", "{}", "", "[]", "x" * 2_000_000):
        ops += [{"op": "raw", "kind": "file", "rel": rcpt(b), "text": text}] + scanops(b["target"], None)
    ops += [{"op": "raw", "kind": "rm", "rel": rcpt(b)}] + scanops(b["target"], None)
    ops += [{"op": "raw", "kind": "file", "rel": state_rel(a), "text": "{garbage"}] + scanops(a["target"], None) + scanops(tgt(555), None)
    ops += [{"op": "raw", "kind": "rm", "rel": state_rel(a)}] + scanops(a["target"], None, {"limit": 1})
    ops += scanops("é\U0001f600", None) + scanops("", None) + scanops(sha("a"), None, {"limit": 0}, {"maxScan": 0})
    run_both(ops, "scans")


def test_scan_ordering_by_burned_at_and_unburned_approvals():
    # several burned lineages of ONE target (same target identity, different lineages) tie-break by burned_at, newest first
    t = tgt(7)
    seeds = [low(n, target=t) for n in (1, 2, 3, 4)]
    ops = [seed(s) for s in seeds]
    times = ["2026-11-19T10:05:00.000Z", "2026-11-19T10:09:00.000Z", "2026-11-19T10:05:00.000Z", "2026-11-19T10:07:00.000Z"]
    ops += [ackop(s, now=n) for s, n in zip(seeds[:3], times)]
    ops += scanops(t, None, {"limit": 2}, {"maxScan": 2})
    ops += [ackop(seeds[3], now=times[3])] + scanops(t, None)
    run_both(ops, "ordering")


def test_corrected_candidate_binds_only_the_corrected_identity():
    s = corrected(5)
    ops = [seed(s), ackop(s, target=s["original"]), ackop(s, target=tgt(999)), ackop(s)] + scanops(s["target"], None) + scanops(s["original"], None)
    run_both(ops, "corrected")


def test_cross_implementation_reads():
    s = medium(1)
    with tempfile.TemporaryDirectory() as t:
        d = os.path.realpath(t)
        v9_ops(d, [seed(s), ackop(s)])  # v9 acknowledges; Python reads
        assert A.is_target_consumed(d, s["target"])["status"] == "consumed"
        assert A.validate_receipt(read_receipt(d, s["lineage"]))["ok"] and read_state(d, s["lineage"])["burned"] is True
        r = A.find_receipt_for_target(d, s["target"])
        assert r["receipt"]["lineage_id"] == s["lineage"]
    with tempfile.TemporaryDirectory() as t:
        d = os.path.realpath(t)
        create_state(d, s["record"], LOCK)
        A.acknowledge_approved(d, {"lineage": s["lineage"], "target": s["target"], "expectedRevision": s["revision"], "token": s["token"]}, A.AcknowledgeOptions(lock=LOCK.lock, now=lambda: BURN_AT))
        want = v9_ops(d, scanops(s["target"], None))  # Python acknowledges; v9 scans
        assert want[1]["ok"]["receipt"]["lineage_id"] == s["lineage"] and want[2]["ok"]["status"] == "consumed"
        with pytest.raises(A.AckRefusedError) as e:
            A.acknowledge_approved(d, {"lineage": s["lineage"], "target": s["target"], "expectedRevision": s["revision"], "token": s["token"]}, A.AcknowledgeOptions(lock=LOCK.lock))
        assert e.value.code == "target_already_acknowledged"
        again = v9_ops(d, [ackop(s)])
        assert again[0]["err"]["message"] == "acknowledge refused (target_already_acknowledged): this approval was already acknowledged"
        assert store_root_for(d)
