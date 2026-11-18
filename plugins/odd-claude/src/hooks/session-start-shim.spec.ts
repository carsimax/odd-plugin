import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionStart } from "./session-start.js";
import { shimSource } from "../lib/setup.js";

test("SessionStart rewrites an existing statusLine shim to the current plugin root, and never creates one", () => {
  const dir = mkdtempSync(join(tmpdir(), "odd-shim-"));
  try {
    const env = { CLAUDE_PLUGIN_DATA: dir, CLAUDE_PLUGIN_ROOT: join(dir, "root-v2") };
    sessionStart({ hook_event_name: "SessionStart", session_id: "s1" }, { dataDir: dir, env });
    assert.equal(existsSync(join(dir, "statusline.mjs")), false);
    writeFileSync(join(dir, "statusline.mjs"), shimSource(join(dir, "root-v1")));
    const out = sessionStart({ hook_event_name: "SessionStart", session_id: "s1" }, { dataDir: dir, env });
    assert.equal(readFileSync(join(dir, "statusline.mjs"), "utf8"), shimSource(join(dir, "root-v2")));
    assert.ok(out.hookSpecificOutput);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
