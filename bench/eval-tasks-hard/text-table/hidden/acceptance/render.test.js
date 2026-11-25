import test from "node:test";
import assert from "node:assert/strict";
import { renderTable as rawRender } from "../../src/index.js";

// Trailing spaces are checked by the regression suite; acceptance looks at the table itself.
const renderTable = (columns, rows) => rawRender(columns, rows).split("\n").map((l) => l.trimEnd()).join("\n");

test("renders a header, a separator and the rows", () => {
  const out = renderTable(
    [{ key: "name" }, { key: "qty" }],
    [{ name: "apple", qty: 3 }, { name: "kiwi", qty: 12 }],
  );
  assert.equal(out, ["name  | qty", "------+----", "apple |   3", "kiwi  |  12"].join("\n"));
});

test("titles replace keys in the header", () => {
  const out = renderTable([{ key: "id", title: "ID" }, { key: "total", title: "Total EUR" }], [{ id: "a1", total: 5 }]);
  assert.equal(out, ["ID | Total EUR", "---+----------", "a1 |         5"].join("\n"));
});

test("number columns align right and text columns left by default", () => {
  const out = renderTable([{ key: "n" }, { key: "s" }], [{ n: 1, s: "x" }, { n: 100, s: "yyy" }]).split("\n");
  assert.equal(out[2], "  1 | x");
  assert.equal(out[3], "100 | yyy");
});

test("explicit alignment wins over the default", () => {
  const out = renderTable([{ key: "n", align: "left" }, { key: "s", align: "right" }], [{ n: 1, s: "ab" }, { n: 22, s: "abcd" }]).split("\n");
  assert.equal(out[2], "1  |   ab");
  assert.equal(out[3], "22 | abcd");
});

test("a column is as wide as its widest text, header included", () => {
  const out = renderTable([{ key: "a", title: "Longer title" }], [{ a: "x" }]).split("\n");
  assert.equal(out[0], "Longer title");
  assert.equal(out[1], "------------");
  assert.equal(out[2], "x");
});

test("a key missing from a row renders as empty", () => {
  const out = renderTable([{ key: "b" }, { key: "a" }], [{ a: "x" }, { a: "y", b: 2 }]).split("\n");
  assert.equal(out[2], "  | x");
  assert.equal(out[3], "2 | y");
});

test("inputs are not mutated", () => {
  const columns = [{ key: "a" }];
  const rows = [{ a: "x" }];
  renderTable(columns, rows);
  assert.deepEqual(columns, [{ key: "a" }]);
  assert.deepEqual(rows, [{ a: "x" }]);
});
