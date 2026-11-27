import re

from odd_claude.lib.quota import COOLDOWN_MS, classify_stop_failure, quota_advice, record_quota_failure, take_quota_advice
from odd_claude.lib.state import read_session_state, write_session_state


def test_classifies_the_claude_code_error_types():
    for error, want in [
        ("rate_limit", "rate_limit"), ("overloaded", "provider_unavailable"), ("server_error", "provider_unavailable"),
        ("billing_error", "quota"), ("authentication_failed", "auth"), ("invalid_request", "invalid_request"),
        ("max_output_tokens", "other"), ("model_not_found", "invalid_request"), ("account_on_hold", "auth"),
    ]:  # fmt: skip
        assert classify_stop_failure(error) == want


def test_an_unknown_type_falls_back_to_the_error_text():
    for details, want in [
        ("429 You exceeded your current quota", "quota"), ("HTTP 429: Too many requests", "rate_limit"),
        ("status 503 upstream", "provider_unavailable"), ("request timed out", "timeout"), ("ECONNRESET", "network"),
        ("prompt is too long", "context_length"), ("x" * 10_000, "other"), ("Provider (403): nope", "auth"),
        ("401: bad", "auth"), ("status code 408", "timeout"), ("HTTP 418", "invalid_request"),
    ]:  # fmt: skip
        assert classify_stop_failure("unknown", details) == want, details
    assert classify_stop_failure(None, None) == "other"
    assert classify_stop_failure("unknown", "") == "other"
    assert classify_stop_failure("constructor", "429: x") == "rate_limit"


def test_advice_cooldown_semantics_and_same_provider_wording():
    now = 1_000_000
    q = quota_advice("quota", now)
    assert q.cooldown_ms == COOLDOWN_MS["exhausted"] == 30 * 60_000
    assert q.until == now + 30 * 60_000
    assert "--fallback-model" in q.text and "/model" in q.text and "Anthropic" in q.text
    assert "for about 30 min." in q.text
    t = quota_advice("rate_limit", now)
    assert t.cooldown_ms == COOLDOWN_MS["transient"] == 120_000 and "about 2 min." in t.text
    assert quota_advice("auth", now).cooldown_ms == COOLDOWN_MS["exhausted"]
    for c in ["context_length", "invalid_request", "other"]:
        assert quota_advice(c, now) is None


def test_a_recorded_failure_is_advised_once_only_inside_its_cooldown_and_never_blocks(opts):
    assert take_quota_advice("s", opts) is None
    assert record_quota_failure("s", {"error": "context_length"}, opts, 1000) is None
    assert read_session_state("s", opts) == {}
    assert take_quota_advice("s", opts, 1000) is None
    rec = record_quota_failure("s", {"error": "rate_limit"}, opts, 1000)
    assert rec == ("rate_limit", 1000 + COOLDOWN_MS["transient"])
    text = take_quota_advice("s", opts, 2000)
    assert re.search("rate_limit", text)
    assert take_quota_advice("s", opts, 3000) is None, "advised only once"
    record_quota_failure("s", {"error": "rate_limit"}, opts, 1000)
    assert take_quota_advice("s", opts, 1000 + COOLDOWN_MS["transient"] + 1) is None, "expired cooldown is not advised"


def test_stored_failure_shape_and_other_session_keys_are_preserved(opts):
    write_session_state("s", {"keep": 1}, opts)
    record_quota_failure("s", {"error": "billing_error"}, opts, 5)
    s = read_session_state("s", opts)
    assert s["keep"] == 1
    assert list(s["quotaFailure"]) == ["category", "until", "advised", "text"]
    assert s["quotaFailure"]["advised"] is False and s["quotaFailure"]["until"] == 5 + 30 * 60_000
    take_quota_advice("s", opts, 6)
    assert read_session_state("s", opts)["quotaFailure"]["advised"] is True


def test_take_never_raises_and_ignores_tampered_state(opts):
    write_session_state("s", {"quotaFailure": {"advised": False, "until": "x", "text": "t"}}, opts)
    assert take_quota_advice("s", opts, 1) is None
    write_session_state("s2", {"quotaFailure": "junk"}, opts)
    assert take_quota_advice("s2", opts, 1) is None
    # another schema version makes update_session_state raise; take swallows it
    import os

    from odd_claude.lib.state import session_state_path

    write_session_state("s3", {}, opts)
    p = session_state_path("s3", opts)
    open(p, "w").write('{"version": 2, "sessionId": "s3", "data": {}}')
    assert take_quota_advice("s3", opts, 1) is None
    assert os.path.exists(p)
