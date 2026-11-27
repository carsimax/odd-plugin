"""Differential test: Python lib/quota.py against the compiled v9 lib/quota.js on the same inputs and the same state."""
import json
import tempfile
from pathlib import Path

from odd_claude.lib import quota as q
from odd_claude.lib.state import StateOptions

from .v9_oracle import needs_v9, v9, v9_many

pytestmark = needs_v9

ERRORS = [
    None, *q._KNOWN_TYPES, "", "RATE_LIMIT", "rate_limit ", "unknown", "__proto__", "constructor", "toString", "hasOwnProperty", "\U0001f600", "\ud800", " ",
]
KEYWORDS = [
    "context length", "context_window", "maximum context", "prompt is too long", "too many tokens", "quota", "billing", "out of budget", "usage limit",
    "credit balance", "unauthorized", "unauthorised", "forbidden", "authenticat", "api key", "api-key", "permission denied", "rate limit", "too many requests",
    "timeout", "time out", "timed out", "deadline exceeded", "network", "connection", "websocket", "ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "ENOTFOUND",
    "EAI_AGAIN", "fetch failed", "socket hang up", "other side closed", "overloaded", "unavailable", "server error", "internal_error", "server_busy", "capacity",
    "high demand", "invalid request", "bad request",
]
# Unicode folding and JS `.`/`\s`/`\d`/`\b`/`$` quirks that a Python port can get wrong.
QUIRKS = [
    "ſervice unavailable", "overloaded", "AK", "apiKey", "api key", "API KEY", "Quota", "QUOTA", "rate\rlimit", "rate\nlimit", "rate limit", "rate limit",
    "rate\u0085limit", "context\rlength", "context window", "server\rerror", "time\nout", "ECONNKRESET", "İnvalid request", "invalidırequest",
    "429", "429\n", "429 \n", "\n429", "\n429: x", "x\n429", "429: rate", "(429)", "(429", "Provider (403): x", "status 503", "status code 503", "status: 503", "status:503",
    "HTTP 502", "http502", "http 502x", "HTTP 502", "HTTP 502", "HTTP﻿502", "﻿429", " 429", " \t429", "\x1c429", "\u0085429", " 429",
    "status 503", "status​503", "٤٢٩", "(٤٢٩)", "status ４２９", "status 429٤", "status 4290", "status 42", "status 400",
    "status 401", "status 403", "status 408", "status 429", "status 499", "status 500", "status 504", "status 599", "status 600", "status 404 not found", "status 5xx",
    "xstatus 503", "_status 503", "éstatus 503", "éhttp 503", "\U0001f600status 503", "é429", "a429", "(429)\n", "503{", "(503{", "status 503{", "status 503,", "status 503:",
    "status 503)", "status 503 ", "status 503 ", "status 503﻿", "status 503\x1c", "status 503\u0085", "status 503​", "status 503e", "status 503é",
    "status 503\n", "status 503\r\n", "x (503) y", "x(503)y", "x (503)y", "STATUS 503", "Status Code 503", "StAtUs 503", "http:503", "http : 503", "http :503",
    "", " ", "nothing here", "\U0001f600", "\ud800", "quota\ud800", "x" * 5000 + "quota",
]
ASTRAL_CAP = [
    "\U0001f600" * 2048 + "quota", "\U0001f600" * 2047 + "quota", "\U0001f600" * 2046 + "quota", "a" * 4091 + "quota", "a" * 4092 + "quota", "a" * 4090 + "quota",
    "a" * 4095 + "429", "a" * 4096 + "quota", "a" * 4095 + "q", "\U0001f600" * 2047 + "x429", "\U0001f600" * 2047 + "status 429",
    "a" * 4090 + "status 503", "a" * 4086 + "status 503", "a" * 4084 + "status 503", "a" * 4087 + "status 503", "\U0001f600" * 2040 + "status 503",
    "\U0001f600" * 2044 + "quota", "\U0001f600" * 2043 + "rate limit", "a" * 4096, "\U0001f600" * 5000, "é" * 5000 + "quota", " " * 4090 + "quota",
]
DETAILS = [*KEYWORDS, *QUIRKS, *ASTRAL_CAP, *[f"x {k} y" for k in KEYWORDS], *[k.upper() for k in KEYWORDS], *[f"{k}\n" for k in KEYWORDS]]


def snap(d: str) -> dict:
    return {str(f.relative_to(d)): f.read_bytes() for f in sorted(Path(d).rglob("*")) if f.is_file()}


def test_classify_stop_failure_sweep():
    # JSON null is not undefined: an absent `error`/`details` is not sent; a missing `error` is a call that starts with null only
    # for the details-only sweep, where v9 treats null like undefined (not a known type).
    calls = [[None, d] for d in DETAILS] + [[e] for e in ERRORS if e is not None] + [[e, d] for e in ERRORS if e is not None for d in ("", "quota", "status 503")]
    got = v9_many("quota", "classifyStopFailure", calls)
    for c, g in zip(calls, got):
        assert g == q.classify_stop_failure(*c), c


def test_quota_advice_categories_and_now():
    cats = [*set(q._KNOWN_TYPES.values()), "quota", "auth", "rate_limit", "provider_unavailable", "timeout", "network", "context_length", "other",
            "invalid_request", "", "QUOTA", "\U0001f600", "\ud800", "constructor", "__proto__", "x" * 1000]
    nows = [0, 1, 1_700_000_000_000, 2**53 - 1 - 30 * 60_000]
    calls = [[c, n] for c in cats for n in nows]
    got = v9_many("quota", "quotaAdvice", calls)
    for (c, n), g in zip(calls, got):
        a = q.quota_advice(c, n)
        want = None if a is None else {"category": a.category, "cooldownMs": a.cooldown_ms, "until": a.until, "text": a.text}
        assert g == want, (c, n)


def test_record_quota_failure_results_and_files():
    # lone-surrogate session ids are excluded: state.py's json.dumps(ensure_ascii=False) cannot encode them (v9 writes \\ud800); reported, not editable here.
    sids = ["s1", "", "\U0001f600", "a/b", "..", "x" * 300, " ", "a b", "﻿", " "]
    inputs = [{}, {"error": "billing_error"}, {"error": "rate_limit", "details": "x"}, {"details": "status 503"}, {"details": "nothing"}, {"error": "invalid_request"},
              {"details": "quota \U0001f600 \ud800"}, {"error": "max_output_tokens", "details": "quota"}, {"details": "a" * 4090 + "quota"}]
    for sid in sids:
        for inp in inputs:
            with tempfile.TemporaryDirectory() as dj, tempfile.TemporaryDirectory() as dp:
                rj = v9("quota", "recordQuotaFailure", sid, inp, {"dataDir": dj}, 1_700_000_000_000)
                try:
                    r = q.record_quota_failure(sid, inp, StateOptions(data_dir=dp), 1_700_000_000_000)
                    rp = None if r is None else {"category": r[0], "until": r[1]}
                except Exception as ex:  # noqa: BLE001
                    rp = {"__error__": str(ex)}
                assert rj == rp, (sid, inp)
                assert snap(dj) == snap(dp), (sid, inp)


def test_record_over_existing_state_keeps_other_keys():
    base = json.dumps({"version": 1, "sessionId": "s1", "data": {"keep": [1, 2], "quotaFailure": {"old": 1}}})
    with tempfile.TemporaryDirectory() as dj, tempfile.TemporaryDirectory() as dp:
        for d in (dj, dp):
            Path(d, "sessions").mkdir()
            Path(d, "sessions", "s1.json").write_text(base)
        rj = v9("quota", "recordQuotaFailure", "s1", {"error": "billing_error"}, {"dataDir": dj}, 5)
        r = q.record_quota_failure("s1", {"error": "billing_error"}, StateOptions(data_dir=dp), 5)
        assert rj == {"category": r[0], "until": r[1]} and snap(dj) == snap(dp)


def _failure(**kw):
    f = {"category": "quota", "until": 1000, "advised": False, "text": "T\U0001f600"}
    f.update(kw)
    return f


TAKE_STATES = [
    None,
    _failure(), _failure(advised=True), _failure(advised="false"), _failure(advised=None), _failure(until=999), _failure(until=1000), _failure(until=1001),
    _failure(until=1000.5), _failure(until="2000"), _failure(until=None), _failure(until=True), _failure(until=-1), _failure(text=5), _failure(text=""), _failure(text=None),
    "str", 5, [], [1], {}, {"extra": 1},
]


def test_take_quota_advice_over_seeded_state():
    for qf in TAKE_STATES:
        for now in (0, 999, 1000, 1001, 10**12):
            data = {"keep": 1} if qf is None else {"keep": 1, "quotaFailure": qf}
            raw = json.dumps({"version": 1, "sessionId": "s1", "data": data})
            with tempfile.TemporaryDirectory() as dj, tempfile.TemporaryDirectory() as dp:
                for d in (dj, dp):
                    Path(d, "sessions").mkdir()
                    Path(d, "sessions", "s1.json").write_text(raw)
                rj = v9("quota", "takeQuotaAdvice", "s1", {"dataDir": dj}, now)
                assert rj == q.take_quota_advice("s1", StateOptions(data_dir=dp), now), (qf, now)
                assert snap(dj) == snap(dp), (qf, now)


def test_take_quota_advice_missing_corrupt_and_relative():
    for raw in (None, "", "{", "null", '{"version":2,"sessionId":"s1","data":{"quotaFailure":{"category":"quota","until":9,"advised":false,"text":"x"}}}'):
        with tempfile.TemporaryDirectory() as dj, tempfile.TemporaryDirectory() as dp:
            if raw is not None:
                for d in (dj, dp):
                    Path(d, "sessions").mkdir()
                    Path(d, "sessions", "s1.json").write_text(raw)
            assert v9("quota", "takeQuotaAdvice", "s1", {"dataDir": dj}, 0) == q.take_quota_advice("s1", StateOptions(data_dir=dp), 0), raw
            assert snap(dj) == snap(dp), raw
    assert v9("quota", "takeQuotaAdvice", "s1", {"dataDir": "rel"}, 0) == q.take_quota_advice("s1", StateOptions(data_dir="rel"), 0)


def test_take_twice_returns_advice_once():
    with tempfile.TemporaryDirectory() as dj, tempfile.TemporaryDirectory() as dp:
        v9("quota", "recordQuotaFailure", "s1", {"error": "billing_error"}, {"dataDir": dj}, 100)
        q.record_quota_failure("s1", {"error": "billing_error"}, StateOptions(data_dir=dp), 100)
        for _ in range(2):
            assert v9("quota", "takeQuotaAdvice", "s1", {"dataDir": dj}, 101) == q.take_quota_advice("s1", StateOptions(data_dir=dp), 101)
        assert snap(dj) == snap(dp)
