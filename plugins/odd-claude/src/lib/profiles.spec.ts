import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PRESET_NAMES, PROFILE_ROLES, clearProfile, profileContextLine, readProfile, setRole, useProfile } from "./profiles.js";
import { profilesCli } from "../cli/profiles.js";
import { runHook } from "../hooks/run.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "odd-profiles-"));
}

test("presets cover every odd-claude agent with a whitelisted model and effort", () => {
  assert.deepEqual([...PRESET_NAMES], ["balanced", "economy", "max"]);
  assert.deepEqual([...PROFILE_ROLES].sort(), ["odd-explore", "odd-jd-fix", "odd-jd-judge-a", "odd-jd-judge-b", "odd-review-readability", "odd-review-reliability", "odd-review-resilience", "odd-review-risk", "odd-verify", "odd-worker"]);
});

test("no active profile by default: nothing routed, no context line", () => {
  const dir = tmp();
  try {
    assert.deepEqual(readProfile({ dataDir: dir }), { active: undefined, routing: {} });
    assert.equal(profileContextLine({ dataDir: dir }), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("use stores the preset routing; economy is cheaper than max", () => {
  const dir = tmp();
  try {
    useProfile("economy", { dataDir: dir });
    const eco = readProfile({ dataDir: dir });
    assert.equal(eco.active, "economy");
    assert.equal(eco.routing["odd-explore"]!.model, "haiku");
    useProfile("max", { dataDir: dir });
    const max = readProfile({ dataDir: dir });
    assert.equal(max.routing["odd-worker"]!.model, "opus");
    assert.equal(max.routing["odd-explore"]!.model, "sonnet");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("use rejects unknown names without touching the stored profile", () => {
  const dir = tmp();
  try {
    useProfile("balanced", { dataDir: dir });
    const before = readFileSync(join(dir, "profiles.json"), "utf8");
    for (const bad of ["", "nope", "balanced; rm", "../x", "__proto__", "constructor", "custom"]) {
      assert.throws(() => useProfile(bad, { dataDir: dir }), /invalid profile/);
    }
    assert.equal(readFileSync(join(dir, "profiles.json"), "utf8"), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("set edits one role, marks the profile custom, and validates role/model/effort", () => {
  const dir = tmp();
  try {
    useProfile("balanced", { dataDir: dir });
    setRole("odd-worker", "opus", "high", { dataDir: dir });
    const p = readProfile({ dataDir: dir });
    assert.equal(p.active, "custom");
    assert.deepEqual(p.routing["odd-worker"], { model: "opus", effort: "high" });
    assert.equal(p.routing["odd-explore"]!.model, "haiku");
    const before = readFileSync(join(dir, "profiles.json"), "utf8");
    assert.throws(() => setRole("odd-evil", "opus", undefined, { dataDir: dir }), /invalid role/);
    assert.throws(() => setRole("odd-worker", "gpt-9", undefined, { dataDir: dir }), /invalid model/);
    assert.throws(() => setRole("odd-worker", "opus", "turbo", { dataDir: dir }), /invalid effort/);
    assert.throws(() => setRole("constructor", "opus", undefined, { dataDir: dir }), /invalid role/);
    assert.equal(readFileSync(join(dir, "profiles.json"), "utf8"), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("clear removes the active profile", () => {
  const dir = tmp();
  try {
    useProfile("max", { dataDir: dir });
    clearProfile({ dataDir: dir });
    assert.deepEqual(readProfile({ dataDir: dir }), { active: undefined, routing: {} });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("corrupt or tampered state reads as no profile; unknown roles/models in it are dropped", () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "profiles.json"), "{{{");
    assert.deepEqual(readProfile({ dataDir: dir }), { active: undefined, routing: {} });
    writeFileSync(join(dir, "profiles.json"), JSON.stringify({ version: 1, sessionId: "profiles", data: { active: "custom", routing: { "odd-worker": { model: "opus", effort: "zzz" }, "odd-x": { model: "opus" }, "odd-verify": { model: "evil\nmodel" } } } }));
    assert.deepEqual(readProfile({ dataDir: dir }).routing, { "odd-worker": { model: "opus" } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("context line lists the active profile and tells the orchestrator to pass model", () => {
  const dir = tmp();
  try {
    useProfile("economy", { dataDir: dir });
    const line = profileContextLine({ dataDir: dir })!;
    assert.match(line, /Model profile: economy/);
    assert.match(line, /`model`/);
    assert.match(line, /odd-claude:odd-explore=haiku/);
    const out = runHook("SessionStart", JSON.stringify({ session_id: "s" }), { dataDir: dir, env: {} });
    assert.match(JSON.parse(out.stdout).hookSpecificOutput.additionalContext, /Model profile: economy/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SessionStart without a profile has no profile line (previous behaviour)", () => {
  const dir = tmp();
  try {
    const out = runHook("SessionStart", JSON.stringify({ session_id: "s" }), { dataDir: dir, env: {} });
    assert.doesNotMatch(JSON.parse(out.stdout).hookSpecificOutput.additionalContext, /Model profile/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("profilesCli list/show/use/set/clear with strict argument whitelist", () => {
  const dir = tmp();
  try {
    const run = (...a: string[]) => profilesCli([...a, "--data-dir", dir], {});
    const list = run("list");
    assert.equal(list.exitCode, 0);
    assert.match(list.stdout, /balanced/);
    assert.match(list.stdout, /economy/);
    assert.match(list.stdout, /max/);
    assert.match(run("show").stdout, /no active profile/i);
    assert.equal(run("use", "economy").exitCode, 0);
    assert.match(run("show").stdout, /active: economy[\s\S]*odd-explore\s+haiku/);
    const bad = run("use", "evil;x");
    assert.equal(bad.exitCode, 1);
    assert.match(bad.stderr, /invalid profile/);
    assert.equal(run("use").exitCode, 2);
    assert.equal(run("frobnicate").exitCode, 2);
    assert.equal(run("set", "odd-worker", "opus", "high").exitCode, 0);
    assert.match(run("show").stdout, /active: custom/);
    assert.equal(run("set", "odd-worker", "nope").exitCode, 1);
    assert.equal(run("clear").exitCode, 0);
    assert.match(run("show").stdout, /no active profile/i);
    assert.equal(profilesCli(["list"], {}).exitCode, 0);
    assert.equal(profilesCli(["use", "max"], {}).exitCode, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
