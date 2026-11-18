import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchLocked, runSessionIntegrations, WARMUP_STALE_MS, type IntegrationDeps, type LaunchCtx } from "./session-integrations.js";
import { lockPath } from "./lock.js";
import { refreshRegistry } from "./skill-registry.js";
import { runHook } from "../hooks/run.js";

function setup(): { base: string; cwd: string; home: string; cleanup: () => void } {
  const base = mkdtempSync(join(tmpdir(), "odd-int-"));
  const cwd = join(base, "proj");
  const home = join(base, "home");
  mkdirSync(join(cwd, "skills", "one"), { recursive: true });
  mkdirSync(home);
  writeFileSync(join(cwd, "skills", "one", "SKILL.md"), "---\nname: one\ndescription: Trigger: one\n---\n");
  return { base, cwd, home, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

function deps(home: string, over: Partial<IntegrationDeps> = {}): IntegrationDeps & { launched: string[]; refreshed: string[]; logs: string[] } {
  const launched: string[] = [];
  const refreshed: string[] = [];
  const logs: string[] = [];
  return {
    home,
    env: {},
    hasIndex: () => false,
    isBroadDir: () => false,
    isTrusted: () => true,
    launchWarmup: (cwd) => { launched.push(cwd); },
    launchRegistryRefresh: (cwd) => { refreshed.push(cwd); },
    log: (m) => logs.push(m),
    ...over,
    launched,
    refreshed,
    logs,
  };
}

function writeRegistry(s: { cwd: string; home: string }): void {
  refreshRegistry({ cwd: s.cwd, home: s.home, plugins: [], env: {}, gitTracked: () => [] });
}

test("registry: existing registry yields one short context line and a background refresh is launched; nothing is written inline", () => {
  const s = setup();
  try {
    writeRegistry(s);
    const before = readFileSync(join(s.cwd, ".atl", "skill-registry.md"), "utf8");
    const d = deps(s.home);
    const { extraLines } = runSessionIntegrations(s.cwd, d);
    assert.equal(extraLines.length, 1);
    assert.match(extraLines[0]!, /Skill registry: .*\.atl\/skill-registry\.md \(1 skill\)/);
    assert.ok(extraLines[0]!.length < 400);
    assert.deepEqual(d.refreshed, [s.cwd]);
    assert.equal(readFileSync(join(s.cwd, ".atl", "skill-registry.md"), "utf8"), before);
  } finally {
    s.cleanup();
  }
});

test("registry: first start has no registry yet, so no line, no inline write and no git call; refresh is launched", () => {
  const s = setup();
  try {
    const d = deps(s.home);
    const r = runSessionIntegrations(s.cwd, d);
    assert.deepEqual(r.extraLines, []);
    assert.equal(existsSync(join(s.cwd, ".atl")), false);
    assert.deepEqual(d.refreshed, [s.cwd]);
    assert.deepEqual(d.launched, []); // no index, no trust needed
  } finally {
    s.cleanup();
  }
});

test("registry: opt-out env leaves the project untouched, adds no line and launches nothing", () => {
  const s = setup();
  try {
    writeRegistry(s);
    const d = deps(s.home, { env: { ODD_CLAUDE_NO_SKILL_REGISTRY: "1" } });
    assert.deepEqual(runSessionIntegrations(s.cwd, d).extraLines, []);
    assert.deepEqual(d.refreshed, []);
  } finally {
    s.cleanup();
  }
});

test("warm-up: indexed but untrusted project never launches (R1-001)", () => {
  const s = setup();
  try {
    const d = deps(s.home, { hasIndex: () => true, isTrusted: () => false });
    runSessionIntegrations(s.cwd, d);
    assert.deepEqual(d.launched, []);
  } finally {
    s.cleanup();
  }
});

test("warm-up: indexed and trusted project launches once", () => {
  const s = setup();
  try {
    const d = deps(s.home, { hasIndex: () => true });
    runSessionIntegrations(s.cwd, d);
    assert.deepEqual(d.launched, [s.cwd]);
  } finally {
    s.cleanup();
  }
});

test("failures in either integration are logged and never thrown", () => {
  const s = setup();
  try {
    const d = deps(s.home, {
      hasIndex: () => true,
      launchRegistryRefresh: () => { throw new Error("refresh spawn failed"); },
      launchWarmup: () => { throw new Error("spawn failed"); },
    });
    const r = runSessionIntegrations(s.cwd, d);
    assert.deepEqual(r.extraLines, []);
    assert.match(d.logs.join("\n"), /skill registry refresh launch failed.*refresh spawn failed/);
    assert.match(d.logs.join("\n"), /codegraph warm-up launch failed.*spawn failed/);
  } finally {
    s.cleanup();
  }
});

function ctx(dataDir: string, spawned: string[][], over: Partial<LaunchCtx> = {}): LaunchCtx {
  return { dataDir, env: {}, spawnChild: (args) => { spawned.push(args); return 4242; }, isAlive: () => true, ...over };
}

test("lock: second launch while the first is in flight does not spawn; lock is keyed per project", () => {
  const s = setup();
  try {
    const data = join(s.base, "data");
    const spawned: string[][] = [];
    assert.equal(launchLocked("warm", s.cwd, ctx(data, spawned)), "launched");
    assert.equal(launchLocked("warm", s.cwd, ctx(data, spawned)), "locked");
    assert.equal(spawned.length, 1);
    assert.equal(launchLocked("warm", join(s.base, "other"), ctx(data, spawned)), "launched");
    assert.equal(launchLocked("registry", s.cwd, ctx(data, spawned)), "launched"); // separate kind
    assert.equal(spawned.length, 3);
  } finally {
    s.cleanup();
  }
});

test("lock: a stale lock (dead pid, or older than the bound) is replaced and spawns", () => {
  const s = setup();
  try {
    const data = join(s.base, "data");
    const spawned: string[][] = [];
    assert.equal(launchLocked("warm", s.cwd, ctx(data, spawned, { now: () => 1_000 })), "launched");
    assert.equal(launchLocked("warm", s.cwd, ctx(data, spawned, { now: () => 2_000, isAlive: () => false })), "launched");
    assert.equal(launchLocked("warm", s.cwd, ctx(data, spawned, { now: () => 2_500 })), "locked");
    assert.equal(launchLocked("warm", s.cwd, ctx(data, spawned, { now: () => 2_000 + WARMUP_STALE_MS + 1 })), "launched");
    assert.equal(spawned.length, 3);
  } finally {
    s.cleanup();
  }
});

test("lock: spawn failure releases the lock; no data dir means no spawn", () => {
  const s = setup();
  try {
    const data = join(s.base, "data");
    const bad = ctx(data, [], { spawnChild: () => { throw new Error("nope"); } });
    assert.throws(() => launchLocked("warm", s.cwd, bad), /nope/);
    assert.equal(existsSync(lockPath(data, "warm", s.cwd)), false);
    const spawned: string[][] = [];
    assert.equal(launchLocked("warm", s.cwd, { ...ctx(data, spawned), dataDir: undefined }), "no-data-dir");
    assert.equal(spawned.length, 0);
  } finally {
    s.cleanup();
  }
});

test("SessionStart hook: does not wait for the refresh (time-bounded) and the registry is written eventually by the detached refresh", async () => {
  const s = setup();
  const data = join(s.base, "data");
  try {
    const env = { HOME: s.home, CLAUDE_PLUGIN_ROOT: "/r/odd", ODD_CLAUDE_BACKGROUND_SUBAGENTS: "on", ODD_CLAUDE_NO_CODEGRAPH_WARMUP: "1" };
    const noCwd = JSON.parse(runHook("SessionStart", JSON.stringify({ session_id: "s" }), { dataDir: data, env }).stdout);
    assert.doesNotMatch(noCwd.hookSpecificOutput.additionalContext, /Skill registry:/);
    assert.match(noCwd.hookSpecificOutput.additionalContext, /Background subagents: on/);
    const t0 = Date.now();
    const first = JSON.parse(runHook("SessionStart", JSON.stringify({ session_id: "s", cwd: s.cwd }), { dataDir: data, env }).stdout);
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 1000, `hook took ${elapsed} ms`);
    assert.doesNotMatch(first.hookSpecificOutput.additionalContext, /Skill registry:/);
    const file = join(s.cwd, ".atl", "skill-registry.md");
    for (let i = 0; i < 100 && !existsSync(file); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(existsSync(file), "detached refresh must write the registry");
    const second = JSON.parse(runHook("SessionStart", JSON.stringify({ session_id: "s", cwd: s.cwd }), { dataDir: data, env }).stdout);
    assert.match(second.hookSpecificOutput.additionalContext, /Skill registry: .*\.atl\/skill-registry\.md \(1 skill\)/);
  } finally {
    await new Promise((r) => setTimeout(r, 300)); // let a trailing detached refresh finish before cleanup
    s.cleanup();
  }
});
