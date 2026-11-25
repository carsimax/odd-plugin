import test from "node:test";
import assert from "node:assert/strict";
import { mergeRanges, totalDays } from "../src/ranges.js";

test("merges overlapping ranges", () => {
  assert.deepEqual(mergeRanges([[1, 3], [2, 6]]), [[1, 6]]);
});

test("merges adjacent ranges and sorts the output", () => {
  assert.deepEqual(mergeRanges([[5, 7], [1, 4]]), [[1, 7]]);
});

test("keeps disjoint ranges apart", () => {
  assert.deepEqual(mergeRanges([[10, 12], [1, 2]]), [[1, 2], [10, 12]]);
});

test("totalDays counts covered days", () => {
  assert.equal(totalDays([[1, 3], [2, 6]]), 6);
});
