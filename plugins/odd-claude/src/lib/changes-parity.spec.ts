import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { summarizeChanges } from "./changes.js";
import { cleanText } from "./statusline.js";

test("changes: no escape-sequence residue in names", () => {
  for (const s of ["## main\0?? a\u001b]0;T\u0007b\0", "## main\0?? a\u001b[31mR\0"])
    assert.doesNotMatch(summarizeChanges(s, undefined), /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]|\]0;|\[31m/);
});

test("changes: names render exactly as the sanitized text (OSC/CSI removed whole)", () => {
  assert.equal(summarizeChanges("## main\0?? a\u001b]0;T\u0007b\0", undefined), "odd-claude changes · branch main\n?? ab\n1 changed, 1 untracked");
  assert.equal(summarizeChanges("## main\0?? a\u001b[31mR\0", undefined), "odd-claude changes · branch main\n?? aR\n1 changed, 1 untracked");
});

// The mod (hooks/register.ts) repeats cleanText because mods allow only static relative imports: the three
// replace() patterns of both copies must stay identical.
function patterns(src: string, from: string): string[] {
  const body = src.slice(src.indexOf(from));
  return [...body.slice(0, 1200).matchAll(/\.replace\((\/.+?\/g), ["']{2}\)/g)].map((m) => m[1]!);
}

test("the mod's cleaner is the same as the lib's cleanText", () => {
  const lib = patterns(readFileSync(join("src", "lib", "statusline.ts"), "utf8"), "export function cleanText");
  const mod = patterns(readFileSync(join("hooks", "register.ts"), "utf8"), "function cleanText");
  assert.equal(lib.length, 3);
  assert.deepEqual(mod, lib);
  assert.equal(cleanText("x\u001b]0;T\u0007y"), "xy");
});
