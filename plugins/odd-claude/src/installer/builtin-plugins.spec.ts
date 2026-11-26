import { test } from "node:test";
import assert from "node:assert/strict";
import { builtinPluginChanges, discoverBuiltinPlugins } from "./builtin-plugins.js";
import type { McpRunner } from "./mcp.js";

const REAL = JSON.stringify([
  { id: "cc-plugin-agents-md@builtin", version: "unknown", scope: "user", enabled: false, hasUserConfig: true },
  { id: "cc-plugin-sec-default@builtin", scope: "managed", enabled: true },
  { id: "cc-plugin-privacy@builtin", scope: "user", enabled: true },
  { id: "corp-guard@builtin", scope: "managed", enabled: true },
  { id: "other@marketplace", scope: "user", enabled: true },
  { id: "plain", scope: "user" },
]);
const ok = (stdout: string): McpRunner => () => ({ code: 0, stdout, stderr: "" });

test("discovery runs `claude plugin list --json` and keeps only @builtin entries", async () => {
  let seen: { cmd: string; args: string[] } | undefined;
  const runner: McpRunner = (cmd, args) => {
    seen = { cmd, args };
    return { code: 0, stdout: REAL, stderr: "" };
  };
  const r = await discoverBuiltinPlugins(runner);
  assert.deepEqual(seen, { cmd: "claude", args: ["plugin", "list", "--json"] });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(
    r.plugins.map((p) => [p.id, p.protected]),
    [
      ["cc-plugin-agents-md@builtin", false],
      ["cc-plugin-sec-default@builtin", true],
      ["cc-plugin-privacy@builtin", false],
      ["corp-guard@builtin", true],
    ],
  );
});

test("discovery passes the env to the runner", async () => {
  let env: NodeJS.ProcessEnv | undefined;
  await discoverBuiltinPlugins((_c, _a, o) => {
    env = o.env;
    return { code: 0, stdout: "[]", stderr: "" };
  }, { X: "1" });
  assert.deepEqual(env, { X: "1" });
});

test("discovery failures return ok:false with an error", async () => {
  const runners: McpRunner[] = [
    () => ({ code: 1, stdout: "", stderr: "boom\nmore" }),
    () => ({ code: null, stdout: "", stderr: "" }),
    ok("not json"),
    ok('{"a":1}'),
    () => {
      throw new Error("spawn claude ENOENT");
    },
  ];
  for (const runner of runners) {
    const r = await discoverBuiltinPlugins(runner);
    assert.equal(r.ok, false);
    if (!r.ok) assert.ok(r.error.length > 0);
  }
  const r = await discoverBuiltinPlugins(() => ({ code: 1, stdout: "", stderr: "boom\nmore" }));
  assert.equal(r.ok === false && r.error, "claude plugin list failed: boom");
});

async function found() {
  const r = await discoverBuiltinPlugins(ok(REAL));
  if (!r.ok) throw new Error("unexpected");
  return r.plugins;
}

test("mode all disables every non-protected builtin, never the protected ones", async () => {
  const r = builtinPluginChanges(await found(), { mode: "all" });
  assert.deepEqual(r.changes, [
    { path: ["enabledPlugins", "cc-plugin-agents-md@builtin"], value: false },
    { path: ["enabledPlugins", "cc-plugin-privacy@builtin"], value: false },
  ]);
  assert.deepEqual(r.unknown, []);
  assert.deepEqual(r.protectedSkipped, []);
});

test("mode keep changes nothing", async () => {
  assert.deepEqual(builtinPluginChanges(await found(), { mode: "keep" }), { changes: [], unknown: [], protectedSkipped: [] });
});

test("subset disables only the chosen ids, reports unknown and protected ids", async () => {
  const r = builtinPluginChanges(await found(), { mode: "subset", ids: ["cc-plugin-privacy@builtin", "nope@builtin", "cc-plugin-sec-default@builtin", "other@marketplace"] });
  assert.deepEqual(r.changes, [{ path: ["enabledPlugins", "cc-plugin-privacy@builtin"], value: false }]);
  assert.deepEqual(r.unknown, ["nope@builtin", "other@marketplace"]);
  assert.deepEqual(r.protectedSkipped, ["cc-plugin-sec-default@builtin"]);
});
