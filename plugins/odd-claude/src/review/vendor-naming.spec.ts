import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { PLUGIN_ROOT, REPO_ROOT, VENDOR_ROOT } from "./fixtures.testkit.js";

// Forbidden words are assembled at runtime so this file passes its own check.
const G = "gen" + "tle";
const script = join(PLUGIN_ROOT, "scripts", "check-naming.mjs");

test("the plugin tree passes the naming check (the vendored corpus is outside it)", () => {
  const r = spawnSync(process.execPath, [script, PLUGIN_ROOT], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(join(PLUGIN_ROOT, "test-fixtures")), false);
});

test("SOURCES.md records upstream commits, paths, and MIT attribution", () => {
  const md = readFileSync(join(REPO_ROOT, "test-fixtures", "review", "SOURCES.md"), "utf8");
  assert.match(md, /08317b9589598f99ebcc00498c39a60f352f05e4/);
  assert.match(md, /39a01a53a11f8d74d3d4884669a320a607381dec/);
  assert.match(md, /MIT/);
  assert.match(md, /contracts\/review-integration\/v2/);
  assert.match(md, /review-provider-contract-mirror\/v1\.6\.0/);
  for (const line of md.split("\n")) if (new RegExp(G + "[-_]", "i").test(line)) assert.match(line, /odd-check: allow/, line);
  assert.equal(existsSync(join(VENDOR_ROOT, "review-integration", "LICENSE")), true);
  assert.equal(existsSync(join(VENDOR_ROOT, "provider-mirror", "LICENSE")), true);
});
