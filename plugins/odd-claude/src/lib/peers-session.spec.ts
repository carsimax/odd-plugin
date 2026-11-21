import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { currentDir, CURRENT_STALE_MS, forgetCurrentSession, MAX_CURRENT_ENTRIES, readCurrentSession, recordCurrentSession, resolveSessionId } from "./peers-session.js";
import { sessionStart } from "../hooks/session-start.js";
import { sessionEnd } from "../hooks/session-end.js";

const A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const B = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const EMPTY_ENV = {};

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "odd-peers-session-"));
}

test("record then read: atomic private entry keyed by pid", () => {
  const dir = tmp();
  try {
    recordCurrentSession(A, process.pid, { dataDir: dir });
    const file = join(currentDir({ dataDir: dir }), `${process.pid}.json`);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).session_id, A);
    assert.equal(readCurrentSession(process.pid, { dataDir: dir }), A);
    assert.deepEqual(resolveSessionId(process.pid, { dataDir: dir, env: EMPTY_ENV }), { session_id: A, source: "hook" });
    assert.equal(readdirSync(currentDir({ dataDir: dir })).filter((n) => n.endsWith(".tmp")).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unknown when nothing recorded; env CLAUDE_SESSION_ID wins only when it is a valid id", () => {
  const dir = tmp();
  try {
    assert.equal(resolveSessionId(process.pid, { dataDir: dir, env: EMPTY_ENV }), null);
    assert.deepEqual(resolveSessionId(process.pid, { dataDir: dir, env: { CLAUDE_SESSION_ID: B } }), { session_id: B, source: "env" });
    assert.equal(resolveSessionId(process.pid, { dataDir: dir, env: { CLAUDE_SESSION_ID: "../x" } }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("invalid session id or pid is refused and writes nothing", () => {
  const dir = tmp();
  try {
    for (const id of ["../etc/passwd", "short", "", "a/b/c/d/e/f/g/h"]) assert.throws(() => recordCurrentSession(id, process.pid, { dataDir: dir }));
    for (const pid of [0, 1, -5, 1.5, NaN]) assert.throws(() => recordCurrentSession(A, pid, { dataDir: dir }));
    assert.equal(existsSync(join(dir, "peers")), false);
    assert.equal(readCurrentSession(-1, { dataDir: dir }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("confinement: a symlinked peers/.current dir is refused and a symlinked entry is not read", () => {
  const dir = tmp();
  const outside = tmp();
  try {
    mkdirSync(join(dir, "peers"));
    symlinkSync(outside, join(dir, "peers", ".current"));
    assert.throws(() => recordCurrentSession(A, process.pid, { dataDir: dir }));
    assert.deepEqual(readdirSync(outside), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
  const dir2 = tmp();
  const out2 = tmp();
  try {
    mkdirSync(currentDir({ dataDir: dir2 }), { recursive: true });
    writeFileSync(join(out2, "x.json"), JSON.stringify({ session_id: A }));
    symlinkSync(join(out2, "x.json"), join(currentDir({ dataDir: dir2 }), `${process.pid}.json`));
    assert.equal(readCurrentSession(process.pid, { dataDir: dir2 }), null);
  } finally {
    rmSync(dir2, { recursive: true, force: true });
    rmSync(out2, { recursive: true, force: true });
  }
});

test("corrupt, oversized and invalid-id entries read as unknown", () => {
  const dir = tmp();
  try {
    const cur = currentDir({ dataDir: dir });
    mkdirSync(cur, { recursive: true });
    const f = join(cur, `${process.pid}.json`);
    for (const body of ["{not json", JSON.stringify({ session_id: "../x" }), "[]", JSON.stringify({ session_id: A, pad: "x".repeat(10_000) })]) {
      writeFileSync(f, body);
      assert.equal(readCurrentSession(process.pid, { dataDir: dir }), null, body.slice(0, 20));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stale entries are bounded: old and dead-pid entries are pruned, the dir is capped, the own entry stays", () => {
  const dir = tmp();
  try {
    const cur = currentDir({ dataDir: dir });
    mkdirSync(cur, { recursive: true });
    const old = join(cur, `${process.ppid}.json`); // a live pid, but stale by age
    writeFileSync(old, JSON.stringify({ session_id: B }));
    const past = new Date(Date.now() - CURRENT_STALE_MS - 60_000);
    utimesSync(old, past, past);
    const dead = join(cur, "2147483000.json"); // practically never a live pid
    writeFileSync(dead, JSON.stringify({ session_id: B }));
    writeFileSync(join(cur, "notes.txt"), "kept: not an entry");
    recordCurrentSession(A, process.pid, { dataDir: dir });
    assert.equal(existsSync(old), false);
    assert.equal(existsSync(dead), false);
    assert.equal(existsSync(join(cur, "notes.txt")), true);
    assert.equal(readCurrentSession(process.pid, { dataDir: dir }), A);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(MAX_CURRENT_ENTRIES, 50);
});

test("fake parent: the hook's process.ppid equals the MCP server's process.ppid, so the server reads the id the hook recorded", () => {
  const dir = tmp();
  try {
    const mod = pathToFileURL(join(import.meta.dirname, "peers-session.js")).href;
    const hook = `import(${JSON.stringify(mod)}).then(m => m.recordCurrentSession(${JSON.stringify(A)}, process.ppid, { dataDir: ${JSON.stringify(dir)} }))`;
    const server = `import(${JSON.stringify(mod)}).then(m => process.stdout.write(JSON.stringify(m.resolveSessionId(process.ppid, { dataDir: ${JSON.stringify(dir)}, env: {} }))))`;
    // The "fake Claude Code": a node process that spawns the hook and the server as children, like the real parent does.
    const parent = `
      const { spawnSync } = require("node:child_process");
      const run = (code) => spawnSync(process.execPath, ["-e", code], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 20000 });
      const h = run(${JSON.stringify(hook)});
      const s = run(${JSON.stringify(server)});
      process.stdout.write(JSON.stringify({ h: h.status, hErr: h.stderr, s: s.stdout, sErr: s.stderr, pid: process.pid }));
    `;
    const r = spawnSync(process.execPath, ["-e", parent], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout) as { h: number; hErr: string; s: string; sErr: string; pid: number };
    assert.equal(out.h, 0, out.hErr);
    assert.deepEqual(JSON.parse(out.s), { session_id: A, source: "hook" }, out.sErr);
    assert.equal(existsSync(join(currentDir({ dataDir: dir }), `${out.pid}.json`)), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SessionStart hook records the entry for its parent pid and still returns its context; no entry without a session id", () => {
  const dir = tmp();
  try {
    const out = sessionStart({ session_id: A, source: "startup" }, { dataDir: dir, env: { CLAUDE_PLUGIN_DATA: dir } });
    assert.equal((out.hookSpecificOutput as { hookEventName?: string } | undefined)?.hookEventName, "SessionStart");
    assert.equal(readCurrentSession(process.ppid, { dataDir: dir }), A);
    const dir2 = tmp();
    try {
      sessionStart({ source: "startup" }, { dataDir: dir2, env: { CLAUDE_PLUGIN_DATA: dir2 } });
      assert.equal(existsSync(join(dir2, "peers")), false);
      sessionStart({ session_id: "../x" }, { dataDir: dir2, env: { CLAUDE_PLUGIN_DATA: dir2 } });
      assert.equal(existsSync(join(dir2, "peers", ".current")), false);
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("forgetCurrentSession removes only entries of this session; other files, symlinks and corrupt entries stay", () => {
  const dir = tmp();
  const outside = tmp();
  try {
    const o = { dataDir: dir };
    recordCurrentSession(A, 4242, o);
    recordCurrentSession(A, 4243, o);
    recordCurrentSession(B, 4244, o);
    const cur = currentDir(o);
    writeFileSync(join(cur, "notes.txt"), "keep");
    writeFileSync(join(cur, "4245.json"), "{corrupt");
    writeFileSync(join(outside, "target.json"), JSON.stringify({ session_id: A }));
    symlinkSync(join(outside, "target.json"), join(cur, "4246.json"));
    forgetCurrentSession(A, o);
    assert.deepEqual(readdirSync(cur).sort(), ["4244.json", "4245.json", "4246.json", "notes.txt"]);
    assert.equal(existsSync(join(outside, "target.json")), true);
    assert.throws(() => forgetCurrentSession("../x", o));
    forgetCurrentSession(A, { dataDir: join(dir, "nope") });
    const linked = tmp();
    try {
      mkdirSync(join(linked, "peers"));
      symlinkSync(cur, join(linked, "peers", ".current"));
      assert.throws(() => forgetCurrentSession(B, { dataDir: linked }));
      assert.equal(existsSync(join(cur, "4244.json")), true);
    } finally {
      rmSync(linked, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("SessionEnd removes this session's .current entries and never fails the hook", () => {
  const dir = tmp();
  try {
    const o = { dataDir: dir, env: { CLAUDE_PLUGIN_DATA: dir } };
    recordCurrentSession(A, 4242, o);
    recordCurrentSession(B, 4244, o);
    sessionEnd({ session_id: A, reason: "other" }, o);
    assert.deepEqual(readdirSync(currentDir(o)), ["4244.json"]);
    assert.doesNotThrow(() => sessionEnd({ session_id: "../x" }, o));
    assert.doesNotThrow(() => sessionEnd({ session_id: A }, { dataDir: join(dir, "none"), env: {} }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
