import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyExtras, DEFAULT_EXTRAS, planExtras, removeExtras } from "./extras.js";
import type { McpRunner } from "./mcp.js";

const LIST = JSON.stringify([
  { id: "a@builtin", scope: "user", enabled: true },
  { id: "b@builtin", scope: "user", enabled: true },
  { id: "cc-plugin-sec-default@builtin", scope: "managed", enabled: true },
]);
const runner: McpRunner = () => ({ code: 0, stdout: LIST, stderr: "" });
const failing: McpRunner = () => ({ code: 1, stdout: "", stderr: "no auth" });

function sandbox(initial?: object) {
  const dir = mkdtempSync(join(tmpdir(), "odd-extras-"));
  const settingsPath = join(dir, "settings.json");
  if (initial) writeFileSync(settingsPath, JSON.stringify(initial));
  const paths = { settingsPath, statePath: join(dir, "odd", "settings-state.json"), backupDir: join(dir, "odd", "backups") };
  return { paths, read: () => JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const ROOT = "/h/.odd-claude/current";

test("defaults: status line on, all claude.ai syncs disabled, builtin mode all", () => {
  assert.deepEqual(DEFAULT_EXTRAS, { statusLine: true, claudeAi: { connectors: true, skills: true, plugins: true }, builtin: { mode: "all" } });
});

test("apply writes statusLine, claude.ai keys and builtin disables; remove restores previous values and deletes absent keys", async () => {
  const s = sandbox({ theme: "dark", statusLine: { type: "command", command: "mine" }, syncClaudeAiSkills: true, enabledPlugins: { "a@builtin": true, "user@mkt": true } });
  try {
    const r = await applyExtras({ paths: s.paths, oddRoot: ROOT, options: DEFAULT_EXTRAS, runner });
    assert.equal(r.settings?.status, "applied");
    assert.deepEqual(r.warnings, []);
    assert.deepEqual(s.read(), {
      theme: "dark",
      statusLine: { type: "command", command: `bash "${ROOT}/statusline/statusline.sh"` },
      syncClaudeAiSkills: false,
      disableClaudeAiConnectors: true,
      syncClaudeAiPlugins: false,
      enabledPlugins: { "a@builtin": false, "user@mkt": true, "b@builtin": false },
    });
    const rm = removeExtras({ paths: s.paths });
    assert.equal(rm.status, "applied");
    assert.deepEqual(s.read(), { theme: "dark", statusLine: { type: "command", command: "mine" }, syncClaudeAiSkills: true, enabledPlugins: { "a@builtin": true, "user@mkt": true } });
  } finally {
    s.cleanup();
  }
});

test("remove leaves the outputStyle path alone", async () => {
  const s = sandbox({ outputStyle: "odd" });
  try {
    await applyExtras({ paths: s.paths, oddRoot: ROOT, options: { ...DEFAULT_EXTRAS, builtin: { mode: "keep" } }, runner });
    removeExtras({ paths: s.paths });
    assert.deepEqual(s.read(), { outputStyle: "odd" });
  } finally {
    s.cleanup();
  }
});

test("discovery failure skips the builtin step with a warning and still applies the rest", async () => {
  const s = sandbox({});
  try {
    const r = await applyExtras({ paths: s.paths, oddRoot: ROOT, options: DEFAULT_EXTRAS, runner: failing });
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /builtin plugins skipped: claude plugin list failed: no auth/);
    assert.equal("enabledPlugins" in s.read(), false);
    assert.equal((s.read().statusLine as { type: string }).type, "command");
  } finally {
    s.cleanup();
  }
});

test("options turn each piece off; subset with unknown id warns", async () => {
  const s = sandbox({});
  try {
    const r = await applyExtras({
      paths: s.paths,
      oddRoot: ROOT,
      options: { statusLine: false, claudeAi: { connectors: false, skills: true, plugins: false }, builtin: { mode: "subset", ids: ["b@builtin", "zzz@builtin"] } },
      runner,
    });
    assert.deepEqual(s.read(), { syncClaudeAiSkills: false, enabledPlugins: { "b@builtin": false } });
    assert.deepEqual(r.warnings, ["unknown builtin plugin ids ignored: zzz@builtin"]);
  } finally {
    s.cleanup();
  }
});

test("planExtras lists changes without writing", async () => {
  const s = sandbox({ a: 1 });
  try {
    const p = await planExtras({ oddRoot: ROOT, options: DEFAULT_EXTRAS, runner });
    assert.deepEqual(
      p.changes.map((c) => c.path.join(".")),
      ["statusLine", "disableClaudeAiConnectors", "syncClaudeAiSkills", "syncClaudeAiPlugins", "enabledPlugins.a@builtin", "enabledPlugins.b@builtin"],
    );
    assert.equal(p.builtin?.ok && p.builtin.plugins.length, 3);
    assert.deepEqual(s.read(), { a: 1 });
  } finally {
    s.cleanup();
  }
});

test("discovery is not run when builtin mode is keep", async () => {
  let calls = 0;
  const p = await planExtras({
    oddRoot: ROOT,
    options: { ...DEFAULT_EXTRAS, builtin: { mode: "keep" } },
    runner: () => {
      calls++;
      return { code: 0, stdout: "[]", stderr: "" };
    },
  });
  assert.equal(calls, 0);
  assert.equal(p.builtin, undefined);
});
