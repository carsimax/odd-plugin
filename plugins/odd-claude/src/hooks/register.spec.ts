import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PRESETS } from "../lib/profiles.js";

// hooks/register.ts is a mod (static relative imports only), so it embeds a copy of the balanced table (its fallback).
const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "hooks", "register.ts"), "utf8");

function embeddedTable(): Record<string, string> {
  const m = /const BALANCED_MODELS[^=]*=\s*\{([\s\S]*?)\};/.exec(source);
  assert.ok(m, "register.ts must define `const BALANCED_MODELS = {...}`");
  const out: Record<string, string> = {};
  for (const e of m[1]!.matchAll(/['"]([\w-]+)['"]\s*:\s*['"](\w+)['"]/g)) out[e[1]!] = e[2]!;
  return out;
}

test("S2: register.ts embedded balanced fallback table equals the balanced preset of profiles.ts", () => {
  const expected = Object.fromEntries(Object.entries(PRESETS.balanced).map(([role, r]) => [role, r.model]));
  assert.deepEqual(embeddedTable(), expected);
});

test("S2: register.ts still reads profiles.json and never refuses a spawn", () => {
  assert.match(source, /profiles\.json/);
  assert.doesNotMatch(source, /\bdeny\s*:/);
});
