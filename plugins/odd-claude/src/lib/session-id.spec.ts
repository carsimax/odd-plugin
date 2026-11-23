import { test } from "node:test";
import assert from "node:assert/strict";
import { isValidSessionId, PeersError } from "./session-id.js";
import * as peers from "./peers.js";

test("isValidSessionId accepts 8-64 char ids and rejects the rest", () => {
  assert.equal(isValidSessionId("abcdefgh"), true);
  assert.equal(isValidSessionId("a".repeat(64)), true);
  assert.equal(isValidSessionId("a".repeat(65)), false);
  assert.equal(isValidSessionId("abcdefg"), false);
  assert.equal(isValidSessionId("../etc/passwd"), false);
  assert.equal(isValidSessionId(42), false);
});

test("peers.js re-exports the same session-id helpers", () => {
  assert.equal(peers.isValidSessionId, isValidSessionId);
  assert.equal(peers.PeersError, PeersError);
});
