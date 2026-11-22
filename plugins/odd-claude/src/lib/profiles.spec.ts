import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PRESETS, PRESET_NAMES, PROFILE_ROLES, clearProfile, profileContextLine, readProfile, renderProfiles, setRole, useProfile } from "./profiles.js";
import { profilesCli } from "../cli/profiles.js";
import { runHook } from "../hooks/run.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "odd-profiles-"));
}

test("presets cover every odd-claude agent with a whitelisted model and effort", () => {
  assert.deepEqual([...PRESET_NAMES], ["balanced", "economy", "max"]);
  assert.deepEqual([...PROFILE_ROLES].sort(), ["odd-explore", "odd-jd-fix", "odd-jd-judge-a", "odd-jd-judge-b", "odd-review-readability", "odd-review-reliability", "odd-review-resilience", "odd-review-risk", "odd-verify", "odd-worker"]);
});

// S1: the user's table (all effort medium).
const TABLE: Record<string, string> = {
  "review-refuter": "opus",
  "review-validator": "opus",
  "odd-jd-judge-a": "opus",
  "odd-jd-judge-b": "sonnet",
  "odd-jd-fix": "sonnet",
  "odd-explore": "haiku",
  "odd-verify": "opus",
  "odd-worker": "sonnet",
  "odd-review-readability": "sonnet",
  "odd-review-reliability": "sonnet",
  "odd-review-resilience": "sonnet",
  "odd-review-risk": "opus",
};
const BALANCED = Object.fromEntries(Object.entries(TABLE).map(([k, model]) => [k, { model, effort: "medium" }]));

test("S1: the balanced preset is exactly the user's table, effort medium (incl. refuter and validator)", () => {
  assert.deepEqual(PRESETS.balanced, BALANCED);
  assert.deepEqual([...PRESET_NAMES], ["balanced", "economy", "max"]);
});

test("S1: economy and max keep their agent routes and gain refuter/validator rows mirroring their judges", () => {
  assert.deepEqual(PRESETS.economy["review-refuter"], { model: "sonnet", effort: "medium" });
  assert.deepEqual(PRESETS.economy["review-validator"], { model: "sonnet", effort: "medium" });
  assert.deepEqual(PRESETS.max["review-refuter"], { model: "opus", effort: "xhigh" });
  assert.deepEqual(PRESETS.max["review-validator"], { model: "opus", effort: "xhigh" });
  assert.deepEqual(PRESETS.economy["odd-explore"], { model: "haiku", effort: "low" });
  assert.deepEqual(PRESETS.economy["odd-jd-judge-a"], { model: "sonnet", effort: "medium" });
  assert.deepEqual(PRESETS.max["odd-worker"], { model: "opus", effort: "high" });
  assert.deepEqual(PRESETS.max["odd-explore"], { model: "haiku", effort: "medium" });
});

test("every preset routes odd-explore to haiku (explorers are cheap and launched in parallel)", () => {
  for (const name of PRESET_NAMES) assert.equal(PRESETS[name]["odd-explore"]!.model, "haiku", name);
});

test("S2: no stored profile -> balanced is the default and the context line is present", () => {
  const dir = tmp();
  try {
    assert.deepEqual(readProfile({ dataDir: dir }), { active: "balanced", routing: BALANCED });
    assert.deepEqual(readProfile({}), { active: "balanced", routing: BALANCED });
    const line = profileContextLine({ dataDir: dir })!;
    assert.match(line, /Model profile: balanced/);
    assert.match(line, /odd-claude:odd-explore=haiku/);
    assert.match(line, /odd-claude:odd-review-risk=opus/);
    assert.doesNotMatch(line, /review-refuter|review-validator/);
    assert.equal((line.match(/odd-claude:odd-/g) ?? []).length, PROFILE_ROLES.length);
    assert.equal(existsSync(join(dir, "profiles.json")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S2: the default routing is a copy; mutating it does not change the next read", () => {
  const p = readProfile({});
  p.routing["odd-worker"]!.model = "haiku";
  assert.equal(readProfile({}).routing["odd-worker"]!.model, "sonnet");
  assert.equal(PRESETS.balanced["odd-worker"]!.model, "sonnet");
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
    assert.equal(max.routing["odd-explore"]!.model, "haiku");
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

test("S2: clear returns to the default balanced profile, not to no routing", () => {
  const dir = tmp();
  try {
    useProfile("max", { dataDir: dir });
    clearProfile({ dataDir: dir });
    assert.deepEqual(readProfile({ dataDir: dir }), { active: "balanced", routing: BALANCED });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S2: corrupt or unknown stored state reads as balanced; invalid entries in a custom profile fall back to balanced", () => {
  const dir = tmp();
  try {
    const file = join(dir, "profiles.json");
    for (const raw of ["{{{", "", "null", "[]"]) {
      writeFileSync(file, raw);
      assert.deepEqual(readProfile({ dataDir: dir }), { active: "balanced", routing: BALANCED });
    }
    for (const data of [{}, { active: "turbo", routing: { "odd-worker": { model: "opus" } } }, { active: 5, routing: "x" }, { active: null }]) {
      writeFileSync(file, JSON.stringify({ version: 1, sessionId: "profiles", data }));
      assert.deepEqual(readProfile({ dataDir: dir }), { active: "balanced", routing: BALANCED });
    }
    writeFileSync(file, JSON.stringify({ version: 1, sessionId: "profiles", data: { active: "custom", routing: { "odd-worker": { model: "opus", effort: "zzz" }, "odd-x": { model: "opus" }, "odd-verify": { model: "evil\nmodel" } } } }));
    const p = readProfile({ dataDir: dir });
    assert.equal(p.active, "custom");
    assert.deepEqual(p.routing["odd-worker"], { model: "opus" });
    assert.deepEqual(p.routing["odd-verify"], BALANCED["odd-verify"]);
    assert.equal("odd-x" in p.routing, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an explicitly stored economy/max/custom still wins over the default", () => {
  const dir = tmp();
  try {
    useProfile("economy", { dataDir: dir });
    assert.equal(readProfile({ dataDir: dir }).active, "economy");
    assert.equal(readProfile({ dataDir: dir }).routing["review-refuter"]!.model, "sonnet");
    setRole("odd-worker", "opus", undefined, { dataDir: dir });
    const p = readProfile({ dataDir: dir });
    assert.equal(p.active, "custom");
    assert.equal(p.routing["odd-jd-judge-a"]!.model, "sonnet");
    assert.deepEqual(p.routing["odd-worker"], { model: "opus" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S2: set on the default profile starts from balanced", () => {
  const dir = tmp();
  try {
    setRole("odd-worker", "opus", "high", { dataDir: dir });
    const p = readProfile({ dataDir: dir });
    assert.equal(p.active, "custom");
    assert.deepEqual(p.routing["odd-worker"], { model: "opus", effort: "high" });
    assert.deepEqual(p.routing["odd-explore"], BALANCED["odd-explore"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("renderProfiles shows the whole balanced table including review-refuter and review-validator", () => {
  const text = renderProfiles(readProfile({}));
  assert.match(text, /^active: balanced/);
  for (const [role, model] of Object.entries(TABLE)) assert.match(text, new RegExp(`${role}\\s+${model}\\s+medium`));
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

test("S2: SessionStart without a stored profile carries the balanced profile line", () => {
  const dir = tmp();
  try {
    const out = runHook("SessionStart", JSON.stringify({ session_id: "s" }), { dataDir: dir, env: {} });
    const ctx = JSON.parse(out.stdout).hookSpecificOutput.additionalContext as string;
    assert.match(ctx, /Model profile: balanced/);
    assert.match(ctx, /odd-claude:odd-explore=haiku/);
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
    assert.match(run("show").stdout, /active: balanced[\s\S]*review-refuter\s+opus\s+medium/);
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
    assert.match(run("show").stdout, /active: balanced/);
    assert.equal(profilesCli(["list"], {}).exitCode, 0);
    assert.equal(profilesCli(["use", "max"], {}).exitCode, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
