"""Tiny dependency-free JSON Schema (draft 2020-12 subset) validator (port of v9 review/schema.ts).

Supports only the keywords the vendored review contract schemas use. A schema that uses any other validation keyword
raises `SchemaError` instead of silently passing. Public API: `SchemaError`, `ValidateOptions`, `validate`, `validate_file`.
`pattern` strings are translated from JS RegExp to Python `re` (`_js_regex`): ASCII `\\d\\w\\b`, `$` = end of input,
`.` excludes the JS line terminators, `\\s` is the JS whitespace set. An invalid pattern raises (message differs from V8's).
"""
import dataclasses
import os
import re
import urllib.parse
from dataclasses import dataclass
from typing import Any, Callable

from ..lib.js import JS_WS, js_json_loads, js_keys, js_number, js_number_to_string, js_trim
from .canonical import canonical_json


class SchemaError(Exception):
    pass


@dataclass
class ValidateOptions:
    #: Identifier (file path) of the document that holds `schema`; relative $ref files resolve against it.
    base: str
    #: Loads another schema document by its resolved identifier.
    load: Callable[[str], Any]


_ANNOTATIONS = {"$schema", "$id", "$comment", "$defs", "title", "description", "examples", "default", "maxContains", "minContains"}
_KEYWORDS = {
    *_ANNOTATIONS, "$ref", "type", "enum", "const", "pattern", "minLength", "maxLength", "minimum", "maximum",
    "required", "properties", "additionalProperties", "dependentRequired", "items", "prefixItems", "minItems",
    "maxItems", "uniqueItems", "contains", "allOf", "anyOf", "oneOf", "not", "if", "then", "else",
}  # fmt: skip
# Names a JS object inherits from Object.prototype: `key in obj` is true for them, `obj[key]` is a function.
_PROTO = {
    "constructor", "__defineGetter__", "__defineSetter__", "hasOwnProperty", "__lookupGetter__", "__lookupSetter__",
    "isPrototypeOf", "propertyIsEnumerable", "toString", "valueOf", "__proto__", "toLocaleString",
}  # fmt: skip


class _Fn:
    """Stands for the inherited JS function a prototype key reads as: not a schema, not a typed value."""


_FN = _Fn()
_UNDEF = object()


@dataclass
class _Ctx:
    doc: Any
    base: str
    opts: ValidateOptions
    docs: dict[str, Any]
    regex: dict[str, "re.Pattern[str]"]


def _is_obj(v: object) -> bool:
    return isinstance(v, dict)


def _has(obj: dict, key: str) -> bool:
    return key in obj or key in _PROTO


def _get(obj: dict, key: str) -> Any:
    return obj[key] if key in obj else _FN


def _num(v: object) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _type_of(value: object) -> str:
    if value is None:
        return "null"
    if isinstance(value, list):
        return "array"
    if isinstance(value, bool):
        return "boolean"
    if _num(value):
        return "integer" if isinstance(value, int) or (value == value and abs(value) != float("inf") and value.is_integer()) else "number"
    if isinstance(value, str):
        return "string"
    if isinstance(value, _Fn):
        return "function"
    return "object"


def _matches_type(value: object, type_: object) -> bool:
    t = _type_of(value)
    return t == type_ or (type_ == "number" and t == "integer")


def _same(a: object, b: object) -> bool:
    return canonical_json(a) == canonical_json(b)


def _decode_uri_component(raw: str) -> str:
    if re.search(r"%(?![0-9a-fA-F]{2})", raw):
        raise ValueError("URI malformed")
    try:
        return urllib.parse.unquote(raw, errors="strict")
    except UnicodeDecodeError as e:
        raise ValueError("URI malformed") from e


def _pointer(doc: Any, ptr: str) -> Any:
    if ptr == "":
        return doc
    if not ptr.startswith("/"):
        raise SchemaError(f'Unsupported $ref fragment "#{ptr}"')
    cur: Any = doc
    for raw in ptr[1:].split("/"):
        seg = _decode_uri_component(raw).replace("~1", "/").replace("~0", "~")
        nxt: Any = _UNDEF
        if isinstance(cur, list):
            s = js_trim(seg)
            n = 0.0 if s == "" else js_number(s)
            if n == n and n.is_integer() and 0 <= n < len(cur):
                nxt = cur[int(n)]
        elif _is_obj(cur):
            nxt = cur[seg] if seg in cur else (_FN if seg in _PROTO else _UNDEF)
        if nxt is _UNDEF:
            raise SchemaError(f'Unresolvable $ref pointer "#{ptr}"')
        cur = nxt
    return cur


def _resolve_ref(ref: str, ctx: _Ctx) -> tuple[Any, _Ctx]:
    hash_ = ref.find("#")
    file = ref if hash_ == -1 else ref[:hash_]
    frag = "" if hash_ == -1 else ref[hash_ + 1 :]
    nxt = ctx
    if file != "":
        id_ = os.path.abspath(os.path.join(os.path.dirname(ctx.base), file))
        if id_ not in ctx.docs:
            ctx.docs[id_] = ctx.opts.load(id_)
        nxt = dataclasses.replace(ctx, doc=ctx.docs[id_], base=id_)
    return _pointer(nxt.doc, frag), nxt


def _js_regex(p: str) -> str:
    """Translates a JS pattern to Python `re` syntax (see the module docstring)."""
    out: list[str] = []
    i, in_class = 0, False
    while i < len(p):
        c = p[i]
        if c == "\\" and i + 1 < len(p):
            n = p[i + 1]
            i += 2
            if n == "s":
                out.append(JS_WS if in_class else f"[{JS_WS}]")
            elif n == "S":
                out.append(f"[^{JS_WS}]")
            elif n == "k" and p[i : i + 1] == "<":
                j = p.index(">", i)
                out.append(f"(?P={p[i + 1 : j]})")
                i = j + 1
            elif n == "u" and p[i : i + 1] == "{" and "}" in p[i:]:
                j = p.index("}", i)
                out.append(re.escape(chr(int(p[i + 1 : j], 16))))
                i = j + 1
            elif n == "d":
                out.append("0-9" if in_class else "[0-9]")
            elif n == "D":
                out.append("[^0-9]")
            elif n == "/":
                out.append("/")
            else:
                out.append("\\" + n)
            continue
        if in_class:
            in_class = c != "]"
            out.append(c)
        elif c == "[":
            in_class = True
            out.append(c)
            neg = p[i + 1 : i + 2] == "^"
            if neg:
                out.append("^")
                i += 1
            if p[i + 1 : i + 2] == "]":  # JS: `[]` matches nothing, `[^]` anything
                out[-2 if neg else -1 :] = [r"[\s\S]" if neg else "(?!)"]
                i += 1
                in_class = False
        elif c == "$":
            out.append(r"\Z")
        elif c == ".":
            out.append("[^\n\r  ]")
        elif c == "(" and p[i : i + 3] == "(?<" and p[i + 3 : i + 4] not in ("=", "!"):
            out.append("(?P<")
            i += 2
        else:
            out.append(c)
        i += 1
    return "".join(out)


def _compile(pattern: str, ctx: _Ctx) -> "re.Pattern[str]":
    re_ = ctx.regex.get(pattern)
    if re_ is None:
        re_ = re.compile(_js_regex(pattern), re.ASCII)
        ctx.regex[pattern] = re_
    return re_


def _check(schema: Any, value: Any, path: str, ctx: _Ctx, errs: list[str]) -> None:
    if schema is True:
        return
    if schema is False:
        errs.append(f"{path}: schema is false")
        return
    if not _is_obj(schema):
        raise SchemaError(f"Invalid schema at {path or '/'}")
    for k in schema:
        if k not in _KEYWORDS:
            raise SchemaError(f'Unsupported schema keyword "{k}"')

    def fail(msg: str) -> None:
        errs.append(f"{path}: {msg}")

    def valid(s: Any, v: Any = value) -> bool:
        sub: list[str] = []
        _check(s, v, path, ctx, sub)
        return not sub

    if isinstance(schema.get("$ref"), str):
        rs, rctx = _resolve_ref(schema["$ref"], ctx)
        _check(rs, value, path, rctx, errs)
    if "type" in schema:
        t = schema["type"]
        types = t if isinstance(t, list) else [t]
        if not any(_matches_type(value, x) for x in types):
            fail(f"expected type {'|'.join(_join_str(x) for x in types)}, got {_type_of(value)}")
    if isinstance(schema.get("enum"), list) and not any(_same(e, value) for e in schema["enum"]):
        fail("not one of the allowed values")
    if "const" in schema and not _same(schema["const"], value):
        fail("does not equal the required constant")

    if isinstance(value, str):
        n = len(value)  # [...value].length counts code points
        if _num(schema.get("minLength")) and n < schema["minLength"]:
            fail(f"shorter than {_ns(schema['minLength'])}")
        if _num(schema.get("maxLength")) and n > schema["maxLength"]:
            fail(f"longer than {_ns(schema['maxLength'])}")
        if isinstance(schema.get("pattern"), str) and not _compile(schema["pattern"], ctx).search(value):
            fail(f"does not match pattern {schema['pattern']}")
    if _num(value):
        if _num(schema.get("minimum")) and value < schema["minimum"]:
            fail(f"below minimum {_ns(schema['minimum'])}")
        if _num(schema.get("maximum")) and value > schema["maximum"]:
            fail(f"above maximum {_ns(schema['maximum'])}")

    if _is_obj(value):
        for key in schema.get("required") or []:
            if not _has(value, key):
                fail(f'missing required property "{key}"')
        props = schema["properties"] if _is_obj(schema.get("properties")) else {}
        for key in js_keys(props):
            sub = props[key]
            if _has(value, key):
                _check(sub, _get(value, key), f"{path}/{key}", ctx, errs)
        if "additionalProperties" in schema:
            ap = schema["additionalProperties"]
            for key in js_keys(value):
                if key in props or key in _PROTO:
                    continue
                if ap is False:
                    errs.append(f"{path}/{key}: additional property not allowed")
                else:
                    _check(ap, value[key], f"{path}/{key}", ctx, errs)
        if _is_obj(schema.get("dependentRequired")):
            for key in js_keys(schema["dependentRequired"]):
                needed = schema["dependentRequired"][key]
                if not _has(value, key):
                    continue
                for n_ in needed:
                    if not _has(value, n_):
                        fail(f'"{key}" requires "{n_}"')

    if isinstance(value, list):
        if _num(schema.get("minItems")) and len(value) < schema["minItems"]:
            fail(f"fewer than {_ns(schema['minItems'])} items")
        if _num(schema.get("maxItems")) and len(value) > schema["maxItems"]:
            fail(f"more than {_ns(schema['maxItems'])} items")
        if schema.get("uniqueItems") is True:
            seen: set[str] = set()
            for item in value:
                key = canonical_json(item)
                if key in seen:
                    fail("items are not unique")
                    break
                seen.add(key)
        prefix = schema["prefixItems"] if isinstance(schema.get("prefixItems"), list) else []
        for i, sub in enumerate(prefix):
            if i < len(value):
                _check(sub, value[i], f"{path}/{i}", ctx, errs)
        if "items" in schema:
            for i in range(len(prefix), len(value)):
                _check(schema["items"], value[i], f"{path}/{i}", ctx, errs)
        if "contains" in schema:
            lo = schema["minContains"] if _num(schema.get("minContains")) else 1
            hi = schema["maxContains"] if _num(schema.get("maxContains")) else float("inf")
            n = sum(1 for item in value if valid(schema["contains"], item))
            if n < lo:
                fail(f'fewer than {_ns(lo)} items match "contains"')
            if n > hi:
                fail(f'more than {_ns(hi)} items match "contains"')

    if isinstance(schema.get("allOf"), list):
        for s in schema["allOf"]:
            _check(s, value, path, ctx, errs)
    if isinstance(schema.get("anyOf"), list) and not any(valid(s) for s in schema["anyOf"]):
        fail("matches none of anyOf")
    if isinstance(schema.get("oneOf"), list):
        n = sum(1 for s in schema["oneOf"] if valid(s))
        if n != 1:
            fail(f"matches {n} of oneOf, expected exactly 1")
    if "not" in schema and valid(schema["not"]):
        fail('matches a "not" schema')
    if "if" in schema:
        if valid(schema["if"]):
            if "then" in schema:
                _check(schema["then"], value, path, ctx, errs)
        elif "else" in schema:
            _check(schema["else"], value, path, ctx, errs)


_ns = js_number_to_string


def _join_str(x: object) -> str:
    """JS `Array.prototype.join` element text."""
    if x is None:
        return ""
    if isinstance(x, bool):
        return "true" if x else "false"
    return x if isinstance(x, str) else _ns(x) if _num(x) else str(x)


def validate(schema: Any, value: Any, opts: ValidateOptions) -> list[str]:
    """Returns the list of violations ("<instance path>: <message>"); empty means valid."""
    errs: list[str] = []
    ctx = _Ctx(doc=schema, base=opts.base, opts=opts, docs={opts.base: schema}, regex={})
    try:
        _check(schema, value, "", ctx, errs)
    except RecursionError as e:  # a self-referencing $ref: V8 throws a RangeError with this message
        raise RecursionError("Maximum call stack size exceeded") from e
    return errs


def validate_file(schema_file: str, value: Any) -> list[str]:
    """Validates against a schema file; relative $ref files resolve next to it."""
    file = os.path.abspath(schema_file)

    def load(id_: str) -> Any:
        with open(id_, encoding="utf-8", errors="replace") as f:
            return js_json_loads(f.read())

    return validate(load(file), value, ValidateOptions(base=file, load=load))
