import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyStopFailure, COOLDOWN_MS, quotaAdvice, recordQuotaFailure, takeQuotaAdvice } from "./quota.js";

test("classifies the Claude Code error types", () => {
  assert.equal(classifyStopFailure("rate_limit"), "rate_limit");
  assert.equal(classifyStopFailure("overloaded"), "provider_unavailable");
  assert.equal(classifyStopFailure("server_error"), "provider_unavailable");
  assert.equal(classifyStopFailure("billing_error"), "quota");
  assert.equal(classifyStopFailure("authentication_failed"), "auth");
  assert.equal(classifyStopFailure("invalid_request"), "invalid_request");
  assert.equal(classifyStopFailure("max_output_tokens"), "other");
});

test("an unknown type falls back to the error text (specific causes before generic statuses)", () => {
  assert.equal(classifyStopFailure("unknown", "429 You exceeded your current quota"), "quota");
  assert.equal(classifyStopFailure("unknown", "HTTP 429: Too many requests"), "rate_limit");
  assert.equal(classifyStopFailure("unknown", "status 503 upstream"), "provider_unavailable");
  assert.equal(classifyStopFailure("unknown", "request timed out"), "timeout");
  assert.equal(classifyStopFailure("unknown", "ECONNRESET"), "network");
  assert.equal(classifyStopFailure("unknown", "prompt is too long"), "context_length");
  assert.equal(classifyStopFailure(undefined, undefined), "other");
  assert.equal(classifyStopFailure("unknown", "x".repeat(10_000)), "other");
});

test("advice: cooldown semantics and same-provider wording; none for request problems", () => {
  const now = 1_000_000;
  const q = quotaAdvice("quota", now)!;
  assert.equal(q.cooldownMs, COOLDOWN_MS.exhausted);
  assert.equal(q.until, now + 30 * 60_000);
  assert.match(q.text, /--fallback-model/);
  assert.match(q.text, /\/model/);
  assert.match(q.text, /Anthropic/);
  assert.equal(quotaAdvice("rate_limit", now)!.cooldownMs, COOLDOWN_MS.transient);
  assert.equal(quotaAdvice("auth", now)!.cooldownMs, COOLDOWN_MS.exhausted);
  for (const c of ["context_length", "invalid_request", "other"] as const) assert.equal(quotaAdvice(c, now), undefined);
});

test("a recorded failure is advised once, only inside its cooldown, and never blocks", () => {
  const dir = mkdtempSync(join(tmpdir(), "odd-quota-"));
  try {
    const opts = { dataDir: dir };
    assert.equal(takeQuotaAdvice("s", opts), undefined);
    assert.equal(recordQuotaFailure("s", { error: "context_length" }, opts, 1000), undefined);
    assert.equal(takeQuotaAdvice("s", opts, 1000), undefined);
    const rec = recordQuotaFailure("s", { error: "rate_limit" }, opts, 1000)!;
    assert.equal(rec.category, "rate_limit");
    const text = takeQuotaAdvice("s", opts, 2000)!;
    assert.match(text, /rate_limit/);
    assert.equal(takeQuotaAdvice("s", opts, 3000), undefined, "advised only once");
    recordQuotaFailure("s", { error: "rate_limit" }, opts, 1000);
    assert.equal(takeQuotaAdvice("s", opts, 1000 + COOLDOWN_MS.transient + 1), undefined, "expired cooldown is not advised");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
