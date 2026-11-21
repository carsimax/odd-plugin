import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deliveryCommand, parseInvocation } from "./odd.js";

test("an invocation string becomes the tool's own snake_case arguments, with shell quoting undone", () => {
  const p = parseInvocation("review_answer_consent --contract c/v2 --cwd '/tmp/a b/repo' --target-identity sha256:abc --consent-binding sha256:def --consent granted --lenses 'risk,readability'");
  assert.equal(p.tool, "review_answer_consent");
  assert.deepEqual(p.args, { contract: "c/v2", cwd: "/tmp/a b/repo", target_identity: "sha256:abc", consent_binding: "sha256:def", consent: "granted", lenses: "risk,readability" });
  assert.deepEqual(parseInvocation("review_status").args, {});
});

test("delivery commands are plain data assembled from fragments: they name the delivery the gate must recognize and nothing else", () => {
  assert.equal(deliveryCommand("push"), ["git", "push", "origin", "main"].join(" "));
  assert.equal(deliveryCommand("prOpen"), ["gh", "pr", "create", "--base", "main", "--fill"].join(" "));
});

test("no bench source holds a delivery command as one literal, and none executes one through a shell", () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "../../src");
  const files = ["subjects/odd.ts", "journey.ts", "journeys/gate.ts", "journeys/fixtures.ts", "sandbox.ts"];
  const literal = new RegExp([["git", "push"].join(" "), ["gh", "pr", "create"].join(" "), ["gh", "pr", "merge"].join(" ")].join("|"));
  for (const f of files) {
    const text = readFileSync(join(dir, f), "utf8");
    assert.equal(literal.test(text), false, `${f} holds a delivery command literal`);
    assert.equal(/execSync|spawnSync\(\s*["'`]sh|shell:\s*true/.test(text.replace(/execFileSync/g, "")), false, `${f} runs a shell`);
  }
});

// ---- hooks must not fail silently ----
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { hookFailure, oddSubject } from "./odd.js";
import { runJourney, toJourney, type JourneyDef, type Subject } from "../journey.js";

test("hookFailure: a clean exit is fine; a crash, a timeout or a kill is named", () => {
  const r = (over: Partial<{ code: number | null; timedOut: boolean }>) => ({ code: 0, stdout: "", stderr: "", timedOut: false, ms: 1, ...over });
  assert.equal(hookFailure("Stop", r({})), undefined);
  assert.match(hookFailure("Stop", r({ code: 3 }))!, /Stop hook exited with code 3/);
  assert.match(hookFailure("PreToolUse", r({ timedOut: true, code: null }))!, /PreToolUse hook timed out/);
  assert.match(hookFailure("Stop", r({ code: null }))!, /Stop hook was killed/);
});

test("a hook that crashes or is missing fails the journey; it never counts as allow or silent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "odd-bench-hook-"));
  const crash = join(dir, "crash.js");
  writeFileSync(crash, "process.stderr.write('boom'); process.exit(3);");
  const gate: JourneyDef = { id: "gate-crash", description: "", fixture: { change: "none" }, steps: [{ do: { kind: "gateCheck", command: "push" }, expect: { outcome: "allow", gate: "allow" } }] };
  const stop: JourneyDef = { id: "stop-crash", description: "", fixture: { change: "none" }, steps: [{ do: { kind: "stopHook" }, expect: { outcome: "silent" } }] };
  const withHooks = (hooks: string): Subject => ({ name: "odd", open: (env, f) => oddSubject.open({ ...env, plugin: { ...env.plugin, hooks } }, f) });
  try {
    for (const [def, event] of [[gate, "PreToolUse"], [stop, "Stop"]] as const) {
      const crashed = await runJourney(toJourney(def, withHooks(crash)));
      assert.equal(crashed.status, "failed", `${def.id}: ${JSON.stringify(crashed)}`);
      assert.match(crashed.reason ?? "", new RegExp(`${event} hook exited with code 3`));
      const missing = await runJourney(toJourney(def, withHooks(join(dir, "does-not-exist.js"))));
      assert.equal(missing.status, "failed", `${def.id}: ${JSON.stringify(missing)}`);
      assert.match(missing.reason ?? "", new RegExp(`${event} hook exited with code 1`));
    }
    const garbled = join(dir, "garbled.js");
    writeFileSync(garbled, "process.stdout.write('not json')");
    const row = await runJourney(toJourney(gate, withHooks(garbled)));
    assert.equal(row.status, "failed");
    assert.match(row.reason ?? "", /PreToolUse hook printed non-JSON/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
