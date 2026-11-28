"""Differential: review/schema against v9 dist/review/schema.js through the oracle (no `load`: ref-free schemas only,
plus `validateFile` over the vendored schemas and fixtures)."""
import pytest

from lib.v9_oracle import needs_v9, v9, v9_many
from odd_claude.review.schema import ValidateOptions, validate, validate_file
from review.conftest import INTEGRATION_ROOT, MIRROR_ROOT, clone, diff_cases, list_files, read_json

pytestmark = needs_v9

OPTS = {"base": "mem://root"}


def py_validate(schema, value, opts=OPTS):
    def load(_id):
        raise RuntimeError("no refs")

    return validate(schema, value, ValidateOptions(base=opts["base"], load=load))


# (schema, value) pairs: ordinary keyword use, edge values, Unicode, prototype-named keys, $ref pointers, errors.
CASES = [
    ({"type": "string", "minLength": 2, "maxLength": 3, "pattern": "^a"}, "abc"),
    ({"type": "string"}, 1), ({"type": "string", "minLength": 2}, "a"), ({"type": "string", "maxLength": 1}, "ab"),
    ({"type": "string", "pattern": "^a"}, "ba"), ({"minLength": 2}, "\U0001f600"), ({"minLength": 2}, "\U0001f600a"), ({"maxLength": 1}, "\U0001f600"),
    ({"minLength": 2}, "\ud800\ud800"), ({"minLength": 1.5}, "a"), ({"maxLength": 0}, ""),
    ({"enum": ["x", 1, None]}, None), ({"enum": ["x"]}, "y"), ({"enum": [1.0]}, 1), ({"enum": [{"a": 1, "b": 2}]}, {"b": 2, "a": 1}), ({"enum": []}, 1),
    ({"const": {"a": [1]}}, {"a": [1]}), ({"const": {"a": [1]}}, {"a": [2]}), ({"const": None}, None), ({"const": "\U0001f600"}, "\U0001f600"), ({"const": 0}, -0.0),
    ({"type": "integer", "minimum": 0, "maximum": 3}, 3), ({"type": "integer"}, 1.5), ({"type": "integer"}, 2.0), ({"type": "integer"}, 1e300), ({"type": "integer"}, 2**70),
    ({"type": "integer", "maximum": 3}, 4), ({"type": "integer", "minimum": 0}, -1), ({"type": "number"}, 1.5), ({"type": "number"}, "1"),
    ({"minimum": 1.5, "maximum": 1e21}, 1e22), ({"minimum": 1e-7}, 0), ({"minimum": "x"}, 0),
    ({"type": "boolean"}, False), ({"type": "integer"}, True), ({"type": "null"}, None), ({"type": "object"}, []), ({"type": "array"}, {}),
    ({"type": ["string", "null"]}, None), ({"type": ["string", "null"]}, 1), ({"type": ["a", 1, None, True]}, 1), ({"type": []}, 1), ({"type": None}, 1),
    ({"type": "object", "required": ["a"], "properties": {"a": {"type": "string"}}, "additionalProperties": False}, {"a": "x"}),
    ({"type": "object", "required": ["a"], "properties": {"a": {"type": "string"}}, "additionalProperties": False}, {}),
    ({"type": "object", "required": ["a"], "properties": {"a": {"type": "string"}}, "additionalProperties": False}, {"a": 1}),
    ({"type": "object", "required": ["a"], "properties": {"a": {"type": "string"}}, "additionalProperties": False}, {"a": "x", "b": 1}),
    ({"additionalProperties": {"type": "integer"}}, {"z": "s", "y": 1}), ({"additionalProperties": True}, {"z": 1}), ({"additionalProperties": False}, {"\U0001f600": 1, "10": 1, "9": 2}),
    ({"properties": {"10": {"type": "string"}, "9": {"type": "string"}, "a": {"type": "string"}}}, {"a": 1, "9": 1, "10": 1}),
    ({"required": ["toString"]}, {}), ({"required": ["constructor", "__proto__"]}, {}), ({"properties": {"toString": {"type": "string"}}}, {}),
    ({"properties": {"toString": {"type": "string"}}}, {"toString": 1}), ({"additionalProperties": False}, {"toString": 1, "x": 1}),
    ({"properties": {"hasOwnProperty": {"type": "string"}}, "additionalProperties": False}, {"valueOf": 1}), ({"dependentRequired": {"a": ["toString"]}}, {"a": 1}),
    ({"dependentRequired": {"a": ["b"]}}, {"b": 1}), ({"dependentRequired": {"a": ["b"]}}, {"a": 1, "b": 1}), ({"dependentRequired": {"a": ["b", "c"]}}, {"a": 1}),
    ({"required": ["a"]}, []), ({"properties": {"a": True, "b": False}}, {"a": 1, "b": 1}), ({"required": []}, {}),
    ({"type": "array", "minItems": 1, "maxItems": 2, "items": {"type": "integer"}}, [1]), ({"minItems": 1}, []), ({"maxItems": 1}, [1, 2]), ({"items": {"type": "integer"}}, [1, "a"]),
    ({"uniqueItems": True}, [{"a": 1, "b": 2}, {"b": 2, "a": 1}]), ({"uniqueItems": True}, [1, "1", [1]]), ({"uniqueItems": True}, [1, 1.0]), ({"uniqueItems": True}, ["\U0001f600", "\U0001f600"]),
    ({"uniqueItems": False}, [1, 1]),
    ({"prefixItems": [{"const": 1}, {"const": 2}], "items": False}, [1, 2]), ({"prefixItems": [{"const": 1}, {"const": 2}], "items": False}, [1]),
    ({"prefixItems": [{"const": 1}, {"const": 2}], "items": False}, [1, 2, 3]), ({"prefixItems": [{"const": 1}, {"const": 2}], "items": False}, [2, 1]),
    ({"prefixItems": [{"const": 1}], "items": {"type": "string"}}, [1, "a"]), ({"prefixItems": [{"const": 1}], "items": {"type": "string"}}, [1, 2]),
    ({"contains": {"const": 1}, "minContains": 2, "maxContains": 3}, [1, 1]), ({"contains": {"const": 1}, "minContains": 2, "maxContains": 3}, [1]),
    ({"contains": {"const": 1}, "minContains": 2, "maxContains": 3}, [1, 1, 1, 1]), ({"contains": {"const": 1}}, [2]), ({"contains": {"const": 1}, "minContains": 0}, [2]),
    ({"allOf": [{"type": "integer"}, {"minimum": 2}]}, 2), ({"allOf": [{"type": "integer"}, {"minimum": 2}]}, 1), ({"anyOf": [{"type": "string"}, {"type": "integer"}]}, 1),
    ({"anyOf": [{"type": "string"}, {"type": "integer"}]}, None), ({"oneOf": [{"type": "string"}, {"type": "integer"}]}, 1), ({"oneOf": [{"type": "integer"}, {"minimum": 0}]}, 1),
    ({"oneOf": [{"type": "string"}]}, 1), ({"not": {"type": "string"}}, 1), ({"not": {"type": "string"}}, "a"), ({"anyOf": []}, 1), ({"oneOf": []}, 1), ({"allOf": []}, 1),
    ({"if": {"properties": {"k": {"const": 1}}, "required": ["k"]}, "then": {"required": ["t"]}, "else": {"required": ["e"]}}, {"k": 1, "t": 1}),
    ({"if": {"properties": {"k": {"const": 1}}, "required": ["k"]}, "then": {"required": ["t"]}, "else": {"required": ["e"]}}, {"k": 1}),
    ({"if": {"properties": {"k": {"const": 1}}, "required": ["k"]}, "then": {"required": ["t"]}, "else": {"required": ["e"]}}, {"k": 2, "e": 1}),
    ({"if": {"properties": {"k": {"const": 1}}, "required": ["k"]}, "then": {"required": ["t"]}, "else": {"required": ["e"]}}, {"k": 2}),
    ({"if": {"type": "string"}}, 1), (True, 1), (False, 1), (False, {"a": [1]}), ({}, None), ({"$comment": "x", "title": "t", "default": 1}, 1),
    ({"properties": {"a": {"items": {"type": "integer"}}}}, {"a": [1, "x"]}), ({"properties": {"a": {"properties": {"b": {"type": "string"}}}}}, {"a": {"b": 1}}),
    ({"properties": {"\U0001f600/x": {"type": "string"}}}, {"\U0001f600/x": 1}),
    ({"$defs": {"n": {"type": "integer"}}, "properties": {"a": {"$ref": "#/$defs/n", "minimum": 2}}}, {"a": 2}),
    ({"$defs": {"n": {"type": "integer"}}, "properties": {"a": {"$ref": "#/$defs/n", "minimum": 2}}}, {"a": "x"}),
    ({"$defs": {"n": {"type": "integer"}}, "properties": {"a": {"$ref": "#/$defs/n", "minimum": 2}}}, {"a": 1}),
    ({"$ref": "#/$defs/missing"}, 1), ({"$ref": "#foo"}, 1), ({"$ref": "#"}, 1), ({"$ref": "#/"}, 1),
    ({"$defs": {"a/b": {"type": "integer"}, "a~b": {"type": "integer"}, "é": {"type": "integer"}, "a b": {"type": "integer"}}, "allOf": [{"$ref": "#/$defs/a~1b"}, {"$ref": "#/$defs/a~0b"}, {"$ref": "#/$defs/%C3%A9"}, {"$ref": "#/$defs/a%20b"}]}, 1),
    ({"$defs": {"a": {"type": "integer"}}, "$ref": "#/$defs/a%zz"}, 1), ({"$defs": {"a": {"type": "integer"}}, "$ref": "#/$defs/%E0%A4%A"}, 1),
    ({"$defs": {"a": {"type": "integer"}}, "$ref": "#/$defs/%FF"}, 1), ({"$defs": {"a": {"type": "integer"}}, "$ref": "#/$defs/%41"}, 1),
    ({"allOf": [{"$ref": "#/allOf/1"}, {"type": "integer"}]}, "x"), ({"allOf": [{"$ref": "#/allOf/ 1 "}, {"type": "integer"}]}, "x"), ({"allOf": [{"$ref": "#/allOf/"}, {"type": "integer"}]}, "x"),
    ({"allOf": [{"$ref": "#/allOf/1.5"}, {"type": "integer"}]}, "x"), ({"allOf": [{"$ref": "#/allOf/-1"}, {"type": "integer"}]}, "x"), ({"allOf": [{"$ref": "#/allOf/length"}, {"type": "integer"}]}, "x"),
    ({"allOf": [{"$ref": "#/allOf/0x1"}, {"type": "integer"}]}, "x"), ({"allOf": [{"$ref": "#/allOf/1e0"}, {"type": "integer"}]}, "x"), ({"allOf": [{"$ref": "#/allOf/5"}]}, 1),
    ({"$defs": {}, "$ref": "#/$defs/constructor"}, 1), ({"$defs": {"x": 5}, "$ref": "#/$defs/x"}, 1), ({"$defs": {"x": [1]}, "$ref": "#/$defs/x"}, 1),
    ({"$ref": "#/type/x"}, 1), ({"type": "string", "$ref": "#/type"}, 1),
    ({"patternProperties": {}}, {}), ({"format": "uri"}, "x"), ({"$ref": 5}, 1), ({"unevaluatedProperties": False}, {}), (5, 1), ("s", 1), ([], 1), (None, 1), ({"properties": {"a": 5}}, {"a": 1}),
    ({"pattern": "^[0-9]+$"}, "123"), ({"pattern": "^[0-9]+$"}, "123\n"), ({"pattern": "[0-9]+$"}, "a1\n"), ({"pattern": "^\\d+$"}, "١٢٣"), ({"pattern": "^\\d+$"}, "123"),
    ({"pattern": "^\\w+$"}, "é"), ({"pattern": "^\\w+$"}, "ab_9"), ({"pattern": "^\\s*x\\s*$"}, " x﻿"), ({"pattern": "^\\s*x$"}, "\x1cx"), ({"pattern": "^\\S$"}, " "),
    ({"pattern": "^.$"}, "\n"), ({"pattern": "^.$"}, " "), ({"pattern": "^.$"}, "\U0001f600"), ({"pattern": "^.$"}, "\x85"), ({"pattern": "^..$"}, "\U0001f600"),
    ({"pattern": "^(?<k>a)\\k<k>$"}, "aa"), ({"pattern": "^(?<=a)b"}, "b"), ({"pattern": "(?<!a)b"}, "b"), ({"pattern": "^(?:a|b)+$"}, "abba"), ({"pattern": "^[^a]$"}, "\n"),
    ({"pattern": "^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$)).+$"}, "a/b"), ({"pattern": "^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$)).+$"}, "a/../b"), ({"pattern": "^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$)).+$"}, "/a"),
    ({"pattern": "^[\\d]+$"}, "٣"), ({"pattern": "^[\\s]+$"}, " "), ({"pattern": "^[a-z]\\/$"}, "a/"), ({"pattern": "\\u{1F600}"}, "x\U0001f600"), ({"pattern": "^\\u0041$"}, "A"),
    ({"pattern": "é"}, "é"), ({"pattern": "^[é]$"}, "é"), ({"pattern": "[]"}, "a"), ({"pattern": "^[^]$"}, "\n"), ({"pattern": "^a$|^b$"}, "b"), ({"pattern": ""}, "x"),
    ({"pattern": "a{2,3}"}, "caab"), ({"pattern": "^a$"}, "a "), ({"pattern": "\\bfoo\\b"}, "é foo é"), ({"pattern": "^\\D$"}, "٣"),
]  # fmt: skip


def test_validate_matches_v9_over_ordinary_edge_and_unicode_inputs():
    diff_cases("review/schema", "validate", py_validate, [[s, v, OPTS] for s, v in CASES])


@pytest.mark.parametrize("pattern", ["(", "[", "a**", "(?<n>a)(?<n>b)", "*a"])
def test_an_invalid_pattern_raises_on_both_sides(pattern):
    r = v9("review/schema", "validate", {"pattern": pattern}, "a", OPTS)
    assert isinstance(r, dict) and "__error__" in r, "v9 should throw"
    with pytest.raises(Exception):  # message differs (V8 vs re); only the failure is shared
        py_validate({"pattern": pattern}, "a")


V2S = INTEGRATION_ROOT / "v2" / "schemas"
V2F = INTEGRATION_ROOT / "v2" / "fixtures"


def _vendored_cases() -> list[list]:
    calls: list[list] = []
    for f in list_files(V2F, ".fixture.json"):
        name = f.name[: -len(".fixture.json")]
        schema = str(V2S / f"{name}.schema.json")
        value = read_json(f)
        calls.append([schema, value])
        for k in list(value)[:6]:
            m = clone(value)
            del m[k]
            calls.append([schema, m])
            m = clone(value)
            m[k] = "sha256:ABC" if isinstance(m[k], str) else 5
            calls.append([schema, m])
        calls.append([schema, {**value, "extra": "\U0001f600"}])
    for name in ("lens", "refuter", "targeted-validator"):
        schema, v = str(MIRROR_ROOT / "schemas" / f"{name}.schema.json"), read_json(MIRROR_ROOT / "vectors" / f"{name}.json")
        calls += [[schema, v], [schema, {**v, "unexpected": 1}], [schema, {**v, "subject_hash": "sha256:123"}]]
    calls.append([str(V2S / "transition-binding.schema.json"), {"target_identity": "sha256:" + "a" * 64, "lineage_id": "Bad_Lineage"}])
    return calls


def test_validate_file_matches_v9_over_the_vendored_schemas_and_mutated_fixtures():
    calls = _vendored_cases()
    assert len(calls) > 50
    expected = v9_many("review/schema", "validateFile", calls)
    for args, want in zip(calls, expected):
        got = py_validate_file(*args)
        assert got == want, f"validateFile{tuple(args)[:1]!r}: python={got!r} v9={want!r}"


def py_validate_file(schema, value):
    try:
        return validate_file(schema, value)
    except FileNotFoundError:
        return {"__error__": "ENOENT"}


def test_a_missing_schema_file_fails_on_both_sides_with_enoent():
    r = v9("review/schema", "validateFile", str(V2S / "missing.schema.json"), {})
    assert "ENOENT" in r["__error__"]
    with pytest.raises(FileNotFoundError):
        validate_file(str(V2S / "missing.schema.json"), {})
