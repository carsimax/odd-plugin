"""Port of v9 review/consent.spec.ts (7 tests) plus extra cases (locale, envelope shape, decline edge cases)."""
import json
import os
import re
from pathlib import Path

import pytest

from odd_claude.lib.root import module_root
from odd_claude.review.canonical import domain_hash
from odd_claude.review.consent import (
    CONSENT_SCHEMA, DECLINE_SCHEMA, INVOCATION_PREFIX, REVIEW_CONTRACT, REVIEW_TOOL_NAMES, RangeError, build_consent_envelope, consent_binding,
    decline_path_for, declines_dir_for, off_path_command, plugin_root_dir, read_decline, record_decline, review_command, shell_quote,
)

ID = "sha256:" + "ab" * 32


def base(**kw):
    return {"cwd": "/r", "targetIdentity": ID, "projection": "workspace", "riskLevel": "high", "changedFiles": 1, "changedLines": 1, "riskEvidence": [], "targetArgs": ["--target", "current-changes"], **kw}


def test_envelope_has_exactly_two_ordered_choices_whose_invocations_differ_only_by_the_answer():
    e = build_consent_envelope({"cwd": "/my repo", "targetIdentity": ID, "projection": "staged", "riskLevel": "medium", "changedFiles": 2, "changedLines": 9, "riskEvidence": ["x"], "targetArgs": ["--target", "current-changes"]})
    assert len(e["choices"]) == 2
    a, b = e["choices"]
    assert a["invocation"].removesuffix(" --consent granted") == b["invocation"].removesuffix(" --consent declined")
    assert a["invocation"].endswith(" --consent granted") and b["invocation"].endswith(" --consent declined")
    assert "--cwd '/my repo' " in a["invocation"]
    assert e["agent"] == "claude-code"
    assert e["headline"].startswith("A review can check")


def test_shell_quote_leaves_safe_words_alone_and_escapes_quotes():
    assert shell_quote("main") == "main"
    assert shell_quote("a b") == "'a b'"
    assert shell_quote("it's") == "'it'\\''s'"


def test_decline_records_are_keyed_by_candidate_atomic_and_first_wins(tmp_path):
    assert read_decline(str(tmp_path), ID) is None
    rec = {"target_identity": ID, "projection": "workspace", "risk_level": "high", "declined_at": "2026-01-01T00:00:00Z"}
    first = record_decline(str(tmp_path), rec)
    assert first["created"] is True
    assert first["path"] == decline_path_for(str(tmp_path), ID)
    assert record_decline(str(tmp_path), {**rec, "declined_at": "2027-01-01T00:00:00Z"})["created"] is False
    assert read_decline(str(tmp_path), ID)["declined_at"] == "2026-01-01T00:00:00Z"
    assert read_decline(str(tmp_path), "sha256:" + "cd" * 32) is None
    assert os.listdir(tmp_path / "odd-plugin" / "declines") == ["ab" * 32 + ".json"]


def test_a_malformed_identity_is_rejected_and_a_symlinked_declines_dir_is_refused(tmp_path):
    with pytest.raises(RangeError, match="target identity must be sha256:<64 hex>"):
        decline_path_for(str(tmp_path), "../../etc/passwd")
    (tmp_path / "odd-plugin").mkdir()
    (tmp_path / "elsewhere").mkdir()
    (tmp_path / "odd-plugin" / "declines").symlink_to(tmp_path / "elsewhere")
    with pytest.raises(Exception, match="declines path is not a real directory"):
        record_decline(str(tmp_path), {"target_identity": ID, "projection": "workspace", "risk_level": "high", "declined_at": "2026-01-01T00:00:00Z"})
    assert not (tmp_path / "elsewhere" / ("ab" * 32 + ".json")).exists()


def test_invocations_name_the_final_review_tools_and_the_real_off_switch_no_placeholders():
    assert list(REVIEW_TOOL_NAMES) == [
        "review_assess", "review_inspect", "review_start", "review_status", "review_answer_consent", "review_capture", "review_capture_group",
        "review_acknowledge_approved", "review_complete", "review_run",
    ]
    assert INVOCATION_PREFIX == "review_answer_consent"
    assert review_command("start") == "review_start"
    assert review_command("complete") == "review_complete"
    assert review_command("acknowledge-approved") == "review_acknowledge_approved"
    e = build_consent_envelope(base())
    for c in e["choices"]:
        assert c["invocation"].startswith("review_answer_consent --contract "), c["invocation"]
    assert e["off_path"]["command"] == off_path_command()
    assert re.fullmatch(r"node .*[\\/]dist[\\/]cli[\\/]review-mode\.js disable", e["off_path"]["command"])
    assert e["off_path"]["command"] in e["off_path"]["note"]
    assert "<plugin>" not in json.dumps(e)
    assert "review.js" not in json.dumps(e)


def test_the_off_switch_honours_claude_plugin_root_and_quotes_it():
    assert off_path_command({"CLAUDE_PLUGIN_ROOT": "/opt/odd root"}) == "node '/opt/odd root/dist/cli/review-mode.js' disable"
    assert off_path_command({}).endswith("review-mode.js disable")
    assert plugin_root_dir({}) == module_root()


def test_invocations_projection_only_for_current_changes_binding_and_lenses_as_a_comma_list():
    cc = build_consent_envelope(base(lenses={"names": ["risk", "reliability"], "reason": "why"}))
    bd = build_consent_envelope(base(targetArgs=["--target", "base-diff", "--base-ref", "main", "--committed-only", "true"]))
    assert " --projection workspace " in cc["choices"][0]["invocation"]
    assert "--projection" not in bd["choices"][0]["invocation"]
    assert " --lenses risk,reliability --lenses-reason why " in cc["choices"][0]["invocation"]
    binding = consent_binding(ID, {"names": ["risk", "reliability"], "reason": "why"})
    assert re.fullmatch(r"sha256:[0-9a-f]{64}", binding)
    assert f" --consent-binding {binding} --consent granted" in cc["choices"][0]["invocation"]
    assert consent_binding(ID, {"names": ["review-risk", "review-reliability"], "reason": "why"}) == binding
    assert consent_binding(ID, {"names": ["risk"], "reason": "why"}) != binding
    assert consent_binding(ID, {"names": ["risk", "reliability"], "reason": "other"}) != binding
    assert consent_binding(ID) != binding
    assert consent_binding("sha256:" + "cd" * 32, {"names": ["risk", "reliability"], "reason": "why"}) != binding


def test_constants_and_envelope_shape():
    assert (REVIEW_CONTRACT, CONSENT_SCHEMA, DECLINE_SCHEMA) == ("odd-claude.review-integration/v2", "odd-claude.review-integration.consent/v3", "odd-claude.review-decline/v1")
    e = build_consent_envelope(base(riskEvidence=["a", "b"]))
    assert list(e) == ["schema", "contract", "operation", "action", "agent", "blocking", "target_identity", "projection", "risk_level", "changed_files", "changed_lines", "headline", "reason", "value", "risk_evidence", "choices", "off_path"]
    assert (e["schema"], e["operation"], e["action"], e["blocking"], e["risk_evidence"]) == (CONSENT_SCHEMA, "review.start", "consent_required", True, ["a", "b"])
    assert e["choices"][0]["answer"] == "granted" and e["choices"][1]["answer"] == "declined"
    assert consent_binding(ID) == domain_hash("consent-binding", 1, {"target_identity": ID, "lenses": None, "lenses_reason": None})


def test_locale_es_selects_the_spanish_text_and_is_replayed_quoted():
    for loc in ("es", "es-ES", "ES_mx", "es_"):
        e = build_consent_envelope(base(locale=loc))
        assert e["headline"].startswith("Una revisión"), loc
        assert f" --locale {shell_quote(loc)} --consent-binding " in e["choices"][0]["invocation"]
    for loc in ("en", "esp", "fr", "ES\n", ""):
        assert build_consent_envelope(base(locale=loc))["headline"].startswith("A review"), loc


def test_a_malformed_decline_file_reads_as_absent_and_the_first_valid_record_replaces_it(tmp_path):
    p = Path(decline_path_for(str(tmp_path), ID))
    p.parent.mkdir(parents=True)
    for body in ("{nope", json.dumps({"schema": "x", "target_identity": ID}), json.dumps({"schema": DECLINE_SCHEMA, "target_identity": "sha256:" + "cd" * 32}), "[]", "null"):
        p.write_text(body)
        assert read_decline(str(tmp_path), ID) is None, body
    rec = {"target_identity": ID, "projection": "staged", "risk_level": "medium", "declined_at": "t"}
    assert record_decline(str(tmp_path), rec) == {"path": str(p), "created": True}
    assert read_decline(str(tmp_path), ID) == {"schema": DECLINE_SCHEMA, **rec}
    assert p.read_text() == '{"declined_at":"t","projection":"staged","risk_level":"medium","schema":"odd-claude.review-decline/v1","target_identity":"%s"}\n' % ID
    assert oct(p.stat().st_mode & 0o777) == "0o600"
    assert declines_dir_for("/c") == "/c/odd-plugin/declines"
    assert [f for f in os.listdir(p.parent) if f.endswith(".tmp")] == []
