import test from "node:test";
import assert from "node:assert/strict";
import { mergeRanges, totalDays } from "../src/ranges.js";

test("a range fully inside another is absorbed", () => {
  assert.deepEqual(mergeRanges([[1, 10], [2, 3]]), [[1, 10]]);
});

test("containment works regardless of input order", () => {
  assert.deepEqual(mergeRanges([[2, 3], [1, 10]]), [[1, 10]]);
});

test("a contained range followed by a later overlap", () => {
  assert.deepEqual(mergeRanges([[1, 10], [3, 4], [9, 12]]), [[1, 12]]);
});

test("totalDays does not undercount nested ranges", () => {
  assert.equal(totalDays([[1, 10], [2, 3], [20, 20]]), 11);
});

test("identical ranges collapse", () => {
  assert.deepEqual(mergeRanges([[4, 6], [4, 6]]), [[4, 6]]);
});

test("input is not mutated and empty input is fine", () => {
  const input = [[5, 9], [1, 2]];
  mergeRanges(input);
  assert.deepEqual(input, [[5, 9], [1, 2]]);
  assert.deepEqual(mergeRanges([]), []);
});
