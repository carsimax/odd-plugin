"""Port of v9 conformance/contract.spec.ts (S2: the only conformance spec mapped to phase 3 in docs/contracts/test-mapping.md): canonical JSON
and the odd-claude domain hash are pinned by vectors derived INDEPENDENTLY (python json.dumps with sorted keys, hashlib) over the vendored
provider-mirror vectors and integration fixtures, and they round-trip, here against the Python modules. (The black-box envelope conformance of
the same file lives in contract/contract.spec.ts, run with ODD_IMPL=py.)"""
import hashlib
import json

import pytest
from odd_claude.review.canonical import canonical_json, domain_hash

from review.conftest import VENDOR_ROOT

# [file under test-fixtures/review/vendor, canonical byte length, sha256 of "odd-claude.conformance-vector/v1\0" + canonical text]
# Derived with `python3`: json.dumps(doc, sort_keys=True, separators=(",", ":"), ensure_ascii=False) and hashlib.sha256.
VECTORS = [
    ("provider-mirror/v1.6.0/vectors/lens.json", 225, "sha256:2ec9ae165cd948ff65dc8b252612c867c776a3ccd14f0e35065aff68e8d04087"),
    ("provider-mirror/v1.6.0/vectors/refuter.json", 111, "sha256:6ce8a6bde20aec6282cc80140687167a8ace5809ffaea9ae68a26aaadb558548"),
    ("provider-mirror/v1.6.0/vectors/targeted-validator.json", 381, "sha256:9be671bb34918d5d499d04c1b3a5d8ca75463fff59ff03cc4fcaac3badb945b7"),
    ("review-integration/v2/fixtures/capture-result-dry-run.fixture.json", 314, "sha256:367cf9d28dc442957588481f8629ea6f982b02365724592098e2966fc5a95f7b"),
    ("review-integration/v2/fixtures/consent-v3.fixture.json", 1987, "sha256:d7ee7ef9162a0d5c25b9ecda2dbd6c509af31af5f2e673ab49422f24d5c2f797"),
    ("review-integration/v2/fixtures/start-v4.fixture.json", 5001, "sha256:612ae098aa74a572c021d363dc98ef121a83c0118e0c5030efcce2441749b06e"),
    ("review-integration/v2/fixtures/status-v5.fixture.json", 1965, "sha256:e60d01b8d26d8a438409b41ab8b8ee601d91b26be39ac12cde5e322a68249597"),
]


def canon(v) -> str:
    """An independent canonicalizer: sorted keys (UTF-16 code unit order), no whitespace, JSON for scalars."""
    if isinstance(v, list):
        return "[" + ",".join(canon(x) for x in v) + "]"
    if isinstance(v, dict):
        return "{" + ",".join(f"{json.dumps(k, ensure_ascii=False)}:{canon(v[k])}" for k in sorted(v, key=lambda k: k.encode("utf-16-be", "surrogatepass"))) + "}"
    return json.dumps(v, ensure_ascii=False)


def sha(domain_text: str, text: str) -> str:
    return "sha256:" + hashlib.sha256(f"{domain_text}\0{text}".encode("utf-8")).hexdigest()


def reversed_doc(v):
    if isinstance(v, list):
        return [reversed_doc(x) for x in v]
    if isinstance(v, dict):
        return {k: reversed_doc(x) for k, x in reversed(list(v.items()))}
    return v


@pytest.mark.parametrize("file,length,hash_", VECTORS, ids=[v[0] for v in VECTORS])
def test_vector_canonical_text_domain_hash_and_round_trip(file, length, hash_):
    doc = json.loads((VENDOR_ROOT / file).read_text(encoding="utf-8"))
    text = canonical_json(doc)
    assert text == canon(doc), "the engine's canonical form is the independent one"
    assert len(text.encode("utf-8")) == length
    assert domain_hash("conformance-vector", 1, doc) == hash_, "pinned hash (derived with python)"
    assert domain_hash("conformance-vector", 1, doc) == sha("odd-claude.conformance-vector/v1", text)
    assert json.loads(text) == doc, "canonical text round-trips"
    assert canonical_json(json.loads(text)) == text, "canonicalization is idempotent"
    assert domain_hash("conformance-vector", 1, reversed_doc(doc)) == hash_, "key order never matters"
    assert domain_hash("conformance-vector", 2, doc) != hash_, "the version separates"
    assert domain_hash("conformance-other", 1, doc) != hash_, "the domain separates"
    # the upstream product's domain never collides with ours
    assert sha("-".join(["gentle", "ai"]) + ".conformance-vector/v1", text) != hash_


def test_canonical_text_is_utf16_ordered_and_escapes_like_json_on_the_hard_cases_independent_of_the_engine():
    doc = {"10": 1, "9": 2, "b": [{"é": 1, "z": 0, "Z": -0.0}], "a": '\u0000"\\é😀', "": None}
    assert canonical_json(doc) == '{"":null,"10":1,"9":2,"a":"\\u0000\\"\\\\é😀","b":[{"Z":0,"z":0,"é":1}]}'
    assert canonical_json(doc) == canon({**doc, "b": [{"é": 1, "z": 0, "Z": 0}]})
