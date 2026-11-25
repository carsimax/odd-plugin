import test from "node:test";
import assert from "node:assert/strict";
import { lintCommit } from "../../src/index.js";

// Acceptance looks at which rules fire and on which line; the exact texts are checked elsewhere.
const fired = (message, options) => lintCommit(message, options).map((p) => [p.rule, p.line]);

test("a well-formed message has no problems", () => {
  assert.deepEqual(lintCommit("feat(api): add pagination\n\nExplains why.\n"), []);
  assert.deepEqual(lintCommit("fix: handle empty input"), []);
  assert.deepEqual(lintCommit("refactor(core)!: drop legacy mode"), []);
});

test("empty header", () => {
  assert.deepEqual(fired(""), [["header-empty", 1]]);
  assert.deepEqual(fired("\n\nbody"), [["header-empty", 1]]);
});

test("header must follow type(scope): subject", () => {
  assert.deepEqual(fired("added stuff"), [["header-format", 1]]);
  assert.deepEqual(fired("feature: add x"), [["header-format", 1]]);
  assert.deepEqual(fired("feat(Api): add x"), [["header-format", 1]]);
  assert.deepEqual(fired("feat:missing space"), [["header-format", 1]]);
});

test("header length limit and the headerMax option", () => {
  const header = `feat: ${"x".repeat(70)}`;
  assert.deepEqual(fired(header), [["header-length", 1]]);
  assert.deepEqual(fired(header, { headerMax: 100 }), []);
  assert.deepEqual(fired("feat: short", { headerMax: 5 }), [["header-length", 1]]);
});

test("subject must not start uppercase or end with a period", () => {
  assert.deepEqual(fired("feat: Add x"), [["subject-case", 1]]);
  assert.deepEqual(fired("feat: add x."), [["subject-period", 1]]);
});

test("body must be separated from the header by a blank line", () => {
  assert.deepEqual(fired("fix: a\nbody right away"), [["body-separator", 2]]);
  assert.deepEqual(fired("fix: a\n\nbody"), []);
});

test("body lines have a length limit and the bodyMax option", () => {
  const long = "y".repeat(101);
  assert.deepEqual(fired(`fix: a\n\nok\n${long}`), [["body-line-length", 4]]);
  assert.deepEqual(fired(`fix: a\n\n${"y".repeat(60)}`, { bodyMax: 50 }), [["body-line-length", 3]]);
  assert.deepEqual(fired(`fix: a\n\n${"y".repeat(100)}`), []);
});

test("trailing whitespace is reported per line", () => {
  assert.deepEqual(fired("fix: a\n\nbody \nmore\t\nclean"), [["trailing-whitespace", 3], ["trailing-whitespace", 4]]);
  assert.deepEqual(fired("fix: a \n"), [["trailing-whitespace", 1]]);
});

test("problems have rule, line and a message", () => {
  const [problem] = lintCommit("nope");
  assert.deepEqual(Object.keys(problem).sort(), ["line", "message", "rule"]);
  assert.equal(typeof problem.message, "string");
});
