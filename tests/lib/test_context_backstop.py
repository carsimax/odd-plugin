import json

from odd_claude.lib.context_backstop import (
    CONTEXT_BACKSTOP_TOKENS,
    CONTEXT_BACKSTOP_TOKENS_ENV,
    check_context_backstop,
    context_backstop_notice,
    context_backstop_threshold,
)


def usage(n):
    return json.dumps({"message": {"usage": {"input_tokens": n}}}) + "\n"


def test_threshold_env():
    assert CONTEXT_BACKSTOP_TOKENS == 150_000
    assert context_backstop_threshold({}) == 150_000
    assert context_backstop_threshold({CONTEXT_BACKSTOP_TOKENS_ENV: " 1000 "}) == 1000
    for bad in ["", "abc", "0", "-5", "nan", "inf", "1_000"]:
        assert context_backstop_threshold({CONTEXT_BACKSTOP_TOKENS_ENV: bad}) == 150_000


def test_notice_text():
    n = context_backstop_notice(200_000, 150_000, True)
    assert n == (
        "Context backstop: the parent context measures 200,000 tokens, at or past the 150,000-token backstop "
        "(advisory, nothing is blocked): delegate the next bounded unit with a short handoff, and keep only state checks in this context."
    )
    assert "single small edits and state checks stay inline." in context_backstop_notice(1, 1, False)


def test_after_the_notice_fired_a_usage_line_beyond_the_short_tail_is_not_read(tmp_path, opts):
    t = str(tmp_path / "t.jsonl")
    (tmp_path / "t.jsonl").write_text(usage(200_000))
    assert check_context_backstop("sess-0001", t, False, {}, opts).startswith("Context backstop:")
    (tmp_path / "t.jsonl").write_text(usage(10) + json.dumps({"type": "user", "pad": "x" * 200 * 1024}) + "\n")
    assert check_context_backstop("sess-0001", t, False, {}, opts) is None
    # still armed: the low reading was out of reach, so a new crossing does not notify again
    (tmp_path / "t.jsonl").write_text(usage(200_000))
    assert check_context_backstop("sess-0001", t, False, {}, opts) is None


def test_after_the_notice_fired_a_measured_drop_in_the_tail_still_re_arms_it(tmp_path, opts):
    p = tmp_path / "t.jsonl"
    t = str(p)
    p.write_text(usage(200_000))
    assert check_context_backstop("sess-0002", t, False, {}, opts)
    p.write_text(usage(10))
    assert check_context_backstop("sess-0002", t, False, {}, opts) is None
    p.write_text(usage(200_000))
    assert check_context_backstop("sess-0002", t, False, {}, opts).startswith("Context backstop:")


def test_no_path_no_file_or_no_usage_gives_no_notice(tmp_path, opts):
    assert check_context_backstop("s", None, False, {}, opts) is None
    assert check_context_backstop("s", "", False, {}, opts) is None
    assert check_context_backstop("s", str(tmp_path / "nope"), False, {}, opts) is None
    p = tmp_path / "t.jsonl"
    p.write_text('{"message":{"usage":{"input_tokens":0}}}\nnot "usage" json\n')
    assert check_context_backstop("s", str(p), False, {}, opts) is None


def test_sums_cache_tokens_and_uses_the_env_threshold(tmp_path, opts):
    p = tmp_path / "t.jsonl"
    p.write_text(json.dumps({"message": {"usage": {"input_tokens": 1, "cache_creation_input_tokens": 2, "cache_read_input_tokens": 3}}}) + "\n")
    n = check_context_backstop("s", str(p), True, {CONTEXT_BACKSTOP_TOKENS_ENV: "6"}, opts)
    assert "measures 6 tokens, at or past the 6-token backstop" in n
