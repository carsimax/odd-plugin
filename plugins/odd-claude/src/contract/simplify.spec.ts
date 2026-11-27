// Black-box tests moved from lib/simplify.spec.ts: the setup CLI rejects the removed statusline flags, the hook runner still feeds stats.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./impl.testkit.js";

// The source-text half of "setup has no statusline subcommand, flag or shim" stays in lib/simplify.spec.ts.
test("setup rejects --statusline on as an unknown argument: exit 2, error on stderr, nothing on stdout", () => {
  const r = run("setup", ["--statusline", "on"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown argument --statusline/);
  assert.equal(r.stdout, "");
});

test("setup rejects the removed statusline flags without touching settings (S3)", () => {
  const dir = mkdtempSync(join(tmpdir(), "odd-simplify-setup-"));
  try {
    const st = join(dir, "settings.json");
    const body = '{\n  "statusLine": {"type":"command","command":"x"}\n}\n';
    writeFileSync(st, body);
    for (const args of [["--statusline", "on", "--apply"], ["--replace-statusline"], ["--plugin-root", dir]]) {
      const r = run("setup", [...args, "--settings", st, "--data-dir", dir]);
      assert.equal(r.status, 2, args.join(" "));
      assert.match(r.stderr, new RegExp(`unknown argument ${args[0]}`));
      assert.equal(readFileSync(st, "utf8"), body);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("SubagentStart/Stop still feed stats through the hook runner (S2, S4)", () => {
  const dir = mkdtempSync(join(tmpdir(), "odd-simplify-stats-"));
  try {
    const env = { ...process.env, CLAUDE_PLUGIN_DATA: dir };
    const hook = (ev: string, id: string) => run("hook-runner", [ev], { input: JSON.stringify({ hook_event_name: ev, session_id: "s1", agent_id: id, agent_type: "odd-claude:odd-worker" }), env });
    assert.equal(hook("SubagentStart", "a1").status, 0);
    assert.equal(hook("SubagentStart", "a2").status, 0);
    assert.equal(hook("SubagentStop", "a1").status, 0);
    const r = run("stats", ["--session", "s1", "--data-dir", dir]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /2 subagents \(1 running\)/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
