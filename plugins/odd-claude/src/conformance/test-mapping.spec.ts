import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// Compiled to dist-test/conformance/, so the package root is two levels up.
const PKG = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DOC = join(PKG, "..", "..", "docs", "contracts", "test-mapping.md");
const ROOTS = ["src", "tui/src"];

function specs(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) specs(p, out);
    else if (/\.spec\.tsx?$/.test(e.name)) out.push(relative(PKG, p));
  }
  return out;
}

function rows(): string[][] {
  assert.ok(existsSync(DOC), "docs/contracts/test-mapping.md is missing");
  return readFileSync(DOC, "utf8")
    .split("\n")
    .filter((l) => /^\| `[^`]+\.spec\.tsx?`/.test(l))
    .map((l) => l.split("|").slice(1, -1).map((c) => c.trim()));
}

test("mapped files equal the spec files on disk outside src/contract", () => {
  const disk = ROOTS.flatMap((r) => specs(join(PKG, r)))
    .filter((f) => !f.startsWith("src/contract/"))
    .sort();
  const mapped = [...new Set(rows().map((r) => r[0]!.replace(/`/g, "")))].sort();
  assert.deepEqual(mapped, disk);
});

test("every row has a valid disposition, a reason, and a phase when ported", () => {
  for (const [file, disposition, reason, phase] of rows()) {
    assert.match(disposition!, /^(port|replace|drop)$/, `${file}: disposition`);
    assert.ok(reason, `${file}: reason`);
    if (disposition === "port") assert.match(phase!, /^[2-8]$/, `${file}: phase`);
  }
});
