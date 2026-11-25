import test from "node:test";
import assert from "node:assert/strict";
import { parseCsv, parseCsvWithHeader } from "../src/csv.js";

test("parses simple rows and skips blank lines", () => {
  assert.deepEqual(parseCsv("a,b,c\n\n1,2,3\n"), [["a", "b", "c"], ["1", "2", "3"]]);
});

test("keeps empty fields", () => {
  assert.deepEqual(parseCsv("a,,c"), [["a", "", "c"]]);
});

test("header rows become objects", () => {
  assert.deepEqual(parseCsvWithHeader("name,qty\nbolt,4\nnut"), [
    { name: "bolt", qty: "4" },
    { name: "nut", qty: "" },
  ]);
});

test("empty input gives no rows", () => {
  assert.deepEqual(parseCsvWithHeader(""), []);
});
