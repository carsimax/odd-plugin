"""JavaScript-compatibility helpers shared by the lib modules (v9 behavior that Python's stdlib does not match):
whitespace (`\\s`, `trim`), UTF-16 `length`/`slice`, `JSON.parse`, `JSON.stringify`, `Number()`, `Number::toString`, `Object.keys` order."""
import json
import math
import re
from decimal import Decimal
from typing import Any

#: JS `\s` / `trim()` whitespace (WhiteSpace + LineTerminator): no U+001C-001F or U+0085 (Python has them), but U+FEFF.
JS_WS = "\t\n\v\f\r                  　﻿"
_MAX_SAFE = 2**53


def js_trim(s: str) -> str:
    """JS `String.prototype.trim`."""
    return s.strip(JS_WS)


def utf16_len(s: str) -> int:
    """JS `String.length`: an astral character counts as two UTF-16 code units."""
    return len(s) + sum(1 for c in s if ord(c) > 0xFFFF)


def utf16_head(s: str, n: int) -> str:
    """JS `s.slice(0, n)`: may cut an astral character in half, leaving a lone surrogate."""
    if utf16_len(s) <= n:
        return s
    return s.encode("utf-16-le", "surrogatepass")[: 2 * n].decode("utf-16-le", "surrogatepass")


def _int_or_double(s: str) -> int | float:
    f = float(s)  # no int-digits limit; beyond 2**53 JS holds a double
    return int(s) if abs(f) < _MAX_SAFE else f


def _reject_constant(name: str) -> object:
    raise ValueError(name)  # NaN/Infinity are not JSON


def js_json_loads(text: str) -> Any:
    """JS `JSON.parse`: NaN/Infinity are errors, integers beyond 2**53 become doubles, a nesting too deep for Python is a parse error."""
    try:
        return json.loads(text, parse_constant=_reject_constant, parse_int=_int_or_double)
    except RecursionError as e:
        raise ValueError("too deep") from e


def js_double(v: int | float) -> int | float:
    """A JS number: an int beyond 2**53 is a double, and an integral double below 1e21 is an int (no `N.0`)."""
    if isinstance(v, int) and abs(v) > _MAX_SAFE:
        v = float(v)
    if isinstance(v, float) and v.is_integer() and abs(v) < 1e21:
        return int(Decimal(repr(v)))
    return v


_JS_DECIMAL = re.compile(r"[+-]?(?:[0-9]+\.?[0-9]*(?:[eE][+-]?[0-9]+)?|\.[0-9]+(?:[eE][+-]?[0-9]+)?|Infinity)")
_JS_RADIX = re.compile(r"0(?:[xX][0-9a-fA-F]+|[oO][0-7]+|[bB][01]+)")


def js_number(raw: str) -> float:
    """JS `Number(raw)` for a trimmed non-empty string; NaN when it is not a numeric literal."""
    if _JS_RADIX.fullmatch(raw):
        return float(int(raw, 0))
    return float(raw) if _JS_DECIMAL.fullmatch(raw) else math.nan


def js_number_to_string(x: int | float) -> str:
    """ECMAScript Number::toString: shortest round-trip digits, `1e+21` / `1e-7` exponent forms, no `.0`, `-0` is `0`."""
    if isinstance(x, int):
        if abs(x) <= _MAX_SAFE:
            return str(x)
        x = float(x)
    if math.isnan(x):
        return "NaN"
    if math.isinf(x):
        return "Infinity" if x > 0 else "-Infinity"
    if x == 0:
        return "0"
    t = Decimal(repr(abs(x))).as_tuple()
    n = len(t.digits) + int(t.exponent)  # value = 0.<digits> * 10**n
    digits = "".join(map(str, t.digits)).rstrip("0")
    k = len(digits)
    if k <= n <= 21:
        body = digits + "0" * (n - k)
    elif 0 < n <= 21:
        body = f"{digits[:n]}.{digits[n:]}"
    elif -6 < n <= 0:
        body = f"0.{'0' * -n}{digits}"
    else:
        e = n - 1
        body = f"{digits[0]}{'.' + digits[1:] if k > 1 else ''}e{'+' if e >= 0 else '-'}{abs(e)}"
    return ("-" if x < 0 else "") + body


def js_keys(v: object) -> list[str]:
    """`Object.keys(v)` of a parsed JSON value: array-index keys (canonical integers < 2**32-1) first, ascending, then the rest in insertion order."""
    if isinstance(v, dict):
        keys = [str(k) for k in v]
    elif isinstance(v, list):
        keys = [str(i) for i in range(len(v))]
    elif isinstance(v, str):
        keys = [str(i) for i in range(utf16_len(v))]
    else:
        return []
    idx = sorted((k for k in keys if re.fullmatch(r"0|[1-9][0-9]*", k) and int(k) < 2**32 - 1), key=int)
    seen = set(idx)
    return idx + [k for k in keys if k not in seen]


def js_get(v: object, key: str) -> object:
    """`v[key]` for a key from `js_keys(v)`."""
    if isinstance(v, dict):
        return v[key]
    if isinstance(v, list):
        return v[int(key)]
    units = v.encode("utf-16-le", "surrogatepass")  # type: ignore[union-attr]
    return units[2 * int(key) : 2 * int(key) + 2].decode("utf-16-le", "surrogatepass")


def _quote(s: str) -> str:
    # Lone surrogates are escaped as `\udXXX` (a Python str holds no pairs); everything else matches Python's raw-non-ASCII output.
    return re.sub(r"[\ud800-\udfff]", lambda m: f"\\u{ord(m.group()):04x}", json.dumps(s, ensure_ascii=False))


def js_stringify(v: Any, indent: int | None = None) -> str:
    """`JSON.stringify(v)` / `JSON.stringify(v, null, indent)`: JS number formatting, key order and lone-surrogate escapes."""

    def enc(x: Any, cur: str) -> str:
        if x is None:
            return "null"
        if x is True:
            return "true"
        if x is False:
            return "false"
        if isinstance(x, str):
            return _quote(x)
        if isinstance(x, (int, float)):
            return "null" if isinstance(x, float) and not math.isfinite(x) else js_number_to_string(x)
        if isinstance(x, (list, tuple)):
            items = [enc(i, cur + pad) for i in x]
            opener, closer = "[", "]"
        elif isinstance(x, dict):
            items = [f"{_quote(k)}{sep}{enc(x[k], cur + pad)}" for k in js_keys(x)]
            opener, closer = "{", "}"
        else:
            raise TypeError(f"not JSON serializable: {type(x).__name__}")
        if not items:
            return opener + closer
        if indent is None:
            return opener + ",".join(items) + closer
        inner = ",\n".join(cur + pad + i for i in items)
        return f"{opener}\n{inner}\n{cur}{closer}"

    pad = " " * (indent or 0)
    sep = ":" if indent is None else ": "
    return enc(v, "")
