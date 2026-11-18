import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pluginVersion } from "./version.js";

test("pluginVersion matches plugin.json and is semver", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../../.claude-plugin/plugin.json", import.meta.url), "utf8"),
  ) as { version: string };
  assert.equal(pluginVersion(), manifest.version);
  assert.match(pluginVersion(), /^\d+\.\d+\.\d+$/);
});
