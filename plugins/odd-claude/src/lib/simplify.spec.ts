import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sessionStart } from "../hooks/session-start.js";

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

// T2 (S1, S3, S4): the banner, the themes and the statusline are gone; the `odd` output style stays.
test("the themes directory, the banner and the statusline skills, CLIs, libs and dist files are absent", () => {
  assert.equal(existsSync(join(root, "themes")), false);
  for (const s of ["banner"]) assert.equal(existsSync(join(root, "skills", s)), false, `skills/${s}`);
  for (const f of ["cli/banner", "lib/banner", "cli/statusline", "lib/statusline", "cli/setup-statusline", "lib/setup-statusline"]) {
    for (const ext of ["ts", "spec.ts"]) assert.equal(existsSync(join(root, "src", `${f}.${ext}`)), false, `src/${f}.${ext}`);
    assert.equal(existsSync(join(root, "dist", `${f}.js`)), false, `dist/${f}.js`);
  }
  assert.equal(existsSync(join(root, "src", "hooks", "session-start-shim.spec.ts")), false);
});

test("the `odd` output style stays", () => {
  assert.ok(existsSync(join(root, "output-styles", "odd.md")));
});

test("setup has no statusline subcommand, flag or shim", () => {
  const cli = read("src", "cli", "setup.ts");
  const lib = read("src", "lib", "setup.ts") + read("src", "lib", "setup-fs.ts");
  assert.doesNotMatch(cli + lib, /statusline|statusLine/i);
  assert.doesNotMatch(read("skills", "setup", "SKILL.md"), /statusline|statusLine/i);
  const r = spawnSync(process.execPath, [join(root, "dist", "cli", "setup.js"), "--statusline", "on"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown argument --statusline/);
  assert.equal(r.stdout, "");
});

test("SessionStart emits no banner systemMessage, on startup or any other source", () => {
  const dir = mkdtempSync(join(tmpdir(), "odd-simplify-"));
  try {
    for (const source of ["startup", "resume", "clear", "compact"]) {
      const out = sessionStart({ hook_event_name: "SessionStart", session_id: "s1", source }, { dataDir: dir, env: {} });
      assert.equal(Object.hasOwn(out, "systemMessage"), false, source);
      assert.ok(out.hookSpecificOutput, source);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the README and the plugin manifest do not offer the removed features", () => {
  const readme = read("README.md");
  for (const re of [/\/odd-claude:banner/, /setup statusline/, /statusline on/, /^## Themes/m, /themes\/odd/, /ODD_CLAUDE_NO_BANNER/]) assert.doesNotMatch(readme, re);
  assert.doesNotMatch(read(".claude-plugin", "plugin.json"), /theme/i);
});
