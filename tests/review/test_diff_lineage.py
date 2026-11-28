"""Differential: review/lineage against v9 dist/review/lineage.js through the oracle: `readRawState` over every file type (absent,
valid, array, invalid, BOM, oversized, invalid UTF-8, symlink, hardlink, directory, FIFO, NUL in the path), `findLineage` over real
store directories written by the Python store and read by BOTH sides (live, burned, unreadable, mismatching, limits), and the two
pure helpers."""
import json
import os

import pytest
from lib.v9_oracle import needs_v9
from odd_claude.review import lineage as L
from odd_claude.review.state import burn, start
from odd_claude.review.store import create_state, store_root_for, update_state

from review.conftest import diff_cases

pytestmark = needs_v9
MOD = "review/lineage"
NOW = "2026-11-19T10:00:00.000Z"


def same(fn, py_fn, calls):
    diff_cases(MOD, fn, py_fn, calls)


def test_read_raw_state_every_file_type(tmp_path):
    p = lambda n: str(tmp_path / n)  # noqa: E731

    def w(name, data):
        (tmp_path / name).write_bytes(data if isinstance(data, bytes) else data.encode("utf-8"))
        return p(name)

    big_ok = b'{"a":"' + b"x" * ((1 << 20) - 10) + b'"}'
    paths = [
        p("absent"), p("absent/deeper"), w("obj", '{"a": 1, "b": [1, 2.5, "é\U0001f600"], "c": null}'), w("arr", "[1]"), w("str", '"s"'), w("num", "1"), w("null", "null"),
        w("empty", ""), w("bad", "{nope"), w("trailing", "{} x"), w("bom", "﻿{}"), w("ws", ' \n\t{"a":1}\n '), w("dups", '{"a":1,"a":2}'), w("esc", '{"k":"\\ud83d\\ude00\\u00e9\\ud800"}'),
        w("badutf8", b'{"k":"\xff\xfe\xc3("}'), w("trunc", b'{"k":"\xe2\x82'), w("nulbyte", b'{"k":"a\x00b"}'), w("big", big_ok), w("toobig", big_ok + b" "), w("exact", b" " * (1 << 20)),
        w("deep", "[" * 5000 + "]" * 5000), w("deepobj", '{"a":' * 3000 + "1" + "}" * 3000), w("numbers", '{"a":1e5,"b":-0,"c":1234567890123456,"d":0.1}'), w("int-keys", '{"b":1,"2":2,"1":3}'),
        p(""), p("a\0b"), str(tmp_path),
    ]
    os.symlink(p("obj"), p("link"))
    os.symlink(p("absent"), p("dangling"))
    os.link(p("obj"), p("hard"))
    os.mkfifo(p("fifo"))
    paths += [p("link"), p("dangling"), p("hard"), p("fifo")]
    same("readRawState", L.read_raw_state, [[x] for x in paths])


NODE_PROBE = None


def low(n, target="sha256:" + "1" * 64, projection="workspace"):
    out = start({"lineageId": f"review-{n:016x}", "targetIdentity": target, "projection": projection, "baseTree": "b" * 40, "candidateTree": "c" * 40,
                 "riskLevel": "low", "selectedLenses": [], "originalChangedLines": 6, "now": NOW})
    assert out["ok"]
    return out


def sfile(cd, n):
    return os.path.join(store_root_for(cd), f"review-{n:016x}", "review-state.json")


def do_burn(cd, o):
    update_state(cd, o["record"]["lineage_id"], o["record"]["revision"], lambda r: burn(r, {"token": o["ackToken"], "now": NOW}))


def test_find_lineage_over_real_stores(tmp_path):
    t1, t2 = "sha256:" + "1" * 64, "sha256:" + "2" * 64
    cd = str(tmp_path / "s1.git")
    os.mkdir(cd)
    calls = []

    def probe(*opts):
        for t in (t1, t2, "sha256:" + "9" * 64, "x", "", None, 5):
            for proj in ("workspace", "staged", None, 1):
                for o in opts:
                    calls.append([cd, t, proj, *([] if o is None else [o])])

    probe(None)  # empty / absent store
    os.makedirs(os.path.join(cd, "odd-plugin", "review-transactions", "v2"))
    probe(None)
    a, b, c, d_, e = low(1), low(2), low(3, target=t2), low(4, projection="staged"), low(5)
    for o in (a, b, c, d_):
        create_state(cd, o["record"])
    probe(None, {"limit": 1}, {"limit": 0}, {"maxScan": 1}, {"maxScan": 0}, {"limit": 2, "maxScan": 3}, {})
    do_burn(cd, a)  # a burned, b live (same candidate)
    probe(None, {"limit": 1})
    do_burn(cd, b)  # only burned now
    probe(None)
    create_state(cd, e["record"])  # a live one after two burned
    probe(None, {"limit": 3})
    open(sfile(cd, 3), "w").write("{garbage")  # unreadable, claims nothing
    probe(None)
    raw = json.loads(open(sfile(cd, 4)).read())
    open(sfile(cd, 4), "w").write(json.dumps({**raw, "revision": "sha256:" + "0" * 64}))  # unreadable, claims (t1, staged)
    probe(None, {"limit": 3})
    open(sfile(cd, 5), "w").write(json.dumps({**raw, "revision": "x", "target_identity": t2, "projection": "workspace"}))  # unreadable, claims (t2, workspace)
    os.rename(sfile(cd, 1), sfile(cd, 1) + ".real")
    os.symlink(sfile(cd, 1) + ".real", sfile(cd, 1))  # a symlinked state: unsafe, claims nothing
    os.link(sfile(cd, 2), sfile(cd, 2) + ".hard")  # a hardlinked state: unsafe
    os.mkdir(os.path.join(store_root_for(cd), "review-" + "e" * 16))  # empty lineage dir: not found
    probe(None, {"limit": 1}, {"maxScan": 2})
    same("findLineage", L.find_lineage, calls)


def test_find_lineage_dirty_options_and_unicode_target(tmp_path):
    cd = str(tmp_path / "s2.git")
    os.mkdir(cd)
    for n in (1, 2, 3):
        create_state(cd, low(n)["record"])
    t = "sha256:" + "1" * 64
    opts = [{"limit": -1}, {"maxScan": -3}, {"limit": 1, "maxScan": 1}, {"unknown": 1}, {"limit": 100000, "maxScan": 100000}]
    calls = [[cd, t, "workspace", o] for o in opts] + [[cd, "é\U0001f600", "workspace"], [cd, t, "é"]]
    same("findLineage", L.find_lineage, calls)


def test_lenses_pending_and_has_role():
    recs = [
        {"selected_lenses": ["a", "b", "c"], "admitted_role_results": [{"role": "lens", "lens": "b"}, {"role": "refuter", "lens": "c"}]},
        {"selected_lenses": [], "admitted_role_results": []}, {"selected_lenses": ["é", "\U0001f600"], "admitted_role_results": [{"role": "lens", "lens": "é"}]},
        {"selected_lenses": ["a", "a"], "admitted_role_results": [{"role": "lens", "lens": "a"}]}, {"selected_lenses": ["a"], "admitted_role_results": [{"role": "lens"}, {}]},
        {"selected_lenses": [None, 1, "a"], "admitted_role_results": [{"role": "lens"}, {"role": "lens", "lens": None}, {"role": None}]},
        {"selected_lenses": ["a"], "admitted_role_results": [{"role": "validator", "lens": "a"}]}, {"selected_lenses": ["1"], "admitted_role_results": [{"role": "lens", "lens": 1}]},
        {"selected_lenses": ["risk", "reliability"], "admitted_role_results": [{"role": "lens", "lens": "risk"}, {"role": "refuter"}, {"role": "validator"}]},
    ]
    same("lensesPending", L.lenses_pending, [[r] for r in recs])
    same("hasRole", L.has_role, [[r, role] for r in recs for role in ("lens", "refuter", "validator", "x", "", None, 1)])
