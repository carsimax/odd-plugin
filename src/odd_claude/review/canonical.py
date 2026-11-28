"""Canonical JSON and domain-separated hashing for the review engine (port of v9 review/canonical.ts).

ONE canonical form: object keys sorted by UTF-16 code unit, no whitespace, strings and numbers exactly as `JSON.stringify`
emits them (`js_stringify`; -0 is "0"), UTF-8 on the wire. Anything JSON cannot represent is rejected instead of silently
dropped. Python values: None, bool, int, float, str, list/tuple (arrays) and dict (objects); anything else is rejected.
Public API: `CanonicalError`, `canonical_json`, `canonical_bytes`, `domain_hash`.
"""
import hashlib
import math
import re

from ..lib.js import js_number_to_string, js_stringify


class CanonicalError(Exception):
    pass


def _describe(path: str) -> str:
    return "value" if path == "" else path


def _canonicalize(value: object, path: str, ancestors: set[int]) -> str:
    if value is None:
        return "null"
    if isinstance(value, (bool, str)):
        return js_stringify(value)
    if isinstance(value, (int, float)):
        if isinstance(value, float) and not math.isfinite(value):
            raise CanonicalError(f"Canonical JSON rejects non-finite number at {_describe(path)}")
        return js_stringify(value)
    if not isinstance(value, (list, tuple, dict)):
        raise CanonicalError(f"Canonical JSON rejects a non-plain object at {_describe(path)}")
    if id(value) in ancestors:
        raise CanonicalError(f"Canonical JSON rejects a cycle at {_describe(path)}")
    ancestors.add(id(value))
    try:
        if not isinstance(value, dict):
            return "[" + ",".join(_canonicalize(v, f"{path}[{i}]", ancestors) for i, v in enumerate(value)) + "]"
        keys = sorted((str(k) for k in value), key=lambda k: k.encode("utf-16-be", "surrogatepass"))
        return "{" + ",".join(f"{js_stringify(k)}:{_canonicalize(value[k], f'{path}.{k}', ancestors)}" for k in keys) + "}"
    finally:
        ancestors.discard(id(value))


def canonical_json(value: object) -> str:
    return _canonicalize(value, "", set())


def canonical_bytes(value: object) -> bytes:
    return canonical_json(value).encode("utf-8")


_DOMAIN_RE = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*")


def _js_string(x: object) -> str:
    """JS `String(x)` for a JSON value (the domain is coerced by `RegExp.test` and the template literal)."""
    if x is None:
        return "null"
    if isinstance(x, bool):
        return "true" if x else "false"
    if isinstance(x, (int, float)):
        return js_number_to_string(x)
    if isinstance(x, (list, tuple)):
        return ",".join("" if e is None else _js_string(e) for e in x)
    return x if isinstance(x, str) else "[object Object]"


def domain_hash(domain: str, version: int | float, value: object) -> str:
    """"sha256:" + hex(SHA-256("odd-claude.<domain>/v<version>\\0" + canonical_json(value))). A non-string domain is
    coerced to a string like JS does."""
    domain = _js_string(domain)
    if not _DOMAIN_RE.fullmatch(domain):
        raise CanonicalError("Canonical hash domain is invalid")
    ok = not isinstance(version, bool) and isinstance(version, (int, float)) and math.isfinite(version) and float(version).is_integer() and abs(version) < 2**53
    if not ok or version < 1:
        raise CanonicalError("Canonical hash version is invalid")
    text = f"odd-claude.{domain}/v{js_number_to_string(version)}\0{canonical_json(value)}"
    return "sha256:" + hashlib.sha256(text.encode("utf-8", "replace")).hexdigest()
