import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, existsSync, readFileSync, writeFileSync, mkdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  STATE_SCHEMA_VERSION,
  resolveDataDir,
  sessionStatePath,
  readSessionState,
  writeSessionState,
  updateSessionState,
  logError,
} from "./state.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "odd-state-"));
}

test("write then read round-trips and stamps the schema version", () => {
  const dir = tmp();
  try {
    writeSessionState("s1", { a: 1 }, { dataDir: dir });
    assert.deepEqual(readSessionState("s1", { dataDir: dir }), { a: 1 });
    const raw = JSON.parse(readFileSync(sessionStatePath("s1", { dataDir: dir }), "utf8"));
    assert.equal(raw.version, STATE_SCHEMA_VERSION);
    assert.equal(raw.sessionId, "s1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("missing state reads as empty and creates nothing", () => {
  const dir = tmp();
  try {
    assert.deepEqual(readSessionState("nope", { dataDir: join(dir, "absent") }), {});
    assert.equal(existsSync(join(dir, "absent")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("missing data dir is created on write", () => {
  const dir = tmp();
  try {
    const nested = join(dir, "x", "y");
    writeSessionState("s1", { ok: true }, { dataDir: nested });
    assert.deepEqual(readSessionState("s1", { dataDir: nested }), { ok: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sessions are namespaced and do not overwrite each other", () => {
  const dir = tmp();
  try {
    writeSessionState("a", { v: "A" }, { dataDir: dir });
    writeSessionState("b", { v: "B" }, { dataDir: dir });
    assert.deepEqual(readSessionState("a", { dataDir: dir }), { v: "A" });
    assert.deepEqual(readSessionState("b", { dataDir: dir }), { v: "B" });
    assert.notEqual(sessionStatePath("a", { dataDir: dir }), sessionStatePath("b", { dataDir: dir }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("session ids cannot escape the data dir", () => {
  const dir = tmp();
  try {
    const p = sessionStatePath("../../evil", { dataDir: dir });
    assert.ok(p.startsWith(dir + "/"), p);
    assert.ok(!p.includes(".."), p);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("atomic write leaves no temp files and replaces content", () => {
  const dir = tmp();
  try {
    writeSessionState("s", { n: 1 }, { dataDir: dir });
    writeSessionState("s", { n: 2 }, { dataDir: dir });
    assert.deepEqual(readSessionState("s", { dataDir: dir }), { n: 2 });
    const files = readdirSync(join(dir, "sessions"));
    assert.deepEqual(files, [files[0]]);
    assert.ok(files[0].endsWith(".json"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("corrupt or wrong-version state reads as empty", () => {
  const dir = tmp();
  try {
    const p = sessionStatePath("s", { dataDir: dir });
    mkdirSync(join(dir, "sessions"), { recursive: true });
    writeFileSync(p, "{not json");
    assert.deepEqual(readSessionState("s", { dataDir: dir }), {});
    writeFileSync(p, JSON.stringify({ version: 999, sessionId: "s", data: { x: 1 } }));
    assert.deepEqual(readSessionState("s", { dataDir: dir }), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("updateSessionState merges via the updater", () => {
  const dir = tmp();
  try {
    writeSessionState("s", { n: 1 }, { dataDir: dir });
    updateSessionState("s", (d) => ({ ...d, m: 2 }), { dataDir: dir });
    assert.deepEqual(readSessionState("s", { dataDir: dir }), { n: 1, m: 2 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveDataDir prefers explicit option, then CLAUDE_PLUGIN_DATA, else throws", () => {
  assert.equal(resolveDataDir({ dataDir: "/x", env: { CLAUDE_PLUGIN_DATA: "/y" } }), "/x");
  assert.equal(resolveDataDir({ env: { CLAUDE_PLUGIN_DATA: "/y" } }), "/y");
  assert.throws(() => resolveDataDir({ env: {} }), /CLAUDE_PLUGIN_DATA/);
});

test("logError appends a line to logs/hooks.log", () => {
  const dir = tmp();
  try {
    logError("boom", { dataDir: dir });
    logError("again", { dataDir: dir });
    const lines = readFileSync(join(dir, "logs", "hooks.log"), "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    assert.match(lines[0], /boom/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("updateSessionState: an empty FRESH lock is held, so it times out without calling the callback or touching the lock", () => {
  const dir = tmp();
  try {
    const lock = `${sessionStatePath("st", { dataDir: dir })}.lock`;
    mkdirSync(join(dir, "sessions"), { recursive: true });
    writeFileSync(lock, "");
    let called = false;
    const t0 = Date.now();
    assert.throws(() => updateSessionState("st", (s) => ((called = true), s), { dataDir: dir }), /session state lock timeout/);
    assert.ok(Date.now() - t0 <= 1500, `took ${Date.now() - t0} ms`);
    assert.equal(called, false);
    assert.equal(readFileSync(lock, "utf8"), "");
    assert.deepEqual(readdirSync(join(dir, "sessions")), ["st.json.lock"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("updateSessionState: a lock older than 2 s (even empty) is stale and gets acquired; nothing is left behind", () => {
  const dir = tmp();
  try {
    const lock = `${sessionStatePath("st", { dataDir: dir })}.lock`;
    mkdirSync(join(dir, "sessions"), { recursive: true });
    writeFileSync(lock, "");
    const old = new Date(Date.now() - 3_000);
    utimesSync(lock, old, old);
    updateSessionState("st", (s) => ({ ...s, a: 1 }), { dataDir: dir });
    assert.deepEqual(readSessionState("st", { dataDir: dir }), { a: 1 });
    assert.deepEqual(readdirSync(join(dir, "sessions")), ["st.json"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
