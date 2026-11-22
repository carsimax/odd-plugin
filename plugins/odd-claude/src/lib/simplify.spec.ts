import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Simplify (odd/tasks/simplify.md, S1, S2, S4): the visual mod and the agents/changes/quiet commands are gone.
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (...p: string[]) => readFileSync(join(root, ...p), "utf8");

test("hooks.json declares no `modules` key and hooks/register.ts does not exist", () => {
  const cfg = JSON.parse(read("hooks", "hooks.json")) as Record<string, unknown>;
  assert.equal(Object.hasOwn(cfg, "modules"), false);
  assert.equal(existsSync(join(root, "hooks", "register.ts")), false);
  for (const f of ["register.test.ts", "probe.test.ts", "close.test.ts"]) assert.equal(existsSync(join(root, "hooks", f)), false, f);
});

test("every normal hook event is still registered", () => {
  const cfg = JSON.parse(read("hooks", "hooks.json")) as { hooks: Record<string, unknown> };
  for (const e of ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "StopFailure", "Stop", "SessionEnd", "SubagentStart", "SubagentStop"]) {
    assert.ok(cfg.hooks[e], e);
  }
});

test("the agents, changes and quiet skills, CLIs and libs are absent", () => {
  for (const s of ["agents", "changes", "quiet"]) assert.equal(existsSync(join(root, "skills", s)), false, `skills/${s}`);
  for (const f of ["cli/agents", "cli/changes", "cli/quiet", "lib/changes", "lib/quiet"]) {
    for (const ext of ["ts", "spec.ts"]) assert.equal(existsSync(join(root, "src", `${f}.${ext}`)), false, `src/${f}.${ext}`);
    assert.equal(existsSync(join(root, "dist", `${f}.js`)), false, `dist/${f}.js`);
  }
  assert.equal(existsSync(join(root, "src", "lib", "changes-parity.spec.ts")), false);
});

test("the subagent recording stays (stats reads it) but has no agents-table renderer", () => {
  assert.ok(existsSync(join(root, "src", "lib", "subagents.ts")));
  assert.doesNotMatch(read("src", "lib", "subagents.ts"), /renderSubagents|AGENTS_SCHEMA/);
});

test("the README does not document the removed commands or the mod", () => {
  const readme = read("README.md");
  for (const re of [/\/odd-claude:agents/, /\/odd-claude:changes/, /\/odd-claude:quiet/, /\/odd-agents/, /\/odd-changes/, /agent\.spawn/, /hooks\/register\.ts/, /Enabling mods/]) {
    assert.doesNotMatch(readme, re);
  }
});

test("profiles apply through the SessionStart context line, not through a mod", () => {
  const src = read("src", "lib", "profiles.ts");
  assert.doesNotMatch(src, /agent\.spawn|register\.ts|non-mod/);
});
