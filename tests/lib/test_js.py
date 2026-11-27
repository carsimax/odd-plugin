import json
import math

import pytest

from odd_claude.lib import js

NUMBERS = [
    (0, "0"), (-0.0, "0"), (1, "1"), (2.0, "2"), (1.5, "1.5"), (1e-7, "1e-7"), (1e-6, "0.000001"), (1e21, "1e+21"), (1e20, "100000000000000000000"),
    (123e-20, "1.23e-18"), (2**53 + 1, "9007199254740992"), (1e15, "1000000000000000"), (-2.5, "-2.5"), (1.2345e25, "1.2345e+25"), (0.1 + 0.2, "0.30000000000000004"),
    (5e-324, "5e-324"), (1.7976931348623157e308, "1.7976931348623157e+308"), (-1e-7, "-1e-7"), (123456789012345680000.0, "123456789012345680000"),
]


@pytest.mark.parametrize(("x", "want"), NUMBERS)
def test_number_to_string(x, want):
    assert js.js_number_to_string(x) == want


def test_number_to_string_non_finite():
    assert js.js_number_to_string(math.nan) == "NaN"
    assert js.js_number_to_string(-math.inf) == "-Infinity"


def test_stringify_compact_and_indented():
    v = {"b": [1, 2.0, {}, []], "a": None, "t": True, "s": "x\n\"\\\x01 é\U0001f600\ud800"}
    assert js.js_stringify(v) == '{"b":[1,2,{},[]],"a":null,"t":true,"s":"x\\n\\"\\\\\\u0001 é\U0001f600\\ud800"}'
    assert js.js_stringify({"a": [1, {"b": 2}], "c": {}}, 2) == '{\n  "a": [\n    1,\n    {\n      "b": 2\n    }\n  ],\n  "c": {}\n}'
    assert js.js_stringify(math.nan) == "null"


def test_stringify_orders_integer_keys_first():
    assert js.js_stringify({"b": 1, "10": 2, "2": 3, "a": 4, "01": 5, "4294967295": 6, "4294967294": 7}) == (
        '{"2":3,"10":2,"4294967294":7,"b":1,"a":4,"01":5,"4294967295":6}'
    )


def test_json_loads():
    assert js.js_json_loads("9007199254740993") == 9007199254740992.0
    assert js.js_json_loads("[9007199254740991, 1.0, -0]") == [9007199254740991, 1.0, 0]
    assert isinstance(js.js_json_loads("9007199254740991"), int)
    for bad in ("NaN", "Infinity", "-Infinity", "[" * 100000):
        with pytest.raises(ValueError):
            js.js_json_loads(bad)


def test_whitespace_and_utf16():
    assert js.js_trim("\ufeff\u00a0 \x1cx\u2029") == "\x1cx"
    assert js.js_trim("\x85a") == "\x85a"
    assert js.utf16_len("a\U0001f600") == 3
    assert js.utf16_head("a\U0001f600", 2) == "a\ud83d"
    assert js.utf16_head("ab", 5) == "ab"


def test_number_and_double():
    assert js.js_number("0x10") == 16 and js.js_number("1e3") == 1000 and js.js_number("-Infinity") == -math.inf
    assert math.isnan(js.js_number("1_0")) and math.isnan(js.js_number("abc"))
    assert js.js_double(2.0) == 2 and isinstance(js.js_double(2.0), int)
    assert js.js_double(2**53 + 1) == 2**53 and js.js_double(1e21) == 1e21 and js.js_double(0.5) == 0.5


def test_keys_and_get():
    assert js.js_keys({"b": 1, "1": 2, "0": 3}) == ["0", "1", "b"]
    assert js.js_keys([5, 6]) == ["0", "1"] and js.js_keys("a\U0001f600") == ["0", "1", "2"] and js.js_keys(5) == []
    assert js.js_get({"a": 1}, "a") == 1 and js.js_get([5, 6], "1") == 6 and js.js_get("a\U0001f600", "1") == "\ud83d"


def test_stringify_round_trips_through_json_for_plain_values():
    v = {"a": [1, 2.5, "é"], "b": {"c": None}}
    assert json.loads(js.js_stringify(v, 2)) == v
