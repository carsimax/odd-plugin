import test from "node:test";
import assert from "node:assert/strict";
import { renderTable, TableError } from "../../src/index.js";

const lines = (columns, rows) => renderTable(columns, rows).split("\n");

test("no line ends with a space", () => {
  const out = renderTable([{ key: "a" }, { key: "b" }], [{ a: "x", b: "long text" }, { a: "yyy", b: "s" }]);
  assert.equal(out, ["a   | b", "----+----------", "x   | long text", "yyy | s"].join("\n"));
  for (const line of out.split("\n")) assert.equal(line, line.trimEnd());
});

test("a missing trailing cell leaves no trailing spaces", () => {
  assert.deepEqual(lines([{ key: "b", title: "Num" }, { key: "a" }], [{ b: 1 }]), ["Num | a", "----+--", "  1 |"]);
});

test("empty rows render exactly (no rows), without a header", () => {
  assert.equal(renderTable([{ key: "a" }], []), "(no rows)");
});

test("long texts are cut to maxWidth with an ellipsis", () => {
  assert.deepEqual(lines([{ key: "a", maxWidth: 5 }], [{ a: "abcdefgh" }, { a: "abcde" }, { a: "ab" }]), ["a", "-----", "abcd…", "abcde", "ab"]);
});

test("titles are cut the same way and maxWidth 2 is allowed", () => {
  assert.deepEqual(lines([{ key: "a", title: "Quantity", maxWidth: 2 }], [{ a: "xyz" }]), ["Q…", "--", "x…"]);
});

test("maxWidth larger than the content changes nothing", () => {
  assert.deepEqual(lines([{ key: "a", maxWidth: 40 }], [{ a: "xy" }]), ["a", "--", "xy"]);
});

test("cell values: null, booleans, dates and other values", () => {
  const out = lines(
    [{ key: "v" }],
    [{ v: null }, { v: undefined }, { v: true }, { v: false }, { v: new Date(Date.UTC(2024, 2, 5, 23, 30)) }, { v: { toString: () => "obj" } }],
  );
  assert.deepEqual(out, ["v", "----------", "", "", "yes", "no", "2024-03-05", "obj"]);
});

test("line breaks become the return symbol and tabs become spaces", () => {
  const out = lines([{ key: "v" }], [{ v: "a\nb" }, { v: "c\r\nd" }, { v: "e\rf" }, { v: "g\th" }]);
  assert.deepEqual(out.slice(2), ["a⏎b", "c⏎d", "e⏎f", "g h"]);
});

test("width is counted in code points", () => {
  const out = lines([{ key: "s" }, { key: "n" }], [{ s: "héllo", n: 1 }, { s: "a😀b", n: 22 }]);
  assert.deepEqual(out, ["s     |  n", "------+---", "héllo |  1", "a😀b   | 22"]);
});

test("default alignment: numbers with nulls are right, mixed and empty columns are left", () => {
  const out = lines(
    [{ key: "n" }, { key: "m" }, { key: "e" }, { key: "t" }],
    [{ n: 5, m: 1, e: null, t: "end" }, { n: null, m: "x", t: "end" }, { n: 123, m: 22, t: "end" }],
  );
  assert.equal(out[2], "  5 | 1  |   | end");
  assert.equal(out[3], "    | x  |   | end");
  assert.equal(out[4], "123 | 22 |   | end");
});

test("boolean columns are left aligned", () => {
  assert.deepEqual(lines([{ key: "ok", title: "Passed" }], [{ ok: true }, { ok: false }]), ["Passed", "------", "yes", "no"]);
});

function error(fn) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  assert.fail("expected a TableError");
}
function expectError(fn, message) {
  const err = error(fn);
  assert.ok(err instanceof TableError, `not a TableError: ${err}`);
  assert.equal(err.name, "TableError");
  assert.equal(err.message, message);
}

test("columns must be a non-empty array", () => {
  expectError(() => renderTable([], []), "columns must be a non-empty array");
  expectError(() => renderTable(undefined, []), "columns must be a non-empty array");
  expectError(() => renderTable("a", []), "columns must be a non-empty array");
});

test("column checks: key, duplicate, align, maxWidth", () => {
  expectError(() => renderTable([{ key: "a" }, { title: "x" }], []), "column 2 has no key");
  expectError(() => renderTable([{ key: "" }], []), "column 1 has no key");
  expectError(() => renderTable([{ key: "id" }, { key: "id" }], []), 'duplicate column key "id"');
  expectError(() => renderTable([{ key: "id", align: "middle" }], []), 'unknown align "middle" for column "id"');
  expectError(() => renderTable([{ key: "id", maxWidth: 1 }], []), 'maxWidth for column "id" must be an integer of at least 2');
  expectError(() => renderTable([{ key: "id", maxWidth: 2.5 }], []), 'maxWidth for column "id" must be an integer of at least 2');
});

test("the first failing check in column order is reported", () => {
  expectError(() => renderTable([{ key: "a", align: "x" }, { key: "" }], "no"), 'unknown align "x" for column "a"');
  expectError(() => renderTable([{ key: "a", align: "x", maxWidth: 0 }], []), 'unknown align "x" for column "a"');
});

test("rows must be an array and every row an object, even when validating empty input", () => {
  expectError(() => renderTable([{ key: "a" }], "no"), "rows must be an array");
  expectError(() => renderTable([{ key: "a" }], [{ a: 1 }, null]), "row 2 is not an object");
  expectError(() => renderTable([{ key: "a" }], [{ a: 1 }, { a: 2 }, [1]]), "row 3 is not an object");
  expectError(() => renderTable([{ key: "a" }], [5]), "row 1 is not an object");
});

test("column errors come before row errors", () => {
  expectError(() => renderTable([{ key: "a", maxWidth: 1 }], [null]), 'maxWidth for column "a" must be an integer of at least 2');
});
