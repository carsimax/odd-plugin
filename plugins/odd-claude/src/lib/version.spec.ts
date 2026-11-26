import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pluginVersion } from "./version.js";

test("pluginVersion matches package.json and is semver", () => {
  const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
  assert.equal(pluginVersion(), manifest.version);
  assert.match(pluginVersion(), /^\d+\.\d+\.\d+$/);
});

test("pluginVersion reads the package.json of the given root, with no plugin.json present", () => {
  const root = mkdtempSync(join(tmpdir(), "odd-ver-"));
  try {
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "x", version: "9.8.7" }));
    assert.equal(pluginVersion(root), "9.8.7");
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "x" }));
    assert.throws(() => pluginVersion(root), /version/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
