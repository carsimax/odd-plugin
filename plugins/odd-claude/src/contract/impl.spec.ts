// The positive control and the isolation rule of the contract suite.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { entry, IMPL, PLUGIN_ROOT } from "./impl.testkit.js";

const CONTRACT_SRC = join(PLUGIN_ROOT, "src", "contract");

// The run names the implementation it exercises, so a green run can never be mistaken for another implementation's.
test(`ODD_IMPL=${IMPL}`, () => {
  assert.ok(["ts", "py"].includes(IMPL), `ODD_IMPL must be ts or py, got ${IMPL}`);
});

test("the resolver names the missing entry when the implementation has none (py) and resolves every entry for ts", () => {
  const names = ["coordinator", "setup", "status", "review-mode", "hook-runner", "review-server", "check-naming"] as const;
  for (const n of names) {
    if (IMPL === "py") assert.throws(() => entry(n), new RegExp(`ODD_IMPL=py: no Python entry for "${n}"`));
    else assert.ok(entry(n).args.length > 0, n);
  }
});

test("no file under src/contract imports a path outside src/contract other than node:*", () => {
  const files = readdirSync(CONTRACT_SRC).filter((f) => f.endsWith(".ts"));
  assert.ok(files.length > 5, `contract files found: ${files}`);
  const offenders: string[] = [];
  for (const f of files) {
    const text = readFileSync(join(CONTRACT_SRC, f), "utf8");
    // a from clause, a bare side-effect import statement and a dynamic import call
    const specifiers = [/\bfrom\s+["']([^"']+)["']/g, /^\s*import\s+["']([^"']+)["']/gm, /\bimport\(\s*["']([^"']+)["']\s*\)/g].flatMap((re) => [...text.matchAll(re)].map((m) => m[1]!));
    for (const spec of specifiers) {
      if (spec.startsWith("node:")) continue;
      const inside = spec.startsWith(".") && !relative(CONTRACT_SRC, resolve(CONTRACT_SRC, spec)).startsWith("..");
      if (!inside) offenders.push(`${f} imports ${spec}`);
    }
  }
  assert.deepEqual(offenders, []);
});
