import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectStatus, renderStatus, ROADMAP_PHASE } from "./status.js";
import { listSessionIds, writeSessionState } from "./state.js";
import { statusCli } from "../cli/status.js";

function withDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "odd-status-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const base = { pluginVersion: "0.1.0", hooks: () => ["SessionStart"] };

test("listSessionIds returns ids newest first and [] when the dir is missing", () => {
  withDir((dir) => {
    assert.deepEqual(listSessionIds({ dataDir: join(dir, "nope") }), []);
    writeSessionState("old", {}, { dataDir: dir });
    writeSessionState("new", {}, { dataDir: dir });
    utimesSync(join(dir, "sessions", "old.json"), new Date(1000), new Date(1000));
    assert.deepEqual(listSessionIds({ dataDir: dir }), ["new", "old"]);
  });
});

test("status with state: session id from env wins over latest", () => {
  withDir((dir) => {
    writeSessionState("a", { startedAt: "2026-01-01T00:00:00Z", source: "startup" }, { dataDir: dir });
    writeSessionState("b", { startedAt: "2026-02-02T00:00:00Z", source: "resume" }, { dataDir: dir });
    const s = collectStatus({ ...base, env: { CLAUDE_PLUGIN_DATA: dir, CLAUDE_SESSION_ID: "a" } });
    assert.equal(s.dataDir, dir);
    assert.equal(s.session.id, "a");
    assert.equal(s.session.origin, "env");
    assert.equal(s.session.state.source, "startup");
    assert.deepEqual(s.hooks, ["SessionStart"]);
    assert.equal(s.roadmapPhase, ROADMAP_PHASE);
    const text = renderStatus(s);
    assert.match(text, /odd-claude 0\.1\.0/);
    assert.match(text, /session: a \(env\)/);
    assert.match(text, /hooks: SessionStart/);
    assert.match(text, /roadmap: v1\.0: parity reached; next v1\.1 mods UX/);
  });
});

test("status falls back to the latest session when env has no id", () => {
  withDir((dir) => {
    writeSessionState("a", { n: 1 }, { dataDir: dir });
    const s = collectStatus({ ...base, env: { CLAUDE_PLUGIN_DATA: dir } });
    assert.equal(s.session.id, "a");
    assert.equal(s.session.origin, "latest");
  });
});

test("status without state or data dir: no session, no writes, no throw", () => {
  withDir((dir) => {
    const empty = collectStatus({ ...base, env: { CLAUDE_PLUGIN_DATA: dir } });
    assert.equal(empty.session.id, null);
    assert.equal(empty.session.origin, "none");
    assert.match(renderStatus(empty), /session: none/);
    const unset = collectStatus({ ...base, env: {} });
    assert.equal(unset.dataDir, null);
    assert.match(renderStatus(unset), /data dir: not set/);
    assert.deepEqual(listSessionIds({ dataDir: dir }), []);
  });
});

test("cli --json prints the status shape and exits 0", () => {
  const res = statusCli(["--json"], { ...base, env: {} });
  assert.equal(res.exitCode, 0);
  const j = JSON.parse(res.stdout);
  assert.deepEqual(Object.keys(j).sort(), ["dataDir", "hooks", "pluginVersion", "roadmapPhase", "schema", "session"]);
});

test("cli --session overrides env", () => {
  withDir((dir) => {
    writeSessionState("x", { source: "startup" }, { dataDir: dir });
    const res = statusCli(["--session", "x", "--json"], { ...base, env: { CLAUDE_PLUGIN_DATA: dir } });
    assert.equal(JSON.parse(res.stdout).session.id, "x");
  });
});

test("cli --data-dir overrides CLAUDE_PLUGIN_DATA; an empty --session value is ignored", () => {
  withDir((dir) => {
    writeSessionState("y", { source: "resume" }, { dataDir: dir });
    const res = statusCli(["--session", "", "--data-dir", dir, "--json"], { ...base, env: {} });
    const j = JSON.parse(res.stdout);
    assert.equal(j.dataDir, dir);
    assert.equal(j.session.id, "y");
    assert.equal(j.session.origin, "latest");
  });
});
