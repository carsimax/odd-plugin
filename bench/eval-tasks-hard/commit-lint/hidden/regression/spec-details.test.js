import test from "node:test";
import assert from "node:assert/strict";
import { lintCommit, formatProblems } from "../../src/index.js";

const lint = (message, options) => lintCommit(message, options);

test("exact messages", () => {
  assert.deepEqual(lint(""), [{ rule: "header-empty", line: 1, message: "header must not be empty" }]);
  assert.deepEqual(lint("nope"), [{ rule: "header-format", line: 1, message: 'header must look like "type(scope): subject"' }]);
  assert.deepEqual(lint("feat: Add x"), [{ rule: "subject-case", line: 1, message: "subject must not start with an uppercase letter" }]);
  assert.deepEqual(lint("feat: add x."), [{ rule: "subject-period", line: 1, message: "subject must not end with a period" }]);
  assert.deepEqual(lint("fix: a\nbody"), [{ rule: "body-separator", line: 2, message: "header and body must be separated by a blank line" }]);
  assert.deepEqual(lint("fix: a\n\nbody  "), [{ rule: "trailing-whitespace", line: 3, message: "line has trailing whitespace" }]);
});

test("length messages carry the actual length and the limit", () => {
  assert.deepEqual(lint(`feat: ${"x".repeat(70)}`), [{ rule: "header-length", line: 1, message: "header is 76 characters, the limit is 72" }]);
  assert.deepEqual(lint(`fix: a\n\n${"y".repeat(120)}`), [{ rule: "body-line-length", line: 3, message: "line is 120 characters, the limit is 100" }]);
  assert.equal(lint("feat: short", { headerMax: 5 })[0].message, "header is 11 characters, the limit is 5");
  assert.equal(lint(`fix: a\n\n${"y".repeat(60)}`, { bodyMax: 50 })[0].message, "line is 60 characters, the limit is 50");
});

test("lengths count code points, not UTF-16 units", () => {
  assert.deepEqual(lint(`feat: ${"😀".repeat(66)}`), []);
  assert.equal(lint(`feat: ${"😀".repeat(67)}`)[0].message, "header is 73 characters, the limit is 72");
});

test("problems are ordered by line, then by rule order", () => {
  const long = "z".repeat(101);
  const result = lint(`Feat: Add. \nbody ${long}\n\n${long} \nend`);
  assert.deepEqual(
    result.map((p) => [p.line, p.rule]),
    [
      [1, "header-format"],
      [1, "trailing-whitespace"],
      [2, "body-separator"],
      [2, "body-line-length"],
      [4, "body-line-length"],
      [4, "trailing-whitespace"],
    ],
  );
});

test("rule order on the header", () => {
  const header = `feat: Add ${"x".repeat(70)}.`;
  assert.deepEqual(
    lint(`${header} `).map((p) => p.rule),
    ["header-length", "subject-case", "subject-period", "trailing-whitespace"],
  );
  assert.deepEqual(lint(header).map((p) => p.rule), ["header-length", "subject-case", "subject-period"]);
});

test("subject rules are skipped when the format fails", () => {
  assert.deepEqual(lint("Added stuff.").map((p) => p.rule), ["header-format"]);
  assert.deepEqual(lint("Fix: Add.").map((p) => p.rule), ["header-format"]);
});

test("a blank header only reports header-empty on line 1, body rules still run", () => {
  assert.deepEqual(lint("  \nbody").map((p) => [p.rule, p.line]), [["header-empty", 1], ["trailing-whitespace", 1], ["body-separator", 2]]);
});

test("the period rule ignores trailing whitespace", () => {
  assert.deepEqual(lint("feat: add x. ").map((p) => p.rule), ["subject-period", "trailing-whitespace"]);
  assert.deepEqual(lint("feat: add x ").map((p) => p.rule), ["trailing-whitespace"]);
});

test("a single URL line is exempt from the body length limit", () => {
  const url = `https://example.com/${"p".repeat(150)}`;
  assert.deepEqual(lint(`fix: a\n\n${url}`), []);
  assert.deepEqual(lint(`fix: a\n\nhttp://example.com/${"p".repeat(150)}`), []);
  assert.deepEqual(lint(`fix: a\n\nsee ${url}`).map((p) => p.rule), ["body-line-length"]);
  assert.deepEqual(lint(`fix: a\n\n${url} more`).map((p) => p.rule), ["body-line-length"]);
  assert.deepEqual(lint(`fix: a\n\nftp://example.com/${"p".repeat(150)}`).map((p) => p.rule), ["body-line-length"]);
});

test("comment lines from line 2 on are skipped but still counted", () => {
  const message = ["fix: a", "# this comment is long " + "c".repeat(120) + " ", "", "body ", "# another "].join("\n");
  assert.deepEqual(lint(message).map((p) => [p.rule, p.line]), [["trailing-whitespace", 4]]);
  assert.deepEqual(lint("fix: a\n# comment\nbody").map((p) => [p.rule, p.line]), []);
});

test("a comment on line 2 does not trigger the separator rule, text on line 2 does", () => {
  assert.deepEqual(lint("fix: a\n# note\n\nbody"), []);
  assert.deepEqual(lint("fix: a\n \nbody"), [{ rule: "trailing-whitespace", line: 2, message: "line has trailing whitespace" }]);
});

test("line 1 is never a comment", () => {
  assert.deepEqual(lint("# fix: a").map((p) => p.rule), ["header-format"]);
});

test("CRLF input and one trailing newline are handled", () => {
  assert.deepEqual(lint("fix: a\r\n\r\nbody\r\n"), []);
  assert.deepEqual(lint("fix: a\r\n\r\nbody \r\n").map((p) => [p.rule, p.line]), [["trailing-whitespace", 3]]);
  assert.deepEqual(lint("fix: a\n\n\n").map((p) => p.rule), []);
});

test("the results feed formatProblems", () => {
  assert.equal(formatProblems(lint("nope\nbody")), 'line 1: header must look like "type(scope): subject" [header-format]\nline 2: header and body must be separated by a blank line [body-separator]');
});
