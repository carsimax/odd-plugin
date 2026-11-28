"""Port of v9 review/schema.spec.ts (15 test() cases; the fixture/mirror loops expand to more)."""
import os
from pathlib import Path

import pytest

from odd_claude.review.schema import SchemaError, ValidateOptions, validate, validate_file
from review.conftest import INTEGRATION_ROOT, MIRROR_ROOT, REPO_ROOT, clone, list_files, read_json

V2S = INTEGRATION_ROOT / "v2" / "schemas"
V2F = INTEGRATION_ROOT / "v2" / "fixtures"
PLUGIN_ROOT = REPO_ROOT / "plugins" / "odd-claude"


def _no_refs(_id):
    raise RuntimeError("no refs")


def mem(schema, value):
    return validate(schema, value, ValidateOptions(base="mem://root", load=_no_refs))


def ok(schema, value):
    assert mem(schema, value) == []


def bad(schema, value):
    assert mem(schema, value) != []


def test_type_enum_const_pattern_length():
    ok({"type": "string", "minLength": 2, "maxLength": 3, "pattern": "^a"}, "abc")
    bad({"type": "string"}, 1)
    bad({"type": "string", "minLength": 2}, "a")
    bad({"type": "string", "maxLength": 1}, "ab")
    bad({"type": "string", "pattern": "^a"}, "ba")
    ok({"enum": ["x", 1, None]}, None)
    bad({"enum": ["x"]}, "y")
    ok({"const": {"a": [1]}}, {"a": [1]})
    bad({"const": {"a": [1]}}, {"a": [2]})


def test_integer_number_boolean_null_array_object_types():
    ok({"type": "integer", "minimum": 0, "maximum": 3}, 3)
    bad({"type": "integer"}, 1.5)
    bad({"type": "integer", "maximum": 3}, 4)
    bad({"type": "integer", "minimum": 0}, -1)
    ok({"type": "number"}, 1.5)
    bad({"type": "number"}, "1")
    ok({"type": "boolean"}, False)
    bad({"type": "integer"}, True)
    bad({"type": "number"}, True)
    ok({"type": "null"}, None)
    bad({"type": "object"}, [])
    bad({"type": "array"}, {})
    ok({"type": ["string", "null"]}, None)
    ok({"type": "integer"}, 2.0)  # JS has one number type: 2.0 is an integer


def test_object_keywords():
    s = {"type": "object", "required": ["a"], "properties": {"a": {"type": "string"}}, "additionalProperties": False}
    ok(s, {"a": "x"})
    bad(s, {})
    bad(s, {"a": 1})
    bad(s, {"a": "x", "b": 1})
    bad({"additionalProperties": {"type": "integer"}}, {"z": "s"})
    dep = {"dependentRequired": {"a": ["b"]}}
    ok(dep, {"b": 1})
    ok(dep, {"a": 1, "b": 1})
    bad(dep, {"a": 1})


def test_array_keywords():
    ok({"type": "array", "minItems": 1, "maxItems": 2, "items": {"type": "integer"}}, [1])
    bad({"minItems": 1}, [])
    bad({"maxItems": 1}, [1, 2])
    bad({"items": {"type": "integer"}}, [1, "a"])
    bad({"uniqueItems": True}, [{"a": 1, "b": 2}, {"b": 2, "a": 1}])
    ok({"uniqueItems": True}, [1, "1", [1]])
    tuple_ = {"prefixItems": [{"const": 1}, {"const": 2}], "items": False}
    ok(tuple_, [1, 2])
    ok(tuple_, [1])
    bad(tuple_, [1, 2, 3])
    bad(tuple_, [2, 1])
    ok({"prefixItems": [{"const": 1}], "items": {"type": "string"}}, [1, "a"])
    bad({"prefixItems": [{"const": 1}], "items": {"type": "string"}}, [1, 2])
    contains = {"contains": {"const": 1}, "minContains": 2, "maxContains": 3}
    ok(contains, [1, 1])
    bad(contains, [1])
    bad(contains, [1, 1, 1, 1])
    bad({"contains": {"const": 1}}, [2])


def test_combinators_and_conditionals():
    ok({"allOf": [{"type": "integer"}, {"minimum": 2}]}, 2)
    bad({"allOf": [{"type": "integer"}, {"minimum": 2}]}, 1)
    ok({"anyOf": [{"type": "string"}, {"type": "integer"}]}, 1)
    bad({"anyOf": [{"type": "string"}, {"type": "integer"}]}, None)
    ok({"oneOf": [{"type": "string"}, {"type": "integer"}]}, 1)
    bad({"oneOf": [{"type": "integer"}, {"minimum": 0}]}, 1)  # matches both
    bad({"oneOf": [{"type": "string"}]}, 1)
    ok({"not": {"type": "string"}}, 1)
    bad({"not": {"type": "string"}}, "a")
    cond = {"if": {"properties": {"k": {"const": 1}}, "required": ["k"]}, "then": {"required": ["t"]}, "else": {"required": ["e"]}}
    ok(cond, {"k": 1, "t": 1})
    bad(cond, {"k": 1})
    ok(cond, {"k": 2, "e": 1})
    bad(cond, {"k": 2})
    ok({"if": {"type": "string"}}, 1)
    ok(True, 1)
    bad(False, 1)


def test_ref_local_pointer_defs_sibling_keywords_and_unresolved_target():
    s = {"$defs": {"n": {"type": "integer"}}, "properties": {"a": {"$ref": "#/$defs/n", "minimum": 2}}}
    ok(s, {"a": 2})
    bad(s, {"a": "x"})
    bad(s, {"a": 1})
    with pytest.raises(SchemaError, match=r'^Unresolvable \$ref pointer "#/\$defs/missing"$'):
        mem({"$ref": "#/$defs/missing"}, 1)
    with pytest.raises(SchemaError, match=r'^Unsupported \$ref fragment "#foo"$'):
        mem({"$ref": "#foo"}, 1)


def test_ref_to_another_file_resolves_next_to_the_base_and_loads_once(tmp_path: Path):
    loads: list[str] = []
    root = {"properties": {"a": {"$ref": "other.json#/$defs/s"}, "b": {"$ref": "other.json#/$defs/s"}}}
    other = {"$defs": {"s": {"type": "string"}}}

    def load(i):
        loads.append(i)
        return other

    base = str(tmp_path / "root.json")
    assert validate(root, {"a": "x", "b": "y"}, ValidateOptions(base=base, load=load)) == []
    assert validate(root, {"a": 1}, ValidateOptions(base=base, load=load)) == ["/a: expected type string, got integer"]
    assert loads == [str(tmp_path / "other.json")] * 2  # one load per validate() call


def test_unsupported_keywords_fail_loudly_instead_of_passing_silently():
    with pytest.raises(SchemaError, match=r'^Unsupported schema keyword "patternProperties"$'):
        mem({"patternProperties": {}}, {})
    with pytest.raises(SchemaError, match=r'^Unsupported schema keyword "format"$'):
        mem({"format": "uri"}, "x")
    with pytest.raises(SchemaError, match=r"^Invalid schema at /$"):
        mem(5, 1)


def test_errors_carry_the_instance_path_and_exact_messages():
    errs = mem({"properties": {"a": {"items": {"type": "integer"}}}}, {"a": [1, "x"]})
    assert errs == ["/a/1: expected type integer, got string"]
    assert mem({"required": ["a"]}, {}) == [': missing required property "a"']
    assert mem({"type": ["string", "null"]}, 1) == [": expected type string|null, got integer"]
    assert mem({"enum": [1]}, 2) == [": not one of the allowed values"]
    assert mem({"minimum": 2, "maximum": 1}, 1.5) == [": below minimum 2", ": above maximum 1"]


def test_pattern_follows_js_regexp_semantics():
    ok({"pattern": "^[0-9]+$"}, "123")
    bad({"pattern": "^[0-9]+$"}, "123\n")  # JS `$` does not match before a trailing newline
    bad({"pattern": r"^\d+$"}, "١٢٣")  # \d is ASCII
    ok({"pattern": r"^\s*x\s*$"}, " x﻿")  # \s is the JS whitespace set
    bad({"pattern": r"^\s*x$"}, "\x1cx")
    bad({"pattern": r"^.$"}, "\n")
    ok({"pattern": "^(?<k>a)\\k<k>$"}, "aa")
    ok({"pattern": "^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$)).+$"}, "a/b")
    bad({"pattern": "^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$)).+$"}, "a/../b")


# ---- vendored contract assets ----

PAIRS = ["consent-v3", "start-v4", "status-v5", "capture-result-dry-run"]


@pytest.mark.parametrize("name", PAIRS)
def test_fixture_validates_against_its_schema(name):
    assert validate_file(str(V2S / f"{name}.schema.json"), read_json(V2F / f"{name}.fixture.json")) == []


def test_every_vendored_v2_fixture_has_a_vendored_schema_and_validates():
    files = list_files(V2F, ".fixture.json")
    assert files
    for f in files:
        name = f.name[: -len(".fixture.json")]
        assert (V2S / f"{name}.schema.json").exists(), name
        assert validate_file(str(V2S / f"{name}.schema.json"), read_json(f)) == [], name


SHA = "sha256:" + "a" * 64


def test_transition_binding_schema_valid_and_invalid_bindings():
    f = str(V2S / "transition-binding.schema.json")
    assert validate_file(f, {"target_identity": SHA}) == []
    assert validate_file(f, {"lineage_id": "my-lineage-1", "revision": SHA, "target_identity": SHA, "repository_context": "rctx1_" + "0" * 64}) == []
    assert validate_file(f, {}) != []
    assert validate_file(f, {"target_identity": "sha256:xyz"}) != []
    assert validate_file(f, {"target_identity": SHA, "extra": 1}) != []
    assert validate_file(f, {"target_identity": SHA, "lineage_id": "Bad_Lineage"}) != []
    assert validate_file(f, {"target_identity": SHA, "repository_context": "rctx1_short"}) != []


def _drop(key):
    return lambda v: v.pop(key)


def _set(key, val):
    return lambda v: v.__setitem__(key, val)


MUTATIONS = [
    ("consent-v3", _drop("choices")),
    ("consent-v3", lambda v: v.__setitem__("choices", [v["choices"][1], v["choices"][0]])),
    ("consent-v3", _set("risk_level", "low")),
    ("consent-v3", _set("target_identity", "sha256:ABC")),
    ("consent-v3", _set("extra", True)),
    ("start-v4", _drop("lineage_id")),
    ("start-v4", _set("state", "bogus")),
    ("start-v4", _set("selected_lenses", ["review-risk", "review-risk"])),
    ("start-v4", _set("correction_budget", 201)),
    ("start-v4", _set("base_tree", "zz")),
    ("status-v5", _drop("candidates")),
    ("status-v5", _set("target_identity", "nope")),
    ("status-v5", _set("contract", "other/v1")),
    ("status-v5", _set("surprise", 1)),
    ("capture-result-dry-run", _set("validation", "rejected")),
    ("capture-result-dry-run", _set("selected_order", 4)),
    ("capture-result-dry-run", _set("lens", "review-other")),
    ("capture-result-dry-run", _drop("subject_hash")),
]


@pytest.mark.parametrize("schema,mutate", MUTATIONS, ids=[f"{i}-{s}" for i, (s, _) in enumerate(MUTATIONS)])
def test_mutated_fixtures_fail(schema, mutate):
    value = clone(read_json(V2F / f"{schema}.fixture.json"))
    assert validate_file(str(V2S / f"{schema}.schema.json"), value) == []
    mutate(value)
    assert validate_file(str(V2S / f"{schema}.schema.json"), value) != []


@pytest.mark.parametrize("name", ["lens", "refuter", "targeted-validator"])
def test_provider_mirror_vector_validates_against_its_schema(name):
    s = str(MIRROR_ROOT / "schemas" / f"{name}.schema.json")
    v = read_json(MIRROR_ROOT / "vectors" / f"{name}.json")
    assert validate_file(s, v) == []
    bad_ = clone(v)
    bad_["unexpected"] = 1
    assert validate_file(s, bad_) != []
    no_hash = clone(v)
    del no_hash[next(iter(no_hash))]
    assert validate_file(s, no_hash) != []


def test_lens_vector_bad_subject_hash_and_unavailable_without_reason_fail():
    s = str(MIRROR_ROOT / "schemas" / "lens.schema.json")
    v = clone(read_json(MIRROR_ROOT / "vectors" / "lens.json"))
    v["subject_hash"] = "sha256:123"
    assert validate_file(s, v) != []
    u = clone(read_json(MIRROR_ROOT / "vectors" / "lens.json"))
    u["inspection"] = {"status": "unavailable", "paths": []}
    assert validate_file(s, u) != []
    u["inspection"]["reason"] = "could not read"
    assert validate_file(s, u) == []


def test_vendored_fixtures_live_outside_the_plugin_directory_and_never_reach_dist():
    assert not (PLUGIN_ROOT / "test-fixtures").exists()
    assert (REPO_ROOT / "test-fixtures" / "review" / "SOURCES.md").exists()
    dist = PLUGIN_ROOT / "dist"
    assert not (dist / "test-fixtures").exists()
    if dist.is_dir():
        leaked = [str(p) for p in dist.rglob("*") if p.is_file() and (p.name.endswith((".fixture.json", ".schema.json")) or p.name == "SOURCES.md")]
        assert leaked == []
