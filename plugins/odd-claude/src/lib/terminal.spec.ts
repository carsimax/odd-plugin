import { test } from "node:test";
import assert from "node:assert/strict";
import { titleSequence } from "./terminal.js";

test("title strips bidi override and isolate characters", () => {
  assert.equal(titleSequence("/h/a\u202Eb\u2066c\u2069d\u202A"), "\u001b]0;odd-claude · abcd\u0007");
});

test("title strips LRM, RLM, ALM and the line/paragraph separators", () => {
  assert.equal(titleSequence("/h/a\u200Eb\u200Fc\u061Cd\u2028e\u2029f"), "\u001b]0;odd-claude · abcdef\u0007");
});

test("title keeps a plain name", () => {
  assert.equal(titleSequence("/h/proj"), "\u001b]0;odd-claude · proj\u0007");
});
