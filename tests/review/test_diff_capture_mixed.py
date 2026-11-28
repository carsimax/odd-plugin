"""Mixed-implementation regression (T5 verifier probe): a full high-risk lifecycle and a refuter flow run with v9 and Python
alternating per step in 6 patterns; every pattern's transcript (results and store digests) must equal the all-v9 run."""
import shutil
from pathlib import Path

from odd_claude.review.store import read_state

from review.test_capture import FAIL_CRITERIA, INFERENTIAL, SEVERE, fixture, lens_input, refuter_result, validator_result  # noqa: F401
from review.test_diff_capture import Backend, corrected_candidates, env, store_digest, needs_v9, pytestmark  # noqa: F401
class Mixed:
    def __init__(self, pattern, cd, env):
        self.v9 = Backend("v9", cd, env); self.py = Backend("py", cd, env); self.pattern = pattern; self.i = 0; self.log = []
    def __call__(self, fn, *args, opts=None):
        impl = self.pattern[self.i % len(self.pattern)]; self.i += 1
        b = self.v9 if impl == "v" else self.py
        r = b(fn, *args, opts=opts)
        self.log.append(b.log[-1])
        return r


def run_patterns(fx, sc, env):
    store = Path(fx.common_dir) / "odd-plugin"
    bak = Path(fx.common_dir).parent.parent / "store-backup-mixed"
    shutil.copytree(store, bak)
    logs = {}
    for pat in ("v", "p", "vp", "pv", "vvp", "ppv"):
        shutil.rmtree(store); shutil.copytree(bak, store)
        m = Mixed(pat, fx.common_dir, env)
        sc(m)
        logs[pat] = m.log
    for pat, log in logs.items():
        assert log == logs["v"], f"pattern {pat} differs: " + str([(i, a[0]) for i, (a, b) in enumerate(zip(log, logs['v'])) if a != b][:3])
    return logs["v"]


def test_mixed_high_lifecycle_to_approved(fixture, env):
    fx, lineage, record = fixture("high")
    cand = corrected_candidates(fx)
    cd, rep = fx.common_dir, fx.repository

    def sc(call):
        rec = read_state(cd, lineage)
        for lens in rec["selected_lenses"]:
            s = call("captureLensResult", cd, lineage, rec["revision"], lens_input(fx, rec, lens, [SEVERE] if lens == "risk" else []))
            rec = s["record"]
        call("planCorrection", cd, lineage)
        v1 = call("beginCorrectionValidation", rep, lineage, s["revision"], cand["first"])
        r1 = call("captureValidatorResult", cd, lineage, v1["revision"], {"result": validator_result(v1["record"], **FAIL_CRITERIA), "correctionCandidateTree": cand["first"]["candidateTree"]})
        v2 = call("beginCorrectionValidation", rep, lineage, r1["revision"], cand["second"])
        call("captureValidatorResult", cd, lineage, v2["revision"], {"result": validator_result(v2["record"]), "correctionCandidateTree": cand["second"]["candidateTree"]})
    log = run_patterns(fx, sc, env)
    assert log[-1][2]["state"] == "approved"


def test_mixed_refuter_flow(fixture, env):
    fx, lineage, record = fixture("medium")
    cd = fx.common_dir

    def sc(call):
        rec = read_state(cd, lineage)
        held = call("captureLensResult", cd, lineage, rec["revision"], lens_input(fx, rec, "risk", [INFERENTIAL, {**INFERENTIAL, "location": "b.txt:1"}]), opts={"awaitRefuter": True})
        done = call("captureRefuterResult", cd, lineage, held["revision"], {"result": refuter_result(held["record"], [{"finding_id": "R1-1", "outcome": "refuted"}, {"finding_id": "R1-2", "outcome": "corroborated"}])})
        call("completeReview", cd, lineage, done["revision"])
    log = run_patterns(fx, sc, env)
    assert len(log) == 3 and not any("__error__" in e[2] for e in log)
