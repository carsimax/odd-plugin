import test from "node:test";
import assert from "node:assert/strict";
import { ApiLimiter, LoginLimiter } from "../src/limiters.js";

test("ApiLimiter allows up to the per-minute budget", () => {
  let t = 0;
  const l = new ApiLimiter({ perMinute: 2, now: () => t });
  assert.equal(l.allow("a"), true);
  assert.equal(l.allow("a"), true);
  assert.equal(l.allow("a"), false);
  assert.equal(l.allow("b"), true);
});

test("LoginLimiter reports remaining attempts", () => {
  const l = new LoginLimiter({ maxAttempts: 2, windowMs: 1000, now: () => 0 });
  assert.deepEqual(l.attempt("u"), { ok: true, remaining: 1 });
});
