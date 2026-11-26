import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectOddPlugin, migrateFromPlugin, migratePluginState, pluginDataDir } from "./plugin-migration.js";
import type { McpRunner } from "./mcp.js";

const env = { CLAUDE_CONFIG_DIR: "/tmp/cfg" } as NodeJS.ProcessEnv;
type Reply = { code: number; stdout?: string; stderr?: string };
function fake(replies: Record<string, Reply>) {
  const calls: string[][] = [];
  const runner: McpRunner = (cmd, args) => {
    assert.equal(cmd, "claude");
    calls.push(args);
    const r = replies[args.join(" ")] ?? { code: 1, stderr: "unknown command" };
    return { code: r.code, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  return { runner, calls };
}

test("detectOddPlugin lists plugins with --json and keeps ids starting with odd-claude@", async () => {
  const f = fake({ "plugin list --json": { code: 0, stdout: JSON.stringify([{ id: "odd-claude@odd-plugin", scope: "user" }, { id: "other@x" }, { id: "odd-claude@local" }, { id: "x-odd-claude@y" }]) } });
  const r = await detectOddPlugin(f.runner, env);
  assert.deepEqual(r, { ok: true, ids: ["odd-claude@odd-plugin", "odd-claude@local"] });
  assert.deepEqual(f.calls, [["plugin", "list", "--json"]]);
});

test("detectOddPlugin reports failures and garbage instead of throwing", async () => {
  assert.equal((await detectOddPlugin(fake({ "plugin list --json": { code: 1, stderr: "nope" } }).runner, env)).ok, false);
  const bad = await detectOddPlugin(fake({ "plugin list --json": { code: 0, stdout: "not json" } }).runner, env);
  assert.equal(bad.ok, false);
  const throwing = await detectOddPlugin(() => {
    throw new Error("spawn claude ENOENT");
  }, env);
  assert.deepEqual(throwing, { ok: false, error: "claude plugin list --json failed: spawn claude ENOENT" });
});

test("migrateFromPlugin uninstalls each id then removes the odd-claude marketplace when listed", async () => {
  const f = fake({
    "plugin uninstall odd-claude@odd-plugin": { code: 0 },
    "plugin marketplace list --json": { code: 0, stdout: JSON.stringify([{ name: "odd-claude" }, { name: "other" }]) },
    "plugin marketplace remove odd-claude": { code: 0 },
  });
  const r = await migrateFromPlugin(f.runner, ["odd-claude@odd-plugin"], env);
  assert.deepEqual(f.calls, [["plugin", "uninstall", "odd-claude@odd-plugin"], ["plugin", "marketplace", "list", "--json"], ["plugin", "marketplace", "remove", "odd-claude"]]);
  assert.deepEqual(r.uninstalled, ["odd-claude@odd-plugin"]);
  assert.deepEqual(r.failed, []);
  assert.equal(r.marketplace, "removed");
});

test("migrateFromPlugin reports a failed uninstall, skips the marketplace and never throws", async () => {
  const f = fake({ "plugin uninstall a@b": { code: 1, stderr: "denied" }, "plugin uninstall odd-claude@c": { code: 0 } });
  const r = await migrateFromPlugin(f.runner, ["a@b", "odd-claude@c"], env);
  assert.deepEqual(r.uninstalled, ["odd-claude@c"]);
  assert.deepEqual(r.failed, [{ id: "a@b", error: "denied" }]);
  assert.equal(r.marketplace, "skipped");
  assert.equal(f.calls.some((c) => c[1] === "marketplace"), false);
  const t = await migrateFromPlugin(() => {
    throw new Error("boom");
  }, ["x@y"], env);
  assert.equal(t.failed[0].error, "boom");
});

test("marketplace states: absent, and unsupported when the list command fails", async () => {
  const absent = await migrateFromPlugin(fake({ "plugin marketplace list --json": { code: 0, stdout: "[]" } }).runner, [], env);
  assert.equal(absent.marketplace, "absent");
  const unsupported = await migrateFromPlugin(fake({}).runner, [], env);
  assert.equal(unsupported.marketplace, "unsupported");
});

test("pluginDataDir lists ~/.claude/plugins/data/odd-claude-* candidates only", () => {
  const home = mkdtempSync(join(tmpdir(), "odd-pm-"));
  try {
    assert.deepEqual(pluginDataDir(home), []);
    const base = join(home, ".claude", "plugins", "data");
    mkdirSync(join(base, "odd-claude-odd-plugin"), { recursive: true });
    mkdirSync(join(base, "odd-claude-local"));
    mkdirSync(join(base, "other-plugin"));
    assert.deepEqual(pluginDataDir(home), [join(base, "odd-claude-local"), join(base, "odd-claude-odd-plugin")]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("migratePluginState copies only the known state files and never overwrites existing ones", () => {
  const root = mkdtempSync(join(tmpdir(), "odd-pm-"));
  try {
    const from = join(root, "from");
    const to = join(root, "to");
    mkdirSync(from);
    mkdirSync(to);
    writeFileSync(join(from, "profiles.json"), "OLD-PROFILES");
    writeFileSync(join(from, "persona.json"), "OLD-PERSONA");
    writeFileSync(join(from, "delegation.json"), "OLD-DELEG");
    writeFileSync(join(from, "random.json"), "NOPE");
    writeFileSync(join(to, "persona.json"), "NEW-PERSONA");
    const r = migratePluginState(from, to);
    assert.deepEqual(r.copied.sort(), ["delegation.json", "profiles.json"]);
    assert.deepEqual(r.skipped, ["persona.json"]);
    assert.equal(readFileSync(join(to, "persona.json"), "utf8"), "NEW-PERSONA");
    assert.equal(readFileSync(join(to, "profiles.json"), "utf8"), "OLD-PROFILES");
    assert.deepEqual(readdirSync(to).sort(), ["delegation.json", "persona.json", "profiles.json"]);
    assert.deepEqual(migratePluginState(join(root, "missing"), to), { copied: [], skipped: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
