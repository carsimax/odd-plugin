"""Differential test: Python lib/profiles.py against the compiled v9 lib/profiles.js on the same inputs and the same state."""
import tempfile
from pathlib import Path

from odd_claude.lib import profiles as p
from odd_claude.lib.state import StateOptions

from .v9_oracle import needs_v9, v9

pytestmark = needs_v9

SEEDS = [
    None, "", "{", "[]", "null", '{"version":1,"data":{}}', '{"version":2,"data":{"active":"max"}}',
    '{"version":1,"data":{"active":"max"}}', '{"version":1,"data":{"active":"economy","routing":{}}}',
    '{"version":1,"data":{"active":"custom","routing":{"odd-worker":{"model":"opus","effort":"max"},"odd-explore":{"model":"haiku","effort":"bogus"},"odd-verify":{"model":"gpt"},"zzz":{"model":"opus"},"review-refuter":{"model":"haiku"}}}}',
    '{"version":1,"data":{"active":"economy","routing":{"odd-worker":{"model":"opus","effort":"low"},"odd-jd-fix":5,"odd-review-risk":null,"odd-verify":{"model":"sonnet","effort":7}}}}',
    '{"version":1,"data":{"active":"nope","routing":{}}}', '{"version":1,"data":{"active":["max"]}}',
    '{"version":1,"data":{"active":"balanced","routing":[]}}', '{"version":1,"data":{"active":"max","routing":"x"}}',
    '{"version":1,"data":{"active":"max","routing":{"odd-worker":{"model":"opus","effort":"\\ud800"}}}}',
    '{"version":1,"data":{"active":"max","routing":{"__proto__":{"model":"opus"},"constructor":{"model":"opus"}}}}',
    '{"version":1.0,"data":{"active":"max"}}', '{"version":1,"data":[]}', '{"version":true,"data":{}}',
    '﻿{"version":1,"data":{"active":"max"}}', "NaN",
]
STRINGS = [
    "balanced", "economy", "max", "custom", "", " ", "Balanced", "max ", "\U0001f600", " ", "﻿", " ",
    "\ud800", "a\ud83dz", '"q"', "back\\slash", "ctl\x01\x1f\x7f", "tab\t\n", "x" * 5000, "é", "\u0000",
]
ROLES = [*p.PROFILE_ROLES, *p.NATIVE_REVIEW_ROLES, "odd-explore ", "ODD-WORKER", *STRINGS, None, 5, True, ["odd-worker"]]
MODELS = [*p.PROFILE_MODELS, "Haiku", "opus ", *STRINGS, None, 3]
EFFORTS = [None, *p.PROFILE_EFFORTS, "HIGH", *STRINGS, 0, False]


def snap(d: str) -> dict:
    return {str(f.relative_to(d)): f.read_bytes() for f in sorted(Path(d).rglob("*")) if f.is_file()}


def seed(d: str, raw: str | None) -> None:
    if raw is not None:
        Path(d, "profiles.json").write_text(raw, encoding="utf-8")


def prof(x) -> dict:
    return {"active": x.active, "routing": {k: v.stored() for k, v in x.routing.items()}}


def py(fn, *a):
    try:
        r = fn(*a)
    except Exception as e:  # noqa: BLE001
        return {"__error__": str(e)}
    return prof(r) if isinstance(r, p.Profile) else r


def test_default_profile():
    assert v9("profiles", "defaultProfile") == prof(p.default_profile())


def test_read_profile_and_context_line_over_seeded_state():
    for raw in SEEDS:
        with tempfile.TemporaryDirectory() as dj, tempfile.TemporaryDirectory() as dp:
            seed(dj, raw)
            seed(dp, raw)
            o = StateOptions(data_dir=dp)
            assert v9("profiles", "readProfile", {"dataDir": dj}) == py(p.read_profile, o), raw
            assert v9("profiles", "profileContextLine", {"dataDir": dj}) == p.profile_context_line(o), raw
            assert snap(dj) == snap(dp), raw


def test_read_profile_without_data_dir_file_and_relative_dir():
    with tempfile.TemporaryDirectory() as dj, tempfile.TemporaryDirectory() as dp:
        assert v9("profiles", "readProfile", {"dataDir": dj}) == py(p.read_profile, StateOptions(data_dir=dp))
    assert v9("profiles", "readProfile", {"dataDir": "relative/x"}) == py(p.read_profile, StateOptions(data_dir="relative/x"))


def test_use_profile_results_errors_and_files():
    for raw in (None, SEEDS[9]):
        for name in STRINGS + [None, 5, True, ["max"], {"a": 1}]:
            with tempfile.TemporaryDirectory() as dj, tempfile.TemporaryDirectory() as dp:
                seed(dj, raw)
                seed(dp, raw)
                assert v9("profiles", "useProfile", name, {"dataDir": dj}) == py(p.use_profile, name, StateOptions(data_dir=dp)), name
                assert snap(dj) == snap(dp), name


def test_use_profile_every_preset_writes_same_bytes():
    for name in p.PRESET_NAMES:
        with tempfile.TemporaryDirectory() as dj, tempfile.TemporaryDirectory() as dp:
            assert v9("profiles", "useProfile", name, {"dataDir": dj}) == py(p.use_profile, name, StateOptions(data_dir=dp))
            assert snap(dj) == snap(dp)


def test_set_role_sweep():
    cases = []
    for r in ROLES:
        cases.append((r, "opus", None))
    for m in MODELS:
        cases.append(("odd-worker", m, None))
    for e in EFFORTS:
        cases.append(("odd-worker", "sonnet", e))
    cases += [("bogus", "bogus", "bogus"), ("odd-worker", "bogus", "bogus"), ("review-refuter", "opus", "low"), ("odd-jd-fix", "haiku", "max")]
    for raw in (None, SEEDS[9], SEEDS[10]):
        for role, model, effort in cases:
            with tempfile.TemporaryDirectory() as dj, tempfile.TemporaryDirectory() as dp:
                seed(dj, raw)
                seed(dp, raw)
                # JSON null is not undefined: an absent effort is sent as a 2-argument call; the data dir goes through the env.
                args = [role, model] if effort is None else [role, model, effort]
                assert v9("profiles", "setRole", *args, env={"ODD_CLAUDE_DATA": dj}) == py(
                    p.set_role, role, model, effort, StateOptions(env={"ODD_CLAUDE_DATA": dp})
                ), args
                assert snap(dj) == snap(dp), args


def test_clear_profile_files():
    for raw in (None, SEEDS[9], "{"):
        with tempfile.TemporaryDirectory() as dj, tempfile.TemporaryDirectory() as dp:
            seed(dj, raw)
            seed(dp, raw)
            assert v9("profiles", "clearProfile", {"dataDir": dj}) == p.clear_profile(StateOptions(data_dir=dp))
            assert snap(dj) == snap(dp)


def test_render_profiles_and_preset_list():
    assert v9("profiles", "renderProfiles", v9("profiles", "defaultProfile")) == p.render_profiles(p.default_profile())
    for n in p.PRESET_NAMES:
        with tempfile.TemporaryDirectory() as dj, tempfile.TemporaryDirectory() as dp:
            j = v9("profiles", "useProfile", n, {"dataDir": dj})
            assert v9("profiles", "renderProfiles", j) == p.render_profiles(p.use_profile(n, StateOptions(data_dir=dp)))
    for a in [*p.PRESET_NAMES, "custom", "", "x", "\U0001f600", "\ud800", "balanced "]:
        assert v9("profiles", "renderPresetList", a) == p.render_preset_list(a), a
