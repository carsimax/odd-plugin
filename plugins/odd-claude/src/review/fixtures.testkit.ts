// Test-only helpers (excluded from the dist build by tsconfig.json): locate and load the
// vendored upstream contract assets under <repo>/test-fixtures/review/vendor. The corpus lives at the
// repo root, outside plugins/odd-claude, so Claude Code never installs it with the plugin.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Compiled location: <plugin>/dist-test/review/fixtures.testkit.js
export const PLUGIN_ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
export const VENDOR_ROOT = join(REPO_ROOT, "test-fixtures", "review", "vendor");
export const INTEGRATION_ROOT = join(VENDOR_ROOT, "review-integration");
export const MIRROR_ROOT = join(VENDOR_ROOT, "provider-mirror", "v1.6.0");

export function vendorPath(...parts: string[]): string {
  return join(VENDOR_ROOT, ...parts);
}

export function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8"));
}

export function listFiles(dir: string, suffix: string): string[] {
  return readdirSync(dir).filter((f) => f.endsWith(suffix)).sort().map((f) => join(dir, f));
}

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
