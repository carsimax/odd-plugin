"""Port of v9 review/canonical.spec.ts (11 test() cases; the vector loop expands to 8)."""
import re

import pytest

from odd_claude.review.canonical import CanonicalError, canonical_bytes, canonical_json, domain_hash

# [domain, version, value, expected canonical text, expected hash] (hashes derived independently in v9's spec)
VECTORS = [
    ("review-state", 2, {}, "{}", "sha256:b7d5152c4127f29578aa4cecfa4cb6b2b8232db4ff5c41c434bb8ad354f18d74"),
    ("review-state", 2, {"b": 1, "a": 2}, '{"a":2,"b":1}', "sha256:308345c9fe8ffadd2b1f7c1ce9897ab6000f0d8f7b654ed012fa23090593d705"),
    ("lens-result", 1, {"k": "héllo ✓ 😀"}, '{"k":"héllo ✓ 😀"}', "sha256:a8ace900d1d303672ca376350376ffcf567302c18434d3fd5c19b588a400cd95"),
    ("paths", 1, [[1, [2, []]], {"z": [{"b": None, "a": True}]}], '[[1,[2,[]]],{"z":[{"a":true,"b":null}]}]', "sha256:8f5bda9c065adc632aba2b3fb3afaf15572017720b0d1a7ae760d16c05c972fa"),
    ("paths", 1, -0.0, "0", "sha256:4223c6ff2cd5e70a7b002a5478f4f5427eb7fb03eb0e3f3e23b3bf22fea8a7f0"),
    ("paths", 1, '\x00\n"\\', '"\\u0000\\n\\"\\\\"', "sha256:1271f60a00e80a25087b8ce9185a1de6ed729f361c2b6da26f0ea0a5b1e0b36a"),
    ("paths", 1, [1e21, 0.1, 1e-7], "[1e+21,0.1,1e-7]", "sha256:9a08f49845448054ee409ebbfa173136800eb07ec65cedbab030f1de3dde7eb5"),
    ("review-snapshot", 4, {"é": 3, "a": {"b": {"c": []}}, "_": 2, "B": 1}, '{"B":1,"_":2,"a":{"b":{"c":[]}},"é":3}', "sha256:e84338778d35cc51051ef57cf891abd7c59a86894dc39b2bac6ba8fbe65cb41b"),
]  # fmt: skip


@pytest.mark.parametrize("domain,version,value,text,hash_", VECTORS)
def test_vector(domain, version, value, text, hash_):
    assert canonical_json(value) == text
    assert domain_hash(domain, version, value) == hash_


def test_canonical_bytes_is_the_utf8_encoding_of_the_canonical_text():
    b = canonical_bytes({"k": "é😀"})
    assert list(b) == list('{"k":"é😀"}'.encode("utf-8"))
    assert len(b) == 14


def test_key_order_never_changes_the_hash_array_order_does():
    assert domain_hash("x", 1, {"a": 1, "b": {"d": 1, "c": 2}}) == domain_hash("x", 1, {"b": {"c": 2, "d": 1}, "a": 1})
    assert domain_hash("x", 1, [1, 2]) != domain_hash("x", 1, [2, 1])


def test_domain_and_version_separate_hashes():
    v = {"a": 1}
    assert domain_hash("x", 1, v) != domain_hash("y", 1, v)
    assert domain_hash("x", 1, v) != domain_hash("x", 2, v)


def test_output_is_sha256_64_lowercase_hex():
    assert re.fullmatch(r"sha256:[0-9a-f]{64}", domain_hash("x", 1, None))


def test_keys_sort_by_utf16_code_unit_not_code_point():
    # U+1F600 (surrogates D83D DE00) sorts BEFORE U+FF5E in UTF-16, after it by code point.
    assert canonical_json({"～": 1, "\U0001f600": 2}) == '{"😀":2,"～":1}'


def test_accepts_null_booleans_and_shared_non_cyclic_references():
    shared = {"n": 1}
    assert canonical_json({"a": shared, "b": shared, "c": None, "d": False}) == '{"a":{"n":1},"b":{"n":1},"c":null,"d":false}'


def test_rejects_non_finite_numbers_with_the_path():
    for n in (float("nan"), float("inf"), float("-inf")):
        with pytest.raises(CanonicalError, match=r"^Canonical JSON rejects non-finite number at value$"):
            canonical_json(n)
        with pytest.raises(CanonicalError, match=r"^Canonical JSON rejects non-finite number at \.n$"):
            canonical_json({"n": n})
    with pytest.raises(CanonicalError, match=r"at \.a\[1\]\.b$"):
        canonical_json({"a": [0, {"b": float("nan")}]})


def test_rejects_functions_and_non_plain_objects():
    import datetime

    for v in (lambda: 1, {1, 2}, b"x", object(), datetime.datetime(1970, 1, 1)):
        with pytest.raises(CanonicalError, match=r"^Canonical JSON rejects a non-plain object at value$"):
            canonical_json(v)
    with pytest.raises(CanonicalError, match=r"at \.f$"):
        canonical_json({"f": object()})


def test_rejects_cycles():
    o: dict = {}
    o["self"] = o
    with pytest.raises(CanonicalError, match=r"^Canonical JSON rejects a cycle at \.self$"):
        canonical_json(o)
    a: list = []
    a.append([a])
    with pytest.raises(CanonicalError, match=r"^Canonical JSON rejects a cycle at \[0\]\[0\]$"):
        canonical_json(a)


def test_rejects_invalid_domains_and_versions():
    for d in ["", "Review", "a b", "a/b", "a\0b", "-a", "a-", "a\n"]:
        with pytest.raises(CanonicalError, match=r"^Canonical hash domain is invalid$"):
            domain_hash(d, 1, {})
    for v in [0, -1, 1.5, float("nan"), float("inf"), True, 2**53]:
        with pytest.raises(CanonicalError, match=r"^Canonical hash version is invalid$"):
            domain_hash("x", v, {})
    assert domain_hash("x", 1.0, {}) == domain_hash("x", 1, {})
