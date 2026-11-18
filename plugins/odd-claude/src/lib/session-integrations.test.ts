import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSessionIntegrations, type IntegrationDeps } from "./session-integrations.js";
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

function deps(home: string, over: Partial<IntegrationDeps> = {}): IntegrationDeps & { launched: string[]; logs: string[] } {
  const launched: string[] = [];
  const logs: string[] = [];
  return {
    home,
    env: {},
    plugins: [],
    gitTracked: () => [],
    hasIndex: () => false,
    isBroadDir: () => false,
    launchWarmup: (cwd) => { launched.push(cwd); },
    log: (m) => logs.push(m),
    ...over,
    launched,
    logs,
  };
}

test("refreshes the registry and returns one short context line", () => {
  const s = setup();
  try {
    const d = deps(s.home);
    const { extraLines } = runSessionIntegrations(s.cwd, d);
    assert.equal(extraLines.length, 1);
    assert.match(extraLines[0]!, /Skill registry: .*\.atl\/skill-registry\.md \(1 skill\)/);
    assert.ok(extraLines[0]!.length < 400);
    assert.match(readFileSync(join(s.cwd, ".atl", "skill-registry.md"), "utf8"), /`one`/);
    assert.deepEqual(d.launched, []); // no index, no opt-in
  } finally {
    s.cleanup();
  }
});

test("opt-out env leaves the project untouched and adds no line", () => {
  const s = setup();
  try {
    const d = deps(s.home, { env: { ODD_CLAUDE_NO_SKILL_REGISTRY: "1" } });
    assert.deepEqual(runSessionIntegrations(s.cwd, d).extraLines, []);
    assert.equal(existsSync(join(s.cwd, ".atl")), false);
  } finally {
    s.cleanup();
  }
});

test("launches the codegraph warm-up in the background only for an indexed project", () => {
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
      gitTracked: () => { throw new Error("git down"); },
      launchWarmup: () => { throw new Error("spawn failed"); },
    });
    const r = runSessionIntegrations(s.cwd, d);
    assert.deepEqual(r.extraLines, []);
    assert.match(d.logs.join("\n"), /skill registry.*git-unavailable/i);
    assert.match(d.logs.join("\n"), /codegraph warm-up launch failed.*spawn failed/);
  } finally {
    s.cleanup();
  }
});

test("SessionStart hook: without cwd it does nothing extra; with cwd it adds the registry line and the policy line", () => {
  const s = setup();
  const data = join(s.base, "data");
  try {
    const env = { HOME: s.home, CLAUDE_PLUGIN_ROOT: "/r/odd", ODD_CLAUDE_BACKGROUND_SUBAGENTS: "on" };
    const noCwd = JSON.parse(runHook("SessionStart", JSON.stringify({ session_id: "s" }), { dataDir: data, env }).stdout);
    assert.doesNotMatch(noCwd.hookSpecificOutput.additionalContext, /Skill registry:/);
    assert.match(noCwd.hookSpecificOutput.additionalContext, /Background subagents: on/);
    const withCwd = JSON.parse(runHook("SessionStart", JSON.stringify({ session_id: "s", cwd: s.cwd }), { dataDir: data, env: { ...env, ODD_CLAUDE_NO_CODEGRAPH_WARMUP: "1" } }).stdout);
    assert.match(withCwd.hookSpecificOutput.additionalContext, /Skill registry: .*\.atl\/skill-registry\.md/);
    assert.ok(existsSync(join(s.cwd, ".atl", "skill-registry.md")));
  } finally {
    s.cleanup();
  }
});
