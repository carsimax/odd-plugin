import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { oddClaudeRoot, moduleRoot } from "./root.js";

test("CLAUDE_PLUGIN_ROOT wins when set and non-empty", () => {
  assert.equal(oddClaudeRoot({ CLAUDE_PLUGIN_ROOT: "/opt/odd root" }), "/opt/odd root");
});

test("without the env (or empty) the root is the module-relative package root", () => {
  assert.equal(oddClaudeRoot({}), moduleRoot());
  assert.equal(oddClaudeRoot({ CLAUDE_PLUGIN_ROOT: "" }), moduleRoot());
  assert.ok(existsSync(join(moduleRoot(), "package.json")));
  assert.ok(existsSync(join(moduleRoot(), "agents")));
});
