import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { runHook, type Handlers } from "./run.js";
import { readSessionState } from "../lib/state.js";

const runJs = new URL("./run.js", import.meta.url).pathname;

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "odd-run-"));
}

test("dispatches by event name and serializes handler output", () => {
  const dir = tmp();
  try {
    const handlers: Handlers = { Foo: (input) => ({ echoed: input.session_id }) };
    const r = runHook("Foo", JSON.stringify({ session_id: "s1" }), { handlers, dataDir: dir });
    assert.equal(r.exitCode, 0);
    assert.deepEqual(JSON.parse(r.stdout), { echoed: "s1" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("handler returning nothing writes no output", () => {
  const dir = tmp();
  try {
    const r = runHook("Foo", "{}", { handlers: { Foo: () => undefined }, dataDir: dir });
    assert.deepEqual(r, { exitCode: 0, stdout: "" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unknown event is a silent no-op", () => {
  const dir = tmp();
  try {
    const r = runHook("Nope", "{}", { handlers: {}, dataDir: dir });
    assert.deepEqual(r, { exitCode: 0, stdout: "" });
    assert.equal(existsSync(join(dir, "logs")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("throwing handler fails safe: exit 0, no output, error logged", () => {
  const dir = tmp();
  try {
    const handlers: Handlers = { Foo: () => { throw new Error("kaboom"); } };
    const r = runHook("Foo", "{}", { handlers, dataDir: dir });
    assert.deepEqual(r, { exitCode: 0, stdout: "" });
    assert.match(readFileSync(join(dir, "logs", "hooks.log"), "utf8"), /Foo.*kaboom/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("invalid stdin JSON fails safe and is logged", () => {
  const dir = tmp();
  try {
    const r = runHook("SessionStart", "{oops", { dataDir: dir });
    assert.deepEqual(r, { exitCode: 0, stdout: "" });
    assert.match(readFileSync(join(dir, "logs", "hooks.log"), "utf8"), /SessionStart/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: SessionStart fixture records session start in state, no stdout", () => {
  const dir = tmp();
  try {
    const r = spawnSync(process.execPath, [runJs, "SessionStart"], {
      input: JSON.stringify({ session_id: "sess-1", hook_event_name: "SessionStart", source: "startup" }),
      env: { ...process.env, CLAUDE_PLUGIN_DATA: dir },
      encoding: "utf8",
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "");
    const state = readSessionState("sess-1", { dataDir: dir });
    assert.equal(typeof state.startedAt, "string");
    assert.equal(state.source, "startup");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: unknown event and missing data dir exit 0", () => {
  const env = { ...process.env };
  delete env.CLAUDE_PLUGIN_DATA;
  const a = spawnSync(process.execPath, [runJs, "Nope"], { input: "{}", env, encoding: "utf8" });
  assert.equal(a.status, 0);
  assert.equal(a.stdout, "");
  const b = spawnSync(process.execPath, [runJs, "SessionStart"], { input: '{"session_id":"x"}', env, encoding: "utf8" });
  assert.equal(b.status, 0);
  assert.equal(b.stdout, "");
});
