"""Differential: review/canonical against v9 dist/review/canonical.js through the oracle."""
import pytest

from lib.v9_oracle import needs_v9
from odd_claude.review.canonical import canonical_bytes, canonical_json, domain_hash
from review.conftest import diff_cases

pytestmark = needs_v9

VALUES = [
    None, True, False, 0, -0.0, 1, -1, 1.5, 0.1, 0.1 + 0.2, 1e21, 1e20, 1e-6, 1e-7, 123e-20, 5e-324, 2**53, 2**53 + 1, 12345678901234567890, 1.7976931348623157e308,
    "", "a", "é", "  ", "\x00\x1f\x7f", '"\\/', "\U0001f600", "\ud800", "a\udfffb", "\ud83d", "﻿", " ",
    [], [1, [2, [3, []]]], [None, True, "x", 1.0, {}], {}, {"a": 1}, {"b": 1, "a": 2}, {"é": 1, "z": 2, "a": 3, "Z": 4},
    {"\U0001f600": 1, "～": 2, "": 3, "\U00010000": 4}, {"10": 1, "9": 2, "a": 3, "01": 4}, {"": 1, "\x00": 2}, {"\ud800": 1, "a": 2},
    {"o": {"z": [{"b": None, "a": True}], "k": "\U0001f600\ud83d"}}, {"__proto__": 1, "constructor": 2, "toString": 3}, [[[[[[[[1]]]]]]]],
    {"a": [1e21, 0.1, 1e-7, -0.0, 2.0]},
]
DOMAINS = ["x", "review-state", "a-b-c", "a1", "", "Review", "a b", "a/b", "a\0b", "-a", "a-", "a--b", "é", "a\n", "\U0001f600", "9", "x" * 200]
VERSIONS = [1, 2, 10, 0, -1, 1.5, 2**53 - 1, 2**53, 1.0, None, "1", 1e21]


def test_canonical_json_matches_v9():
    diff_cases("review/canonical", "canonicalJson", canonical_json, [[v] for v in VALUES])


def test_canonical_bytes_matches_v9_uint8array_shape():
    # JSON.stringify(Uint8Array) is {"0": b0, "1": b1, ...}
    diff_cases("review/canonical", "canonicalBytes", lambda v: {str(i): b for i, b in enumerate(canonical_bytes(v))}, [[v] for v in VALUES if not isinstance(v, str) or "\ud800" not in v and "\udfff" not in v and "\ud83d" not in v])


def test_domain_hash_matches_v9_over_values():
    diff_cases("review/canonical", "domainHash", domain_hash, [["review-state", 2, v] for v in VALUES])


def test_domain_hash_matches_v9_over_domains_and_versions():
    calls = [[d, 1, {"a": 1}] for d in DOMAINS] + [["x", v, {"a": 1}] for v in VERSIONS]
    diff_cases("review/canonical", "domainHash", domain_hash, calls)


@pytest.mark.parametrize("domain", [5, 12, None, True, False, 1.5, ["a", "b"], [], [None], {}, {"a": 1}])
def test_domain_hash_coerces_a_non_string_domain_like_js_regexp_test(domain):
    diff_cases("review/canonical", "domainHash", domain_hash, [[domain, 1, {"a": 1}]])
