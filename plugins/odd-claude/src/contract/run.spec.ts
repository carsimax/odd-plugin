// Black-box tests of the hook runner entry, moved from hooks/run.spec.ts (the in-process dispatcher tests stay there).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./impl.testkit.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "odd-run-"));
}

test("CLI: SessionStart fixture records session start in state and emits context", () => {
  const dir = tmp();
  try {
    const r = run("hook-runner", ["SessionStart"], {
      input: JSON.stringify({ session_id: "sess-1", hook_event_name: "SessionStart", source: "startup" }),
      env: { ...process.env, CLAUDE_PLUGIN_DATA: dir },
    });
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
    assert.match(out.hookSpecificOutput.additionalContext, /Coordinator mode: ON/);
    // the session state file: { version, data }
    const state = JSON.parse(readFileSync(join(dir, "sessions", "sess-1.json"), "utf8")).data;
    assert.equal(typeof state.startedAt, "string");
    assert.equal(state.source, "startup");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: unknown event and missing data dir env exit 0 (the home default is used)", () => {
  const home = mkdtempSync(join(tmpdir(), "odd-run-home-"));
  const env: NodeJS.ProcessEnv = { ...process.env, ODD_CLAUDE_HOME: home };
  delete env.CLAUDE_PLUGIN_DATA;
  delete env.ODD_CLAUDE_DATA;
  const a = run("hook-runner", ["Nope"], { input: "{}", env });
  assert.equal(a.status, 0);
  assert.equal(a.stdout, "");
  const b = run("hook-runner", ["SessionStart"], { input: '{"session_id":"x"}', env });
  assert.equal(b.status, 0);
  assert.match(JSON.parse(b.stdout).hookSpecificOutput.additionalContext, /Coordinator mode: ON/);
  assert.ok(existsSync(join(home, "data")), "state went to ODD_CLAUDE_HOME/data");
  rmSync(home, { recursive: true, force: true });
});
