import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHook } from "./run.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "odd-sf-"));
}
const run = (event: string, stdin: string, dir: string) => runHook(event, stdin, { dataDir: dir, env: { CLAUDE_PLUGIN_ROOT: "/r/odd" } });
const fail = (input: object, dir: string) => run("StopFailure", JSON.stringify(input), dir);
const prompt = (dir: string, sid = "s1") =>
  JSON.parse(run("UserPromptSubmit", JSON.stringify({ session_id: sid, prompt: "sigue" }), dir).stdout).hookSpecificOutput.additionalContext as string;
const log = (dir: string) => (existsSync(join(dir, "logs", "hooks.log")) ? readFileSync(join(dir, "logs", "hooks.log"), "utf8") : "");

test("StopFailure with an exhausted category (billing_error) arms a 30 min advisory, logged and silent", () => {
  const dir = tmp();
  try {
    assert.deepEqual(fail({ session_id: "s1", error: "billing_error" }, dir), { exitCode: 0, stdout: "" });
    assert.match(log(dir), /StopFailure: quota \(billing_error\)/);
    const p = prompt(dir);
    assert.match(p, /quota failure; avoid that model for about 30 min/);
    assert.match(p, /\/model/);
    assert.match(p, /Anthropic models only/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("StopFailure with a transient category (overloaded) arms a 2 min advisory", () => {
  const dir = tmp();
  try {
    fail({ session_id: "s1", error: "overloaded" }, dir);
    assert.match(log(dir), /StopFailure: provider_unavailable \(overloaded\)/);
    assert.match(prompt(dir), /provider_unavailable failure; avoid that model for about 2 min/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("StopFailure classifies from error_details when the error type is unknown", () => {
  const dir = tmp();
  try {
    fail({ session_id: "s1", error: "mystery", error_details: "429 Too Many Requests" }, dir);
    assert.match(log(dir), /StopFailure: rate_limit \(mystery\)/);
    assert.match(prompt(dir), /rate_limit failure/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("StopFailure advice is scoped to the failing session", () => {
  const dir = tmp();
  try {
    fail({ session_id: "s1", error: "rate_limit" }, dir);
    assert.doesNotMatch(prompt(dir, "s2"), /fallback-model/);
    assert.match(prompt(dir, "s1"), /fallback-model/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("StopFailure without a session id logs the classification, arms nothing and stays silent", () => {
  const dir = tmp();
  try {
    assert.deepEqual(fail({ error: "rate_limit" }, dir), { exitCode: 0, stdout: "" });
    assert.deepEqual(fail({ session_id: "", error: "rate_limit" }, dir), { exitCode: 0, stdout: "" });
    assert.equal((log(dir).match(/StopFailure: rate_limit \(rate_limit\)/g) ?? []).length, 2);
    assert.equal(existsSync(join(dir, "status")), false);
    assert.doesNotMatch(prompt(dir), /fallback-model/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("StopFailure with empty or non-string fields logs other/unknown and arms nothing", () => {
  const dir = tmp();
  try {
    assert.deepEqual(fail({ session_id: "s1" }, dir), { exitCode: 0, stdout: "" });
    assert.deepEqual(fail({ session_id: "s1", error: 5, error_details: {} }, dir), { exitCode: 0, stdout: "" });
    assert.equal((log(dir).match(/StopFailure: other \(unknown\)/g) ?? []).length, 2);
    assert.doesNotMatch(prompt(dir), /fallback-model/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("StopFailure with empty or malformed stdin exits 0 with no output", () => {
  const dir = tmp();
  try {
    assert.deepEqual(run("StopFailure", "", dir), { exitCode: 0, stdout: "" });
    assert.deepEqual(run("StopFailure", "{not json", dir), { exitCode: 0, stdout: "" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
