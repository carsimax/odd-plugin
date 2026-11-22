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

test("package.json, package-lock and marketplace versions equal plugin.json", () => {
  const read = (rel: string): any => JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));
  const expected = pluginVersion();
  assert.equal(read("../../package.json").version, expected);
  const lock = read("../../package-lock.json");
  assert.equal(lock.version, expected);
  assert.equal(lock.packages[""].version, expected);
  const entry = read("../../../../.claude-plugin/marketplace.json").plugins.find((p: { name: string }) => p.name === "odd-claude");
  assert.ok(entry, "marketplace entry odd-claude exists");
  assert.equal(entry.version, expected);
});
