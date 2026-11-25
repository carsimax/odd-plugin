import test from "node:test";
import assert from "node:assert/strict";
import { round } from "../src/index.js";

test("rounds to two decimals by default", () => {
  assert.equal(round(1.234), 1.23);
  assert.equal(round(1.239), 1.24);
});

test("rounds half up on exact halves", () => {
  assert.equal(round(0.125, 2), 0.13);
  assert.equal(round(2.5, 0), 3);
});

test("supports other digit counts", () => {
  assert.equal(round(1234.5678, 1), 1234.6);
  assert.equal(round(1234.5678, 0), 1235);
});
