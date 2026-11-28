"""Differential: review/consent against v9 dist/review/consent.js through the oracle, on real temp dirs shared by both sides
(v9 writes and Python reads, and the reverse; the declines directory is compared byte for byte)."""
import json
import os
import subprocess
import tempfile
from pathlib import Path

from lib.v9_oracle import DIST, needs_v9, v9, v9_many
from odd_claude.review import consent as C
from review.conftest import diff_cases, tree_hash

pytestmark = needs_v9
MOD = "review/consent"
ID = "sha256:" + "ab" * 32
ID2 = "sha256:" + "cd" * 32
ENVS = [{}, {"CLAUDE_PLUGIN_ROOT": ""}, {"CLAUDE_PLUGIN_ROOT": "/opt/odd root"}, {"CLAUDE_PLUGIN_ROOT": "/it's/x"}, {"CLAUDE_PLUGIN_ROOT": "/a/../b//c/"}, {"CLAUDE_PLUGIN_ROOT": "rel"}]


def test_constants_equal_v9():
    js = f'import * as m from {json.dumps((DIST / "review" / "consent.js").as_uri())}; process.stdout.write(JSON.stringify([m.REVIEW_CONTRACT, m.CONSENT_SCHEMA, m.DECLINE_SCHEMA, m.REVIEW_TOOL_NAMES, m.INVOCATION_PREFIX]))'
    out = json.loads(subprocess.run(["node", "--input-type=module", "-e", js], capture_output=True, text=True, check=True).stdout)
    assert out == [C.REVIEW_CONTRACT, C.CONSENT_SCHEMA, C.DECLINE_SCHEMA, list(C.REVIEW_TOOL_NAMES), C.INVOCATION_PREFIX]


def test_review_command_and_shell_quote():
    diff_cases(MOD, "reviewCommand", C.review_command, [[v] for v in ("start", "capture", "capture-group", "run", "complete", "acknowledge-approved")])
    words = ["main", "a b", "it's", "", "a'b'c", "x/y.z-1_2@%+=:,", "é", "a\nb", "$(x)", "`x`", "a\\b", "\"q\"", "-", "~", "a;b", "\u0000", "ſ", "x\n"]
    diff_cases(MOD, "shellQuote", C.shell_quote, [[w] for w in words])


def test_binding():
    calls = [[ID], [ID, {"names": ["risk", "reliability"], "reason": "why"}], [ID, {"names": ["review-risk"], "reason": ""}], [ID, {"names": [], "reason": "r"}],
             [ID2, {"names": ["review-review-x", "x-review-"], "reason": "é😀"}], ["not an id"]]
    diff_cases(MOD, "consentBinding", C.consent_binding, calls)


def test_off_path_and_plugin_root_for_every_env():
    for fn, py in (("offPathCommand", C.off_path_command), ("pluginRootDir", C.plugin_root_dir)):
        diff_cases(MOD, fn, py, [[e] for e in ENVS])


def test_default_env_off_path_command(monkeypatch):
    for v in ("", "/opt/odd root"):
        monkeypatch.setenv("CLAUDE_PLUGIN_ROOT", v)
        assert C.off_path_command() == v9(MOD, "offPathCommand", env={"CLAUDE_PLUGIN_ROOT": v}), v


def inputs():
    b = {"cwd": "/r", "targetIdentity": ID, "projection": "workspace", "riskLevel": "high", "changedFiles": 1, "changedLines": 1, "riskEvidence": [], "targetArgs": ["--target", "current-changes"]}
    L = {"names": ["risk", "review-reliability"], "reason": "why not"}
    out = [b, {**b, "cwd": "/my repo", "projection": "staged", "riskLevel": "medium", "changedFiles": 2, "changedLines": 9, "riskEvidence": ["x", "y"]},
           {**b, "targetArgs": ["--target", "base-diff", "--base-ref", "main", "--committed-only", "true"]}, {**b, "lenses": L}, {**b, "lenses": {"names": [], "reason": ""}},
           {**b, "agent": "claude-code"}, {**b, "agent": "other"}, {**b, "agent": ""}, {**b, "cwd": "it's"}, {**b, "targetArgs": []}, {**b, "targetArgs": ["base-diff"]},
           {**b, "targetArgs": ["--x", "base-diff-y"]}]
    for loc in ("es", "es-ES", "ES_mx", "es_", "esp", "en", "", "fr", "ES\n", "es\n", "e s", "'es'", "ſs", "é", "es-é"):
        out.append({**b, "locale": loc, "lenses": L})
    return out


def test_build_consent_envelope_equals_v9_for_every_env_and_input(monkeypatch):
    for env in ENVS:  # the envelope reads the process environment on both sides
        monkeypatch.delenv("CLAUDE_PLUGIN_ROOT", raising=False)
        for k, v in env.items():
            monkeypatch.setenv(k, v)
        diff_cases(MOD, "buildConsentEnvelope", C.build_consent_envelope, [[i] for i in inputs()], env=env)


def test_decline_paths_equal_v9():
    ids = [ID, ID2, "sha256:" + "AB" * 32, "sha256:" + "a" * 63, "sha256:" + "a" * 65, ID + "\n", "../../etc/passwd", "", "sha256:", " " + ID]
    diff_cases(MOD, "declinePathFor", C.decline_path_for, [["/c/d", i] for i in ids] + [["/c//d/", ID], ["rel", ID]])
    diff_cases(MOD, "declinesDirFor", C.declines_dir_for, [["/c/d"], ["/c//d/"], ["rel"], [""], ["/"]])


def _files(d: str) -> dict:
    return {str(p.relative_to(d)): (p.read_bytes(), oct(p.stat().st_mode & 0o777)) for p in sorted(Path(d).rglob("*")) if p.is_file()}


def test_record_and_read_decline_round_trip_both_ways_byte_identical():
    recs = [
        {"target_identity": ID, "projection": "workspace", "risk_level": "high", "declined_at": "2026-01-01T00:00:00Z"},
        {"target_identity": ID2, "projection": "staged", "risk_level": "medium", "declined_at": "é😀", "extra": {"z": 1, "a": [1.5, None]}},
        {"target_identity": ID, "projection": "workspace", "risk_level": "high", "declined_at": "2027-01-01T00:00:00Z"},
    ]
    with tempfile.TemporaryDirectory() as dj, tempfile.TemporaryDirectory() as dp:
        for r in recs:
            want = v9(MOD, "recordDecline", dj, r)
            got = C.record_decline(dp, r)
            assert (got["created"], got["path"].replace(dp, "")) == (want["created"], want["path"].replace(dj, "")), r
        assert _files(dj) == _files(dp)
        for d in (dj, dp):
            assert oct(os.stat(os.path.join(d, "odd-plugin", "declines")).st_mode & 0o777) == "0o700"
        for i in (ID, ID2, "sha256:" + "ef" * 32):
            want = v9(MOD, "readDecline", dj, i)
            assert C.read_decline(dp, i) == want
            assert C.read_decline(dj, i) == want  # python reads what v9 wrote, v9 reads what python wrote:
            assert v9(MOD, "readDecline", dp, i) == want


def test_malformed_existing_decline_files_replaced_and_read_like_v9():
    bodies = ["{nope", "[]", "null", "1", '"s"', json.dumps({"schema": "x", "target_identity": ID}), json.dumps({"schema": C.DECLINE_SCHEMA, "target_identity": ID2}), "", "��", "[" * 3000]
    rec = {"target_identity": ID, "projection": "workspace", "risk_level": "high", "declined_at": "t"}
    for body in bodies:
        with tempfile.TemporaryDirectory() as dj, tempfile.TemporaryDirectory() as dp:
            for d in (dj, dp):
                p = Path(C.decline_path_for(d, ID))
                p.parent.mkdir(parents=True)
                p.write_text(body)
            assert C.read_decline(dp, ID) == v9(MOD, "readDecline", dj, ID), body
            want = v9(MOD, "recordDecline", dj, rec)
            got = C.record_decline(dp, rec)
            assert got["created"] == want["created"], body
            assert _files(dj) == _files(dp), body


def test_symlinked_or_non_directory_declines_path_refused_like_v9():
    for kind in ("symlink", "file"):
        results = []
        for impl in ("v9", "py"):
            with tempfile.TemporaryDirectory() as d:
                (Path(d) / "odd-plugin").mkdir()
                (Path(d) / "elsewhere").mkdir()
                tgt = Path(d) / "odd-plugin" / "declines"
                tgt.symlink_to(Path(d) / "elsewhere") if kind == "symlink" else tgt.write_text("x")
                rec = {"target_identity": ID, "projection": "workspace", "risk_level": "high", "declined_at": "t"}
                if impl == "v9":
                    r = v9(MOD, "recordDecline", d, rec)
                    results.append(("err" if isinstance(r, dict) and "__error__" in r else "ok", sorted(os.listdir(Path(d) / "elsewhere"))))
                else:
                    try:
                        C.record_decline(d, rec)
                        results.append(("ok", sorted(os.listdir(Path(d) / "elsewhere"))))
                    except Exception:  # noqa: BLE001
                        results.append(("err", sorted(os.listdir(Path(d) / "elsewhere"))))
        assert results[0] == results[1], kind
        assert results[0][0] == "err"
