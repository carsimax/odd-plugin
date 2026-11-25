import test from "node:test";
import assert from "node:assert/strict";
import { TokenBucket } from "../src/token-bucket.js";
import { ApiLimiter, LoginLimiter } from "../src/limiters.js";

test("TokenBucket starts full and spends tokens", () => {
  const b = new TokenBucket({ capacity: 3, refillPerMs: 0.001, now: () => 0 });
  assert.equal(b.available(), 3);
  assert.equal(b.tryTake(), true);
  assert.equal(b.tryTake(2), true);
  assert.equal(b.tryTake(), false);
  assert.equal(b.available(), 0);
});

test("TokenBucket refills with the clock and never exceeds capacity", () => {
  let t = 0;
  const b = new TokenBucket({ capacity: 2, refillPerMs: 0.001, now: () => t });
  b.tryTake(2);
  t = 1500;
  assert.equal(b.available(), 1);
  t = 10_000_000;
  assert.equal(b.available(), 2);
});

test("TokenBucket refuses without spending when there are not enough tokens", () => {
  let t = 0;
  const b = new TokenBucket({ capacity: 2, refillPerMs: 0.001, now: () => t });
  b.tryTake(2);
  assert.equal(b.tryTake(2), false);
  t = 1000;
  assert.equal(b.available(), 1);
});

test("TokenBucket.msUntil tells how long to wait for n tokens", () => {
  let t = 0;
  const b = new TokenBucket({ capacity: 2, refillPerMs: 0.001, now: () => t });
  assert.equal(b.msUntil(1), 0);
  b.tryTake(2);
  assert.equal(b.msUntil(1), 1000);
  t = 400;
  assert.equal(b.msUntil(1), 600);
});

test("preserved: ApiLimiter budget, refill and per-key isolation", () => {
  let t = 0;
  const l = new ApiLimiter({ perMinute: 60, now: () => t });
  for (let i = 0; i < 60; i++) assert.equal(l.allow("k"), true);
  assert.equal(l.allow("k"), false);
  assert.equal(l.allow("other"), true);
  t = 1000;
  assert.equal(l.allow("k"), true);
  assert.equal(l.allow("k"), false);
  t = 10 * 60000;
  let allowed = 0;
  while (l.allow("k")) allowed++;
  assert.equal(allowed, 60);
});

test("preserved: LoginLimiter remaining, retryAfterMs and reset", () => {
  let t = 0;
  const l = new LoginLimiter({ maxAttempts: 3, windowMs: 3000, now: () => t });
  assert.deepEqual(l.attempt("u"), { ok: true, remaining: 2 });
  assert.deepEqual(l.attempt("u"), { ok: true, remaining: 1 });
  assert.deepEqual(l.attempt("u"), { ok: true, remaining: 0 });
  assert.deepEqual(l.attempt("u"), { ok: false, remaining: 0, retryAfterMs: 1000 });
  t = 400;
  assert.deepEqual(l.attempt("u"), { ok: false, remaining: 0, retryAfterMs: 600 });
  t = 1000;
  assert.deepEqual(l.attempt("u"), { ok: true, remaining: 0 });
  l.reset("u");
  assert.deepEqual(l.attempt("u"), { ok: true, remaining: 2 });
});
