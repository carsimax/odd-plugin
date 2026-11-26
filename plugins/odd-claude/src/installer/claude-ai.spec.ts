import { test } from "node:test";
import assert from "node:assert/strict";
import { CLAUDE_AI_DEFAULTS, claudeAiChanges } from "./claude-ai.js";

test("defaults disable all three claude.ai syncs", () => {
  assert.deepEqual(CLAUDE_AI_DEFAULTS, { connectors: true, skills: true, plugins: true });
  assert.deepEqual(claudeAiChanges(CLAUDE_AI_DEFAULTS), [
    { path: ["disableClaudeAiConnectors"], value: true },
    { path: ["syncClaudeAiSkills"], value: false },
    { path: ["syncClaudeAiPlugins"], value: false },
  ]);
});

test("each option selects only its own key", () => {
  assert.deepEqual(claudeAiChanges({ connectors: false, skills: true, plugins: false }), [{ path: ["syncClaudeAiSkills"], value: false }]);
  assert.deepEqual(claudeAiChanges({ connectors: true, skills: false, plugins: false }), [{ path: ["disableClaudeAiConnectors"], value: true }]);
  assert.deepEqual(claudeAiChanges({ connectors: false, skills: false, plugins: true }), [{ path: ["syncClaudeAiPlugins"], value: false }]);
  assert.deepEqual(claudeAiChanges({ connectors: false, skills: false, plugins: false }), []);
});
