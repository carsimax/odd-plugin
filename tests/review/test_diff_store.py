"""Differential tests of review/store.py against the compiled v9 module `dist/review/store.js`.

`storeRootFor` goes through the oracle (JSON in, JSON out). The rest of the store needs a function (`updateState`'s transition)
and a filesystem, so a small node driver (`NODE_DRIVER`) runs a JSON list of operations against v9 on one fresh directory while
`py_ops` runs the same list against Python on another; the per-operation results (value or error name/code/kind/message, the
directory path replaced by `<CD>`) and the final trees (names, modes, bytes: `tree_hash`) must be identical. Messages that wrap
OS or JSON-parser text (StoreIoError, unreadable, invalid-json, raw OS errors) are compared without the message. Cross-reads:
a lineage driven partly by v9 and partly by Python ends byte-identical to one driven entirely by v9."""
import json
import os
import subprocess
from pathlib import Path

import pytest
from lib.v9_oracle import DIST, needs_v9, v9_many
from odd_claude.review import state as pystate
from odd_claude.review import store as pystore
from odd_claude.review.lock import StoreLockOptions

from review.conftest import tree_hash

pytestmark = needs_v9

T0 = "2026-11-19T10:00:00.000Z"
T1 = "2026-11-19T10:05:00.000Z"
TOKEN = "ab" * 32
LINEAGE = "review-" + "a" * 16
OTHER = "review-" + "b" * 16


def sha(c):
    return "sha256:" + (c * 64)[:64]


NODE_DRIVER = r"""
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
const [dist, cd] = process.argv.slice(1);
const opsJson = readFileSync(0, "utf8");
const store = await import(pathToFileURL(dist + "/review/store.js").href);
const state = await import(pathToFileURL(dist + "/review/state.js").href);
const TOKEN = "ab".repeat(32);
const lockOpts = (o) => (o && o.lock ? { lock: o.lock } : {});
const options = (o) => {
  if (!o) return undefined;
  const out = lockOpts(o);
  if (o.sweep) {
    const { nowPlusMs, ...rest } = o.sweep;
    out.sweep = { ...rest, ...(nowPlusMs !== undefined ? { now: () => Date.now() + nowPlusMs } : {}) };
  }
  return out;
};
const counter = (r) => parseInt(r.target_identity.slice(7), 16);
const transitions = {
  approveFixed: (r, i) => state.approve(r, { ...i, randomToken: () => TOKEN }),
  bump: (r) => { const n = { ...r, target_identity: "sha256:" + (counter(r) + 1).toString(16).padStart(64, "0") }; n.revision = state.stateRevision(n); return { ok: true, record: n }; },
  corruptState: (r) => ({ ok: true, record: { ...r, state: "approved" } }),
  moveLineage: (r) => { const m = { ...r, lineage_id: "review-" + "b".repeat(16) }; m.revision = state.stateRevision(m); return { ok: true, record: m }; },
};
const run = (name, input) => (r) => (transitions[name] ? transitions[name](r, input) : state[name](r, input));
const KEYS = ["code", "kind", "errno", "expectedRevision", "currentRevision", "refusal", "errors", "path"]; // the lineage is in the message
const scrub = (v) => JSON.parse(JSON.stringify(v === undefined ? null : v).split(cd).join("<CD>"));
const errInfo = (e) => {
  const d = { name: e && e.name, message: String(e && e.message) };
  for (const k of KEYS) if (e && e[k] !== undefined && !(k === "errno" && typeof e[k] === "number")) d[k] = e[k];
  return scrub(d);
};
const out = [];
let last;
for (const op of JSON.parse(opsJson)) {
  const exp = op.expected === "$last" ? last : op.expected;
  try {
    let v;
    if (op.op === "create") v = await store.createState(cd, op.record, options(op.options));
    else if (op.op === "update") v = await store.updateState(cd, op.lineage, exp, run(op.transition, op.input), options(op.options));
    else if (op.op === "receipt") v = await store.writeReceipt(cd, op.lineage, op.receipt, options(op.options));
    else if (op.op === "readState") v = store.readState(cd, op.lineage);
    else if (op.op === "readReceipt") v = store.readReceipt(cd, op.lineage);
    else if (op.op === "list") v = store.listLineages(cd, op.options);
    else if (op.op === "writeAtomic") v = store.writeAtomic(cd + "/" + op.rel, op.payload);
    else throw new Error("bad op " + op.op);
    const rec = v && (v.record || (v.revision ? v : undefined));
    if (rec && rec.revision) last = rec.revision;
    out.push({ ok: scrub(v) });
  } catch (e) {
    out.push({ err: errInfo(e) });
  }
}
process.stdout.write(JSON.stringify(out));
"""


def v9_ops(cd, ops):
    r = subprocess.run(["node", "--input-type=module", "-e", NODE_DRIVER, str(DIST), cd], input=json.dumps(ops), capture_output=True, text=True, timeout=300)
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout)


def _counter(r):
    return int(r["target_identity"][7:], 16)


def _bump(r):
    n = {**r, "target_identity": "sha256:" + format(_counter(r) + 1, "x").rjust(64, "0")}
    n["revision"] = pystate.state_revision(n)
    return {"ok": True, "record": n}


def _moved(r):
    m = {**r, "lineage_id": "review-" + "b" * 16}
    m["revision"] = pystate.state_revision(m)
    return {"ok": True, "record": m}


TRANSITIONS = {
    "approveFixed": lambda r, i: pystate.approve(r, {**i, "randomToken": lambda: TOKEN}),
    "bump": lambda r, i: _bump(r),
    "corruptState": lambda r, i: {"ok": True, "record": {**r, "state": "approved"}},
    "moveLineage": lambda r, i: _moved(r),
}
PY_FN = {
    "admitLensResult": pystate.admit_lens_result, "admitValidatorResult": pystate.admit_validator_result, "admitRefuterResult": pystate.admit_refuter_result,
    "requireCorrection": pystate.require_correction, "beginValidation": pystate.begin_validation, "approve": pystate.approve,
    "reopenCorrection": pystate.reopen_correction, "escalate": pystate.escalate, "invalidate": pystate.invalidate, "burn": pystate.burn,
}
ERR_MAP = (("code", "code"), ("kind", "kind"), ("errno", "errno"), ("expected_revision", "expectedRevision"), ("current_revision", "currentRevision"),
           ("refusal", "refusal"), ("errors", "errors"), ("path", "path"))


def _scrub(v, cd):
    return json.loads(json.dumps(None if v is None else v).replace(json.dumps(cd)[1:-1], "<CD>"))


def _err(e, cd):
    d = {"name": type(e).__name__, "message": str(e)}
    for py_k, js_k in ERR_MAP:
        if hasattr(e, py_k) and not (py_k == "errno" and not isinstance(getattr(e, py_k), str)):
            d[js_k] = getattr(e, py_k)
    if isinstance(e, OSError) and e.errno is not None:
        import errno as _e

        d["code"] = _e.errorcode.get(e.errno)
    return _scrub(d, cd)


def _store_opts(o):
    if not o:
        return None
    lock = StoreLockOptions(timeout_ms=o["lock"].get("timeoutMs"), poll_ms=o["lock"].get("pollMs")) if o.get("lock") else None
    sweep = None
    if o.get("sweep"):
        s = o["sweep"]
        import time

        sweep = pystore.SweepOptions(now=(lambda p=s["nowPlusMs"]: time.time() * 1000 + p) if "nowPlusMs" in s else None, min_age_ms=s.get("minAgeMs"), max=s.get("max"))
    return pystore.StoreOptions(lock=lock, sweep=sweep)


def py_ops(cd, ops):
    out, last = [], None
    for op in ops:
        exp = last if op.get("expected") == "$last" else op.get("expected")
        try:
            kind = op["op"]
            if kind == "create":
                v = pystore.create_state(cd, op["record"], _store_opts(op.get("options")))
            elif kind == "update":
                name, inp = op["transition"], op.get("input")
                fn = (lambda r: TRANSITIONS[name](r, inp)) if name in TRANSITIONS else (lambda r: PY_FN[name](r, inp))
                v = pystore.update_state(cd, op["lineage"], exp, fn, _store_opts(op.get("options")))
            elif kind == "receipt":
                v = pystore.write_receipt(cd, op["lineage"], op["receipt"], _store_opts(op.get("options")))
            elif kind == "readState":
                v = pystore.read_state(cd, op["lineage"])
            elif kind == "readReceipt":
                v = pystore.read_receipt(cd, op["lineage"])
            elif kind == "list":
                o = op.get("options") or {}
                v = pystore.list_lineages(cd, o.get("limit"), o.get("maxScan"))
            elif kind == "writeAtomic":
                v = pystore.write_atomic(cd + "/" + op["rel"], op["payload"])
            else:
                raise AssertionError(kind)
            rec = v.get("record") if isinstance(v, dict) and "record" in v else (v if isinstance(v, dict) and "revision" in v else None)
            if rec and rec.get("revision"):
                last = rec["revision"]
            out.append({"ok": _scrub(v, cd)})
        except Exception as e:  # noqa: BLE001
            out.append({"err": _err(e, cd)})
    return out


def _lenient(results):
    """Drops the messages that wrap OS or JSON-parser text (the codes, kinds and errno names still have to match)."""
    out = []
    for r in results:
        e = r.get("err")
        if e and not str(e.get("code", "")).startswith("STORE_"):  # a raw OS error (write_atomic): only its errno name is comparable
            r = {"err": {"code": e.get("code")}}
        elif e and (e["name"] == "StoreIoError" or e.get("kind") in ("invalid-json", "unreadable")):
            r = {"err": {k: v for k, v in e.items() if k != "message"}}
        out.append(r)
    return out


def _ls(root):
    return sorted(f"{os.path.relpath(os.path.join(d, n), root)}:{os.lstat(os.path.join(d, n)).st_mode:o}" for d, ds, fs in os.walk(root) for n in ds + fs)


class Pair:
    """Two fresh common dirs: `a` driven by v9, `b` driven by Python."""

    def __init__(self, tmp_path):
        self.a, self.b = str(tmp_path / "a.git"), str(tmp_path / "b.git")
        os.mkdir(self.a)
        os.mkdir(self.b)

    def run(self, ops):
        want, got = _lenient(v9_ops(self.a, ops)), _lenient(py_ops(self.b, ops))
        for op, w, g in zip(ops, want, got):
            assert g == w, f"{json.dumps(op)[:300]}\n python={json.dumps(g)[:600]}\n v9={json.dumps(w)[:600]}"
        assert len(want) == len(got) == len(ops)
        return want

    def both(self, fn):
        fn(self.a)
        fn(self.b)

    def same_tree(self):
        assert tree_hash(self.a) == tree_hash(self.b)


def new_record(lineage=LINEAGE, n=0):
    out = pystate.start({"lineageId": lineage, "targetIdentity": sha("0")[:-1] + format(n, "x"), "projection": "workspace", "baseTree": "b" * 40, "candidateTree": "c" * 40,
                         "riskLevel": "medium", "selectedLenses": ["reliability"], "originalChangedLines": 8, "now": T0})
    return out["record"]


def severe(id_="R3-001"):
    return {"id": id_, "lens": "reliability", "severity": "CRITICAL", "location": "a.ts:1", "claim": "boom"}


def lifecycle(lineage=LINEAGE):
    u = lambda t, i: {"op": "update", "lineage": lineage, "expected": "$last", "transition": t, "input": i}  # noqa: E731
    return [
        {"op": "create", "record": new_record(lineage)},
        u("admitLensResult", {"lens": "reliability", "findings": [severe()], "resultHash": sha("2"), "now": T0}),
        u("requireCorrection", {"fixFindingIds": ["R3-001"], "now": T1}),
        u("beginValidation", {"actualCorrectionLines": 2, "correctionTargetIdentity": sha("4"), "correctionCandidateTree": "d" * 40, "now": T1}),
        u("admitValidatorResult", {"resultHash": sha("5"), "now": T1}),
        u("approveFixed", {"now": T1}),
        u("burn", {"token": TOKEN, "now": T1}),
        {"op": "receipt", "lineage": lineage, "receipt": {"schema": "odd-claude.review-receipt/v1", "lineage_id": lineage, "z": 1, "a": [1, 2], "é": "ü"}},
        {"op": "readState", "lineage": lineage},
        {"op": "readReceipt", "lineage": lineage},
        {"op": "list"},
    ]


# ---- storeRootFor ----


def test_store_root_for():
    paths = ["", ".", "/", "/a/b", "/a/b/", "a//b", "/a/../b", "//x", "a/./b", "../x", "x/..", "/é/ü", "a b/c", "/a/b//", "///a", "./a", "a/../..", "/..", "\\a"]
    want = v9_many("review/store", "storeRootFor", [[p] for p in paths])
    assert [pystore.store_root_for(p) for p in paths] == want


# ---- the full lifecycle ----


def test_lifecycle_results_and_final_tree_are_identical(tmp_path):
    p = Pair(tmp_path)
    res = p.run(lifecycle())
    assert res[6]["ok"]["record"]["burned"] is True and res[-1]["ok"] == {"lineages": [LINEAGE], "truncated": False}
    p.same_tree()


def test_cross_reads_each_side_continues_the_other_sides_lineage(tmp_path):
    """v9 -> Python -> v9 -> Python on one directory, compared with a pure-v9 run of the same operations."""
    ops = lifecycle()
    steps = [ops[:2], ops[2:4], ops[4:6], ops[6:]]
    pure = tmp_path / "pure.git"
    pure.mkdir()
    pure_last = None
    for chunk in steps:
        chunk = [{**chunk[0], "expected": pure_last} if chunk[0].get("expected") == "$last" and pure_last else chunk[0], *chunk[1:]]  # later ops track "$last" themselves
        res = v9_ops(str(pure), chunk)
        assert all("ok" in r for r in res), res
        rec = pystore.read_state(str(pure), LINEAGE)
        pure_last = rec["revision"]
    mixed = tmp_path / "mixed2.git"
    mixed.mkdir()
    last = None
    for i, chunk in enumerate(steps):
        chunk = [{**chunk[0], "expected": last} if chunk[0].get("expected") == "$last" and last else chunk[0], *chunk[1:]]
        res = (v9_ops if i % 2 == 0 else py_ops)(str(mixed), chunk)
        assert all("ok" in r for r in res), (i, res)
        last = pystore.read_state(str(mixed), LINEAGE)["revision"]
        # the other implementation reads what was just written, identically
        other = (py_ops if i % 2 == 0 else v9_ops)(str(mixed), [{"op": "readState", "lineage": LINEAGE}, {"op": "list"}])
        assert other[0]["ok"]["revision"] == last
    assert tree_hash(str(mixed)) == tree_hash(str(pure))
    # and v9 reads the Python-written receipt, Python reads the v9-written one
    assert v9_ops(str(mixed), [{"op": "readReceipt", "lineage": LINEAGE}])[0] == py_ops(str(mixed), [{"op": "readReceipt", "lineage": LINEAGE}])[0]


# ---- errors ----


def test_error_results_are_identical(tmp_path):
    p = Pair(tmp_path)
    rec = new_record()
    p.run(lifecycle()[:2])
    cur = pystore.read_state(p.b, LINEAGE)["revision"]
    ops = [
        {"op": "create", "record": rec},
        {"op": "create", "record": {**rec, "revision": sha("9")}},
        {"op": "create", "record": {**rec, "extra": 1}},
        {"op": "create", "record": {**rec, "lineage_id": OTHER}},
        {"op": "create", "record": {"a": 1}},
        {"op": "create", "record": None},
        {"op": "create", "record": []},
        {"op": "update", "lineage": LINEAGE, "expected": sha("1"), "transition": "bump", "input": {}},
        {"op": "update", "lineage": LINEAGE, "expected": None, "transition": "bump", "input": {}},
        {"op": "update", "lineage": LINEAGE, "expected": 5, "transition": "bump", "input": {}},
        {"op": "update", "lineage": LINEAGE, "expected": cur, "transition": "burn", "input": {"token": TOKEN, "now": T1}},
        {"op": "update", "lineage": LINEAGE, "expected": cur, "transition": "corruptState", "input": {}},
        {"op": "update", "lineage": LINEAGE, "expected": cur, "transition": "moveLineage", "input": {}},
        {"op": "update", "lineage": OTHER, "expected": cur, "transition": "bump", "input": {}},
        {"op": "readState", "lineage": OTHER},
        {"op": "readReceipt", "lineage": LINEAGE},
        {"op": "receipt", "lineage": OTHER, "receipt": {"a": 1}},
        {"op": "receipt", "lineage": LINEAGE, "receipt": [1]},
        {"op": "receipt", "lineage": LINEAGE, "receipt": None},
        {"op": "receipt", "lineage": LINEAGE, "receipt": {"pad": "x" * (1 << 20)}},
        {"op": "receipt", "lineage": LINEAGE, "receipt": {"a": 1}},
        {"op": "receipt", "lineage": LINEAGE, "receipt": {"a": 2}},
    ]
    for bad in ["../x", "..", "", "review-AAAAAAAAAAAAAAAA", "review-aaaaaaaaaaaaaaa", LINEAGE + "/..", LINEAGE + "\u0000", LINEAGE + "\n", 5, None, [], "é"]:
        ops += [{"op": "readState", "lineage": bad}, {"op": "readReceipt", "lineage": bad}, {"op": "receipt", "lineage": bad, "receipt": {"a": 1}},
                {"op": "update", "lineage": bad, "expected": cur, "transition": "bump", "input": {}}, {"op": "create", "record": {**rec, "lineage_id": bad}}]
    p.run(ops)
    p.same_tree()


def test_missing_store_and_missing_common_dir(tmp_path):
    p = Pair(tmp_path)
    p.run([{"op": "readState", "lineage": LINEAGE}, {"op": "readReceipt", "lineage": LINEAGE}, {"op": "list"}, {"op": "list", "options": {"limit": 1}},
           {"op": "update", "lineage": LINEAGE, "expected": sha("1"), "transition": "bump", "input": {}}, {"op": "receipt", "lineage": LINEAGE, "receipt": {"a": 1}}])
    assert not os.path.exists(os.path.join(p.a, "odd-plugin")) and not os.path.exists(os.path.join(p.b, "odd-plugin"))
    missing = tmp_path / "nope"
    r9 = v9_ops(str(missing / "a"), [{"op": "create", "record": new_record()}])[0]["err"]
    rp = py_ops(str(missing / "b"), [{"op": "create", "record": new_record()}])[0]["err"]
    assert (r9["name"], r9["code"], r9["errno"]) == (rp["name"], rp["code"], rp["errno"]) == ("StoreIoError", "STORE_IO", "ENOENT")
    assert r9["path"].replace("a/odd-plugin", "X") == rp["path"].replace("b/odd-plugin", "X")


# ---- corruption and hostile files ----


def _write(name, data):
    def f(cd):
        Path(cd, "odd-plugin/review-transactions/v2", LINEAGE, name).write_bytes(data)

    return f


def _file(cd, name="review-state.json"):
    return os.path.join(cd, "odd-plugin/review-transactions/v2", LINEAGE, name)


def _clear(cd, name="review-state.json"):
    f = _file(cd, name)
    if os.path.isdir(f) and not os.path.islink(f):
        os.rmdir(f)
    elif os.path.lexists(f):
        os.unlink(f)


def test_corrupt_state_files_give_identical_errors_and_are_never_touched(tmp_path):
    p = Pair(tmp_path)
    p.run(lifecycle()[:1])
    good = Path(_file(p.a)).read_bytes()
    parsed = json.loads(good)

    def enc(o):
        return json.dumps(o).encode()

    cases = {
        "empty": lambda cd: Path(_file(cd)).write_bytes(b""),
        "truncated": lambda cd: Path(_file(cd)).write_bytes(good[: len(good) // 2]),
        "garbage": lambda cd: Path(_file(cd)).write_bytes(b"garbage"),
        "array": lambda cd: Path(_file(cd)).write_bytes(b"[]"),
        "null": lambda cd: Path(_file(cd)).write_bytes(b"null"),
        "bad revision": lambda cd: Path(_file(cd)).write_bytes(enc({**parsed, "revision": sha("9")})),
        "edited": lambda cd: Path(_file(cd)).write_bytes(enc({**parsed, "updated_at": T1})),
        "unknown": lambda cd: Path(_file(cd)).write_bytes(enc({**parsed, "sneaky": True})),
        "missing": lambda cd: Path(_file(cd)).write_bytes(enc({k: v for k, v in parsed.items() if k != "findings"})),
        "other lineage": lambda cd: Path(_file(cd)).write_bytes(pystate_canonical(new_record(OTHER))),
        "bom": lambda cd: Path(_file(cd)).write_bytes(b"\xef\xbb\xbf" + good),
        "latin1 bytes": lambda cd: Path(_file(cd)).write_bytes(good.replace(b"workspace", b"w\xffrkspace")),
        "symlink": lambda cd: os.symlink("../../../../elsewhere.json", _file(cd)),
        "dangling symlink": lambda cd: os.symlink("../../../../missing.json", _file(cd)),
        "directory": lambda cd: os.mkdir(_file(cd)),
        "fifo": lambda cd: os.mkfifo(_file(cd)),
        "oversized": lambda cd: Path(_file(cd)).write_bytes(b" " * ((1 << 20) + 1)),
        "exactly max": lambda cd: Path(_file(cd)).write_bytes(b" " * (1 << 20)),
        "hardlink": lambda cd: os.link(os.path.join(cd, "elsewhere.json"), _file(cd)),
    }
    p.both(lambda cd: Path(cd, "elsewhere.json").write_bytes(good))
    ops = [
        {"op": "readState", "lineage": LINEAGE},
        {"op": "update", "lineage": LINEAGE, "expected": parsed["revision"], "transition": "bump", "input": {}},
        {"op": "create", "record": parsed},
        {"op": "receipt", "lineage": LINEAGE, "receipt": {"a": 1}},
        {"op": "list"},
    ]
    for name, corrupt in cases.items():
        p.both(_clear)
        p.both(corrupt)
        try:
            p.run(ops)
        except AssertionError as e:
            raise AssertionError(f"{name}: {e}") from None
        if name == "fifo":  # tree_hash would block opening the FIFO for reading
            assert _ls(p.a) == _ls(p.b)
        else:
            assert tree_hash(p.a) == tree_hash(p.b), f"{name}: {_ls(p.a)} vs {_ls(p.b)}"


def pystate_canonical(rec):
    from odd_claude.review.canonical import canonical_json

    return canonical_json(rec).encode()


def test_corrupt_receipts_give_identical_errors(tmp_path):
    p = Pair(tmp_path)
    p.run(lifecycle()[:1])
    for name, data in {"array": b"[]", "garbage": b"{", "string": b'"x"', "null": b"null", "ok": b'{"a":1}', "empty": b"", "bom": b'\xef\xbb\xbf{"a":1}'}.items():
        p.both(lambda cd, d=data: Path(_file(cd, "review-receipt.json")).write_bytes(d))
        p.run([{"op": "readReceipt", "lineage": LINEAGE}, {"op": "receipt", "lineage": LINEAGE, "receipt": {"b": 1}}])
        p.both(lambda cd: _clear(cd, "review-receipt.json"))
    p.both(lambda cd: os.symlink("x", _file(cd, "review-receipt.json")))
    p.run([{"op": "readReceipt", "lineage": LINEAGE}, {"op": "receipt", "lineage": LINEAGE, "receipt": {"b": 1}}])
    p.same_tree()


@pytest.mark.parametrize("seg", ["odd-plugin", "odd-plugin/review-transactions", "odd-plugin/review-transactions/v2"])
@pytest.mark.parametrize("kind", ["symlink", "file"])
def test_hostile_namespace_segments_give_identical_errors(tmp_path, seg, kind):
    p = Pair(tmp_path)
    rec = new_record()
    p.run([{"op": "create", "record": rec}])

    def hostile(cd):
        path = os.path.join(cd, seg)
        moved = os.path.join(cd, "moved-real")
        os.rename(path, moved)
        if kind == "symlink":
            os.symlink(os.path.relpath(moved, os.path.dirname(path)), path)
        else:
            Path(path).write_text("x")

    p.both(hostile)
    p.run([{"op": "readState", "lineage": LINEAGE}, {"op": "readReceipt", "lineage": LINEAGE}, {"op": "list"}, {"op": "create", "record": rec},
           {"op": "update", "lineage": LINEAGE, "expected": rec["revision"], "transition": "bump", "input": {}}, {"op": "receipt", "lineage": LINEAGE, "receipt": {"a": 1}}])
    p.same_tree()


def test_symlinked_lineage_dir_and_junk_entries_in_the_listing(tmp_path):
    p = Pair(tmp_path)
    p.run([{"op": "create", "record": new_record(LINEAGE)}, {"op": "create", "record": new_record(OTHER, 1)}])

    def junk(cd):
        root = os.path.join(cd, "odd-plugin/review-transactions/v2")
        os.symlink(LINEAGE, os.path.join(root, "review-" + "c" * 16))
        os.mkdir(os.path.join(root, "review-short"))
        os.mkdir(os.path.join(root, "junk"))
        Path(root, "review-" + "d" * 16).write_text("a file")
        Path(root, ".DS_Store").write_text("x")
        for i in range(12):
            Path(root, f"junk-{i}").write_text("x")

    p.both(junk)
    ops = [{"op": "list"}] + [{"op": "list", "options": {"limit": n}} for n in (-1, 0, 1, 2, 3, 0.5, 1.5, 2.5, -0.5, -1.5, 1e308)] + [{"op": "list", "options": {"maxScan": n}} for n in (0, 1, 5, 100, 0.5, 1.5, 5.5, -1, -0.5)]
    ops += [{"op": "readState", "lineage": "review-" + "c" * 16}, {"op": "create", "record": new_record("review-" + "c" * 16, 3)}]
    res = p.run(ops)
    assert res[0]["ok"]["lineages"] == [LINEAGE, OTHER]
    p.same_tree()


# ---- writeAtomic ----


def test_write_atomic_results_and_files_are_identical(tmp_path):
    p = Pair(tmp_path)
    p.both(lambda cd: os.mkdir(os.path.join(cd, "d")))
    ops = [
        {"op": "writeAtomic", "rel": "d/f.json", "payload": "héllo ✓ \U0001f600"},
        {"op": "writeAtomic", "rel": "d/f.json", "payload": "overwritten"},
        {"op": "writeAtomic", "rel": "d/empty", "payload": ""},
        {"op": "writeAtomic", "rel": "d/big", "payload": "x" * 300_000},
        {"op": "writeAtomic", "rel": "missing/f.json", "payload": "x"},
        {"op": "writeAtomic", "rel": "d", "payload": "x"},
    ]
    res = p.run(ops)
    assert res[4]["err"]["code"] == "ENOENT"
    p.same_tree()
    assert os.stat(os.path.join(p.a, "d/f.json")).st_mode & 0o777 == os.stat(os.path.join(p.b, "d/f.json")).st_mode & 0o777 == 0o600


# ---- sweep ----


def test_sweep_results_and_trees_are_identical(tmp_path):
    p = Pair(tmp_path)
    p.run([{"op": "create", "record": new_record()}])
    temp_a, temp_b = ".atomic-123-0123456789abcdef", ".atomic-456-fedcba9876543210"

    def abandon(cd):
        root = os.path.join(cd, "odd-plugin/review-transactions/v2")
        for i, temps in enumerate([[], [temp_a], [temp_a, temp_b], ["notes.txt"], [temp_a]]):
            d = os.path.join(root, f"review-{i + 1:016x}")
            os.mkdir(d, 0o700)
            for t in temps:
                Path(d, t).write_text("x")
        os.symlink("../../..", os.path.join(root, "review-" + "6" * 16))
        os.mkdir(os.path.join(root, "review-" + "7" * 16))
        os.symlink("../../../../x", os.path.join(root, "review-" + "7" * 16, temp_a))  # (a FIFO would block tree_hash)

    p.both(abandon)
    HOUR = 3_600_000
    ops = [
        {"op": "create", "record": new_record(OTHER, 1), "options": {"sweep": {"nowPlusMs": 2 * HOUR}}},
        {"op": "create", "record": new_record("review-" + "8" * 16, 2), "options": {"sweep": {"nowPlusMs": 2 * HOUR, "minAgeMs": 10 * HOUR}}},
        {"op": "create", "record": new_record("review-" + "9" * 16, 3), "options": {"sweep": {"nowPlusMs": 1, "minAgeMs": 0, "max": 2}}},
        {"op": "create", "record": new_record("review-" + "e" * 16, 4)},
        {"op": "list"},
    ]
    p.run(ops)
    p.same_tree()


# ---- concurrency: the same chain of revisions, regardless of who wrote each step ----


def test_python_and_v9_updaters_interleaved_never_lose_an_update(tmp_path):
    cd = str(tmp_path / "mix.git")
    os.mkdir(cd)
    rec = new_record()
    assert "ok" in v9_ops(cd, [{"op": "create", "record": rec}])[0]
    for i in range(6):
        cur = pystore.read_state(cd, LINEAGE)["revision"]
        op = [{"op": "update", "lineage": LINEAGE, "expected": cur, "transition": "bump", "input": {}}]
        res = (v9_ops if i % 2 else py_ops)(cd, op)[0]
        assert "ok" in res, res
        stale = (v9_ops if i % 2 == 0 else py_ops)(cd, [{"op": "update", "lineage": LINEAGE, "expected": cur, "transition": "bump", "input": {}}])[0]
        assert stale["err"]["name"] == "StoreConcurrentUpdateError" and stale["err"]["expectedRevision"] == cur
    assert _counter(pystore.read_state(cd, LINEAGE)) == 6
    assert [n for n in os.listdir(os.path.join(cd, "odd-plugin/review-transactions/v2", LINEAGE)) if n.startswith(".atomic-")] == []
