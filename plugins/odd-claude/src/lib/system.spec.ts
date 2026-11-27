import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realInstalledPlugins } from "./system.js";

test("S22: realInstalledPlugins reads <CLAUDE_CONFIG_DIR>/plugins/installed_plugins.json", () => {
  const cfg = mkdtempSync(join(tmpdir(), "odd-sys-"));
  try {
    mkdirSync(join(cfg, "plugins"));
    writeFileSync(join(cfg, "plugins", "installed_plugins.json"), JSON.stringify({ plugins: { "a@b": [] } }));
    assert.deepEqual(realInstalledPlugins({ CLAUDE_CONFIG_DIR: cfg }), ["a@b"]);
  } finally {
    rmSync(cfg, { recursive: true, force: true });
  }
});
