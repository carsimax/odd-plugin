"""Differential: review/start against v9 dist/review/start.js. `startReview` takes functions (risk assessor, clock, token and lineage
seams) that the JSON oracle cannot carry, so each scenario runs through one small node script that builds them from data, on a
pristine real git repo restored to the same path before each side runs: the outcome (or thrown message), what the assessor was
handed and the whole `.git/odd-plugin` tree (every file byte for byte, names and modes) must be identical. `snapshotTargetOf` (pure)
goes through the oracle."""
import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest
from lib.v9_oracle import DIST, needs_v9
from odd_claude.review.snapshot import freeze_snapshot
from odd_claude.review.start import snapshot_target_of, start_review
from odd_claude.review.state import burn
from odd_claude.review.store import update_state

from review.conftest import diff_cases
from review.test_start import git

pytestmark = needs_v9

NODE = r"""
const [dist, payload] = process.argv.slice(1);
const spec = JSON.parse(payload);
const { startReview } = await import(dist + "/review/start.js");
const esc = (s) => s.replace(/[\u0080-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
const seen = [];
const input = structuredClone(spec.input);
const kind = spec.assess_kind ?? "fn";
if (kind === "fn") input.riskAssessor = (snapshot, repo) => { seen.push({ snapshot, repo }); return structuredClone(spec.assess); };
else if (kind === "undef") input.riskAssessor = (snapshot, repo) => { seen.push({ snapshot, repo }); return undefined; };
else if (kind === "throw") input.riskAssessor = () => { throw new Error("assessor boom"); };
else if (kind === "nonfn") input.riskAssessor = 5;
if ("now" in spec) input.now = () => spec.now;
if ("token" in spec) input.randomToken = () => spec.token;
if ("lineages" in spec) { const ids = [...spec.lineages]; input.randomLineage = () => ids.shift(); }
let out;
try { out = { outcome: await startReview(input) }; } catch (e) { out = { error: String(e && e.message !== undefined ? e.message : e) }; }
out.seen = seen;
process.stdout.write(esc(JSON.stringify(out)));
"""

LOW = {"level": "low", "reasons": [{"code": "non_executable_only"}], "evidence": []}
MED = {"level": "medium", "reasons": [{"code": "shell_source", "signal": "shell_process", "path": "a.txt"}], "evidence": ["shell scripting in a.txt"]}
HIGH = {**MED, "level": "high", "evidence": ["é\U0001f600 evidence", "second"]}
NOW = "2026-02-03T04:05:06.000Z"
TOKEN = "c" * 64
LIN = "review-" + "ab" * 8


# ---- pristine repos ----


def mk(path: Path, files: dict, dirty=None):
    path.mkdir(parents=True)
    git(path, "init", "-q", "-b", "main")
    for n, t in files.items():
        (path / n).write_text(t)
    git(path, "add", "-A")
    git(path, "commit", "-q", "-m", "init")
    for n, t in (dirty or {}).items():
        (path / n).write_text(t)
    return path


BASE_FILES = {"a.txt": "one\ntwo\nthree\n"}
DIRTY = {"a.txt": "one\nTWO\nthree\nfour\nfive\n"}


def _dirty(p):
    mk(p, BASE_FILES, DIRTY)


def _clean(p):
    mk(p, BASE_FILES)


def _staged(p):
    mk(p, BASE_FILES, DIRTY)
    git(p, "add", "a.txt")


def _feat(p):
    mk(p, BASE_FILES, DIRTY)
    git(p, "checkout", "-q", "-b", "feat")
    git(p, "commit", "-q", "-am", "work")


def _feat_dirty(p):
    _feat(p)
    (p / "a.txt").write_text("more\nwork\n")
    (p / "new.txt").write_text("untracked\n")


def _untracked(p):
    mk(p, BASE_FILES)
    (p / "é \U0001f600.txt").write_text("hello\n")
    (p / "sp ace.txt").write_text("x\n")


def _unicode(p):
    mk(p, {"é.txt": "a\n", "\U0001f600.txt": "b\n"}, {"é.txt": "a\nb\nc\n", "\U0001f600.txt": "changed\n"})


def _binary(p):
    mk(p, {"b.bin": "x"}, {})
    (p / "b.bin").write_bytes(bytes(range(256)))


def _empty_repo(p):
    p.mkdir(parents=True)
    git(p, "init", "-q", "-b", "main")
    (p / "a.txt").write_text("x\n")


def _live(p):
    _dirty(p)
    start_review(_py_input(p, {"consent": "granted"}, HIGH, {"now": NOW, "lineages": [LIN]}))


def _live_low(p):
    _dirty(p)
    start_review(_py_input(p, {"consent": "granted"}, LOW, {"now": NOW, "lineages": [LIN], "token": TOKEN}))


def _burned(p):
    _dirty(p)
    o = start_review(_py_input(p, {"consent": "granted"}, LOW, {"now": NOW, "lineages": [LIN], "token": TOKEN}))["result"]
    cd = str((p / ".git").resolve())
    update_state(cd, o["lineage_id"], o["acknowledgement"]["expected_revision"], lambda rec: burn(rec, {"now": "2026-02-03T04:05:07.000Z", "token": TOKEN}))


def _corrupt(p):
    _live_low(p)
    f = p / ".git" / "odd-plugin" / "review-transactions" / "v2" / LIN / "review-state.json"
    f.write_text(json.dumps({**json.loads(f.read_text()), "revision": "sha256:" + "7" * 64}))


def _corrupt_other(p):
    _live_low(p)
    f = p / ".git" / "odd-plugin" / "review-transactions" / "v2" / LIN / "review-state.json"
    f.write_text(json.dumps({**json.loads(f.read_text()), "target_identity": "sha256:" + "7" * 64, "revision": "sha256:" + "7" * 64}))


def _declined(p):
    _dirty(p)
    start_review(_py_input(p, {"consent": "declined"}, HIGH, {"now": "2020-01-01T00:00:00.000Z"}))


def _bad_decline(p):
    _dirty(p)
    start_review(_py_input(p, {"consent": "declined"}, HIGH, {"now": "2020-01-01T00:00:00.000Z"}))
    for f in (p / ".git" / "odd-plugin" / "declines").iterdir():
        f.write_text("not json")


def _store_is_file(p):
    _dirty(p)
    (p / ".git" / "odd-plugin").mkdir()
    (p / ".git" / "odd-plugin" / "review-transactions").write_text("not a dir")


SETUPS = {
    "dirty": _dirty, "clean": _clean, "staged": _staged, "feat": _feat, "feat_dirty": _feat_dirty, "untracked": _untracked, "unicode": _unicode, "binary": _binary,
    "empty_repo": _empty_repo, "live": _live, "live_low": _live_low, "burned": _burned, "corrupt": _corrupt, "corrupt_other": _corrupt_other, "declined": _declined,
    "bad_decline": _bad_decline, "store_is_file": _store_is_file, "weird_dir": _dirty,
}
WEIRD = "my repo é's \U0001f600"


@pytest.fixture(scope="module")
def pristine(tmp_path_factory):
    root = tmp_path_factory.mktemp("pristine")
    cache: dict[str, Path] = {}

    def get(name: str) -> Path:
        if name not in cache:
            # the pristine copy lives at its final path name only for setups that write absolute paths (declines/lineages hold none); restored per run
            dest = root / name / (WEIRD if name == "weird_dir" else "repo")
            SETUPS[name](dest)
            cache[name] = dest
        return cache[name]

    return get


@pytest.fixture(scope="module")
def work(tmp_path_factory):
    return tmp_path_factory.mktemp("work")


def restore(src: Path, dest: Path):
    if dest.exists():
        shutil.rmtree(dest)
    shutil.copytree(src, dest, symlinks=True)


def dump(repo: Path) -> dict:
    root = repo / ".git" / "odd-plugin"
    out = {}
    if not root.exists():
        return out
    for dirpath, dirs, files in os.walk(root):
        for n in sorted(dirs + files):
            q = Path(dirpath) / n
            st = q.lstat()
            out[str(q.relative_to(root))] = oct(st.st_mode) if q.is_dir() else (oct(st.st_mode), q.read_bytes().decode("latin1"))
    return out


def _py_input(repo, over, assess, seams):
    i = {"cwd": str(repo), "target": {"kind": "current-changes"}, **over}
    return {**i, **_seams(assess, seams)}


def _seams(assess, seams):
    out = {}
    if assess is not None:
        out["riskAssessor"] = lambda s, r: json.loads(json.dumps(assess))
    if "now" in seams:
        out["now"] = lambda: seams["now"]
    if "token" in seams:
        out["randomToken"] = lambda: seams["token"]
    if "lineages" in seams:
        ids = list(seams["lineages"])
        out["randomLineage"] = lambda: ids.pop(0) if ids else None
    return out


def run_py(spec, repo):
    seen = []
    kind = spec.get("assess_kind", "fn")
    i = {**spec["input"], "cwd": str(repo)}
    if kind == "fn":
        i["riskAssessor"] = lambda s, r: (seen.append({"snapshot": s, "repo": r}), json.loads(json.dumps(spec["assess"])))[1]
    elif kind == "undef":
        i["riskAssessor"] = lambda s, r: (seen.append({"snapshot": s, "repo": r}), None)[1]
    elif kind == "nonfn":
        i["riskAssessor"] = 5
    elif kind == "throw":
        def boom(s, r):
            raise Exception("assessor boom")

        i["riskAssessor"] = boom
    i.update({k: v for k, v in _seams(None, spec).items()})
    try:
        out = {"outcome": start_review(i)}
    except Exception as e:  # noqa: BLE001
        out = {"error": str(e)}
    out["seen"] = json.loads(json.dumps(seen))
    return out


def run_v9(spec, repo):
    s = {**spec, "input": {**spec["input"], "cwd": str(repo)}}
    r = subprocess.run(["node", "--input-type=module", "-e", NODE, DIST.as_uri(), json.dumps(s)], capture_output=True, text=True, encoding="ascii", timeout=120)
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout)


def check(pristine, work, setup, spec):
    src = pristine(setup)
    dest = work / (WEIRD if setup == "weird_dir" else "repo")
    results = []
    for side in (run_py, run_v9):
        restore(src.parent, dest.parent)
        results.append((side(spec, dest), dump(dest), git(dest, "status", "--porcelain=v1", "-z")))
    (py, py_dump, py_status), (v9, v9_dump, v9_status) = results
    label = f"{setup} {json.dumps(spec, ensure_ascii=True)[:400]}"
    assert py == v9, f"{label}\npython={json.dumps(py)[:800]}\nv9={json.dumps(v9)[:800]}"
    assert py_dump == v9_dump, f"{label}: store differs"
    assert py_status == v9_status, label
    return py


NULL = object()  # an assessor that returns JSON null (`assess=None` means: no assessor)


def spec(input=None, assess=MED, **kw):
    s = {"input": {"target": {"kind": "current-changes"}, "consent": "granted", **(input or {})}, "now": NOW, "token": TOKEN, "lineages": [LIN, "review-" + "cd" * 8, "review-" + "ef" * 8], **kw}
    if assess is not None:
        s["assess"] = None if assess is NULL else assess
    return s


def cases(pristine, work, setup, specs):
    for s in specs:
        check(pristine, work, setup, s)


def test_snapshot_target_of_equals_v9():
    targets = [None, {"kind": "current-changes"}, {"kind": "base-diff", "baseRef": "m"}, {"kind": "base-diff", "baseRef": "m", "committedOnly": True}, {"kind": "base-diff", "baseRef": "m", "committedOnly": "true"},
               {"kind": "base-diff", "baseRef": "m", "committedOnly": 1}, {"kind": "x", "baseRef": "m"}, {"baseRef": "m"}, {"kind": "base-diff"}]
    calls = [[{} if t is None else {"target": t, **({"projection": p} if p is not None else {})}] for t in targets for p in (None, "staged", "workspace", "nope")]
    calls += [[{"projection": p}] for p in ("staged", "workspace", "nope", None, 5)]
    diff_cases("review/start", "snapshotTargetOf", snapshot_target_of, calls)


def test_validation_and_refusals(pristine, work):
    cases(pristine, work, "dirty", [
        spec({"consent": c}, assess=a) for c in ("relay", "granted", "declined", "maybe", None, "", "GRANTED", 1) for a in (LOW, MED, HIGH)
    ] + [
        spec({"target": t}) for t in (
            None, "x", 5, [], {}, ["current-changes"], {"kind": "bogus"}, {"kind": None}, {"kind": "base-diff"}, {"kind": "base-diff", "baseRef": ""}, {"kind": "base-diff", "baseRef": "  "},
            {"kind": "base-diff", "baseRef": "﻿"}, {"kind": "base-diff", "baseRef": "  "}, {"kind": "base-diff", "baseRef": "\x1c"}, {"kind": "base-diff", "baseRef": "\x85"},
            {"kind": "base-diff", "baseRef": 5}, {"kind": "base-diff", "baseRef": None}, {"kind": "base-diff", "baseRef": "nonexistent-ref"}, {"kind": "base-diff", "baseRef": "main\n"},
            {"kind": "base-diff", "baseRef": "main", "committedOnly": "true"}, {"kind": "base-diff", "baseRef": "main", "committedOnly": True}, {"kind": "base-diff", "baseRef": "main", "committedOnly": False},
            {"kind": "base-diff", "baseRef": "--help"}, {"kind": "base-diff", "baseRef": "maïn"},
        )
    ] + [
        spec({"projection": p}) for p in ("workspace", "staged", "nope", None, 5, "", "Staged")
    ] + [
        spec({"target": {"kind": "base-diff", "baseRef": "main"}, "projection": "staged"}),
        spec({}, assess=None, assess_kind="absent"), spec({}, assess=None, assess_kind="nonfn"), spec({}, assess=None, assess_kind="undef"),
        spec({"cwd": ""}), spec({"cwd": None}), spec({"cwd": 5}), spec({"cwd": "/nonexistent/odd/dir"}), spec({"cwd": "bad\0nul"}),
        spec({"consent": "maybe", "cwd": "/nonexistent/odd/dir"}),
    ])


def test_risk_assessment_validation_and_lens_policy(pristine, work):
    weird_reasons = [
        {"level": "high", "reasons": [r], "evidence": []} for r in ("abc", 5, None, [1, 2], {"code": "x", "extra": {"n": [1]}}, "é\U0001f600", True, {})
    ]
    bad = [
        NULL, [], "x", 5, {}, {"level": "extreme", "reasons": [{"code": "x"}], "evidence": []}, {"level": "LOW", "reasons": [{"code": "x"}], "evidence": []}, {"level": None, "reasons": [{"code": "x"}], "evidence": []},
        {"level": "low", "reasons": [], "evidence": []}, {"level": "low", "reasons": "x", "evidence": []}, {"level": "low", "reasons": [{"code": "x"}]}, {"level": "low", "reasons": [{"code": "x"}], "evidence": "x"},
        {"level": "low", "reasons": [{"code": "x"}], "evidence": None}, {"level": "high", "reasons": [{"code": "x"}], "evidence": []}, {"level": "medium", "reasons": [{"code": "x"}], "evidence": ["e"]},
        {"level": "low", "reasons": [{"code": "x"}], "evidence": [], "extra": 1},
    ]
    focus = [{**MED, "focusLens": f} for f in ("readability", "resilience", "reliability", "risk", "", "nope", "review-risk", 5, None, ["risk"], {}, "é")]
    explicit = []
    reasons = ("x", "retry logic é\U0001f600", None, 5, "", "  ", "\u00a0\ufeff", "\u2028", "x" * 500, "x" * 501, "\U0001f600" * 250, "\U0001f600" * 251, "\u00e9" * 500, "\u00e9" * 501)
    n = 0
    for lenses in (["risk"], ["review-risk"], ["reliability"], ["review-reliability"], ["risk", "reliability"], ["reliability", "risk"], ["risk", "risk"], ["risk", "resilience", "readability", "reliability"],
                   ["risk", "resilience", "readability", "reliability", "risk"], [], None, "risk", {"0": "risk"}, [5], [None], [["risk"]], [{"a": 1}], [""], ["review-"], ["review-review-risk"], ["RISK"], ["é\U0001f600"], [True], ["risk", 5], [1.5], ["bad\ud800"]):
        for level, a in (("low", LOW), ("medium", MED), ("high", HIGH)):
            explicit.append(spec({"lenses": lenses, "lensesReason": "x" if lenses is None else reasons[n % 2 if level != "high" else 0]}, assess=a))
            n += 1
    explicit += [spec({"lenses": ["risk"], "lensesReason": r}, assess=MED) for r in reasons]
    cases(pristine, work, "dirty", [spec(assess=a) for a in bad + weird_reasons + focus])
    # an explicit selection is a lot of combinations; each runs a real freeze on both sides, so sample every 7th plus all low/medium/high edge columns
    cases(pristine, work, "dirty", explicit)
    cases(pristine, work, "dirty", [spec({"lensesReason": r}, assess=a) for r in ("orphan", None, "", 5) for a in (LOW, MED, HIGH)] + [spec({"lenses": ["risk"]}, assess=a) for a in (LOW, MED, HIGH)])


def test_modes_and_outcomes(pristine, work):
    cases(pristine, work, "dirty", [spec({"consent": c}, assess=a) for c in ("relay", "granted", "declined") for a in (LOW, MED, HIGH)])
    for setup, extra in (("staged", {"projection": "staged"}), ("untracked", {}), ("unicode", {}), ("binary", {}), ("weird_dir", {})):
        cases(pristine, work, setup, [spec({"consent": "relay", **extra}, assess=HIGH), spec({"consent": "granted", **extra}, assess=MED), spec({"consent": "granted", **extra}, assess=LOW)])
    cases(pristine, work, "clean", [spec({"consent": c}) for c in ("relay", "granted", "declined")] + [spec({"projection": "staged"}), spec({"target": {"kind": "base-diff", "baseRef": "main"}})])
    cases(pristine, work, "empty_repo", [spec(), spec({"consent": "relay"})])
    cases(pristine, work, "feat", [
        spec({"target": {"kind": "base-diff", "baseRef": "main", **o}, "consent": c, **extra}, assess=a)
        for o in ({}, {"committedOnly": True}, {"committedOnly": False}) for c in ("relay", "granted", "declined") for a in (MED, HIGH) for extra in ({}, {"lenses": ["reliability"], "lensesReason": "it's a retry loop"})
    ])
    cases(pristine, work, "feat_dirty", [
        spec({"target": {"kind": "base-diff", "baseRef": "main", **o}, "consent": c}, assess=HIGH) for o in ({}, {"committedOnly": True}) for c in ("relay", "granted")
    ] + [spec({"consent": "relay"}), spec({"consent": "granted"}, assess=LOW)])


def test_envelope_locale_and_lens_text(pristine, work):
    # not asserted: a null or non-string locale (consent.py reads it as absent, v9 coerces it); see the handoff
    lens = {"lenses": ["readability", "reliability"], "lensesReason": "it's é\U0001f600 \"q\" $x `y`"}
    locales = ("es", "es-MX", "ES_ar", "eso", "es-", "", "en", "en-US", "é", "es\n", " es", "\u00e9s")
    cases(pristine, work, "dirty", [spec({"consent": "relay", "locale": loc}, assess=MED) for loc in locales] + [spec({"consent": "relay", "locale": loc, **lens}, assess=HIGH) for loc in ("es", "en", "é", "")])



def test_existing_lineages_declines_and_failures(pristine, work):
    for setup in ("live", "live_low", "burned", "corrupt", "corrupt_other", "declined", "bad_decline", "store_is_file"):
        cases(pristine, work, setup, [spec({"consent": c}, assess=a) for c in ("relay", "granted", "declined") for a in (LOW, MED, HIGH)])
    cases(pristine, work, "live_low", [spec({"consent": "granted"}, assess=LOW, now=n) for n in ("garbage", "2030-01-01T00:00:00.000Z")])


def test_seams_and_collisions(pristine, work):
    other = "review-" + "99" * 8
    cases(pristine, work, "dirty", [
        spec(assess=a, **kw)
        for a in (LOW, MED, HIGH)
        for kw in (
            {"now": "garbage"}, {"now": "2026-02-03T04:05:06Z"}, {"now": ""}, {"now": "2026-13-45T04:05:06.000Z"}, {"lineages": ["bad"]}, {"lineages": [LIN.upper()]}, {"lineages": []}, {"lineages": [5]},
            {"token": "short"}, {"token": ""}, {"token": "g" * 64}, {"token": TOKEN.upper()},
        )
    ])
    cases(pristine, work, "live", [spec({"consent": "granted", "expectedTargetIdentity": x}, assess=HIGH) for x in ("sha256:" + "0" * 64, None, 5, "")])
    # a different candidate whose first lineage id collides with an existing one is retried; three collisions in a row propagate
    cases(pristine, work, "live_low", [
        spec({"consent": "granted", "expectedTargetIdentity": None}, assess=HIGH, lineages=ids) for ids in ([LIN, other], [LIN, LIN, other], [LIN, LIN, LIN, other], [LIN, LIN, LIN])
    ])


def test_expected_target_identity(pristine, work):
    src = pristine("dirty")
    ident = freeze_snapshot(str(src), {"kind": "current-changes", "projection": "workspace"})["snapshot"]["identity"]
    cases(pristine, work, "dirty", [
        spec({"consent": c, "expectedTargetIdentity": x}, assess=a)
        for x in (ident, "sha256:" + "0" * 64, None, "", 5) for c in ("relay", "granted", "declined") for a in (LOW, HIGH)
    ])


def test_assessor_receives_the_frozen_snapshot_and_repository(pristine, work):
    out = check(pristine, work, "dirty", spec())
    seen = out["seen"][0]
    assert set(seen["snapshot"]) >= {"identity", "paths", "changedLines", "baseTree", "candidateTree", "projection"} and set(seen["repo"]) == {"root", "gitDir", "commonDir"}


def test_throwing_assessor_propagates_and_writes_nothing(pristine, work):
    out = check(pristine, work, "dirty", spec(assess=None, assess_kind="throw"))
    assert out["error"] == "assessor boom"
