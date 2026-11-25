import test from "node:test";
import assert from "node:assert/strict";
import { parseCsv, parseCsvWithHeader } from "../src/csv.js";

test("quoted field may contain commas", () => {
  assert.deepEqual(parseCsv('id,note\n1,"hello, world"'), [["id", "note"], ["1", "hello, world"]]);
});

test("doubled quotes inside a quoted field are a literal quote", () => {
  assert.deepEqual(parseCsv('"say ""hi""",x'), [['say "hi"', "x"]]);
});

test("quoted field may contain newlines", () => {
  assert.deepEqual(parseCsv('a,"line1\nline2",c\nd,e,f'), [["a", "line1\nline2", "c"], ["d", "e", "f"]]);
});

test("CRLF line endings are accepted and leave no carriage returns", () => {
  assert.deepEqual(parseCsv("a,b\r\n1,2\r\n"), [["a", "b"], ["1", "2"]]);
});

test("an explicitly quoted empty field is kept as an empty string", () => {
  assert.deepEqual(parseCsv('a,"",c'), [["a", "", "c"]]);
  assert.deepEqual(parseCsv('""\nx'), [[""], ["x"]]);
});

test("a quoted value with surrounding text-free fields keeps spaces", () => {
  assert.deepEqual(parseCsv('" padded ",b'), [[" padded ", "b"]]);
});

test("header parsing works with quoted fields", () => {
  assert.deepEqual(parseCsvWithHeader('name,desc\nbolt,"M8, steel"\n'), [{ name: "bolt", desc: "M8, steel" }]);
});

test("preserved: blank lines skipped, empty fields kept, no trailing row", () => {
  assert.deepEqual(parseCsv("a,,c\n\n1,2,3\n"), [["a", "", "c"], ["1", "2", "3"]]);
  assert.deepEqual(parseCsv(""), []);
});
