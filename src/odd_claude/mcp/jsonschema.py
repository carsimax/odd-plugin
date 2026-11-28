"""Minimal JSON Schema validator for the review tools' inputs (port of v9 mcp/jsonschema.ts; no dependency). It supports exactly the
keywords the tool schemas in tools.py use: type (string, integer, number, boolean, object, array), enum, const, required, properties,
additionalProperties (false only), minLength, maxLength, pattern, minimum, maximum, items, minItems, maxItems, uniqueItems.
Anything else in a schema is a programming error caught by the schema test, not silently ignored at runtime.

Schemas and values are plain JSON dicts/lists (a parsed wire message): lengths are UTF-16 code units, `integer` accepts an integral
double (JS `Number.isInteger`), key order is `Object.keys` order."""
import math
import re
from typing import Any

from ..lib.js import js_keys, js_stringify, utf16_len

JsonSchema = dict

SUPPORTED_KEYWORDS: tuple[str, ...] = (
    "type", "description", "enum", "const", "required", "properties", "additionalProperties", "minLength", "maxLength", "pattern",
    "minimum", "maximum", "items", "minItems", "maxItems", "uniqueItems", "default",
)

MAX_ERRORS = 10


def kind_of(v: Any) -> str:
    """JS `v === null ? "null" : Array.isArray(v) ? "array" : typeof v`, for a parsed JSON value."""
    if v is None:
        return "null"
    if isinstance(v, list):
        return "array"
    if isinstance(v, bool):
        return "boolean"
    if isinstance(v, (int, float)):
        return "number"
    if isinstance(v, str):
        return "string"
    return "object"


def _is_number(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _strict_equal(a: Any, b: Any) -> bool:
    return kind_of(a) == kind_of(b) and a == b


_REGEX_CACHE: dict[str, "re.Pattern[str]"] = {}


def _regex(pattern: str) -> "re.Pattern[str]":
    """The JS regex source as a Python one: a final `$` matches only at the very end (Python's would also match before a final newline)."""
    c = _REGEX_CACHE.get(pattern)
    if c is None:
        c = _REGEX_CACHE[pattern] = re.compile(re.sub(r"(?<!\\)\$$", r"\\Z", pattern))
    return c


def validate_schema(schema: JsonSchema, value: Any, path: str = "$") -> list[str]:
    """Validation errors as `path: message` lines (at most 10); empty when the value is valid."""
    errors: list[str] = []

    def add(message: str) -> None:
        if len(errors) < MAX_ERRORS:
            errors.append(f"{path}: {message}")

    kind = kind_of(value)
    t = schema.get("type")
    if t is not None:
        if t == "integer":
            ok_type = _is_number(value) and math.isfinite(value) and float(value).is_integer()
        elif t == "number":
            ok_type = _is_number(value) and math.isfinite(value)
        else:
            ok_type = kind == t
        if not ok_type:
            add(f"expected {t}, got {kind}")
            return errors
    if "enum" in schema and not any(_strict_equal(value, e) for e in schema["enum"]):
        add("must be one of " + ", ".join(js_stringify(e) for e in schema["enum"]))
    if "const" in schema and not _strict_equal(value, schema["const"]):
        add(f"must be {js_stringify(schema['const'])}")
    if isinstance(value, str):
        n = utf16_len(value)
        if "minLength" in schema and n < schema["minLength"]:
            add(f"must have at least {schema['minLength']} characters")
        if "maxLength" in schema and n > schema["maxLength"]:
            add(f"must have at most {schema['maxLength']} characters")
        if "pattern" in schema and not _regex(schema["pattern"]).search(value):
            add(f"must match {schema['pattern']}")
    if _is_number(value):
        if "minimum" in schema and value < schema["minimum"]:
            add(f"must be at least {schema['minimum']}")
        if "maximum" in schema and value > schema["maximum"]:
            add(f"must be at most {schema['maximum']}")
    if isinstance(value, list):
        if "minItems" in schema and len(value) < schema["minItems"]:
            add(f"must have at least {schema['minItems']} items")
        if "maxItems" in schema and len(value) > schema["maxItems"]:
            add(f"must have at most {schema['maxItems']} items")
        if schema.get("uniqueItems") is True and len({js_stringify(v) for v in value}) != len(value):
            add("items must be unique")
        if "items" in schema:
            i = 0
            while i < len(value) and len(errors) < MAX_ERRORS:
                errors.extend(validate_schema(schema["items"], value[i], f"{path}[{i}]"))
                i += 1
    if kind == "object":
        for key in schema.get("required", ()):
            if key not in value:
                add(f"missing required property {key}")
        props = schema.get("properties", {})
        for key in js_keys(value):
            if len(errors) >= MAX_ERRORS:
                break
            sub = props.get(key)
            if sub is None:
                if schema.get("additionalProperties") is False:
                    add(f"unknown property {key}")
            else:
                errors.extend(validate_schema(sub, value[key], f"{path}.{key}"))
    return errors[:MAX_ERRORS]
