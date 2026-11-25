import test from "node:test";
import assert from "node:assert/strict";
import { parseMessage, charLength, COMMIT_TYPES, formatProblems, lintCommit } from "../src/index.js";

test("parseMessage splits lines and drops one trailing newline", () => {
  assert.deepEqual(parseMessage("a\nb\n"), ["a", "b"]);
  assert.deepEqual(parseMessage("a\r\nb"), ["a", "b"]);
  assert.deepEqual(parseMessage("a\n\n"), ["a", ""]);
  assert.deepEqual(parseMessage(""), [""]);
});

test("charLength counts code points", () => {
  assert.equal(charLength("abc"), 3);
  assert.equal(charLength("😀😀"), 2);
});

test("the commit types are fixed", () => {
  assert.deepEqual(COMMIT_TYPES, ["feat", "fix", "docs", "refactor", "test", "chore"]);
});

test("formatProblems prints one row per problem", () => {
  assert.equal(
    formatProblems([{ rule: "header-empty", line: 1, message: "header must not be empty" }]),
    "line 1: header must not be empty [header-empty]",
  );
  assert.equal(formatProblems([]), "");
});

test("lintCommit is exported", () => {
  assert.equal(typeof lintCommit, "function");
});
