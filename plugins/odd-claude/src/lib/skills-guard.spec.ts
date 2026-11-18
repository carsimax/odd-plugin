import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const skillsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "skills");
const ALLOWED_VARS = ["CLAUDE_PLUGIN_ROOT", "CLAUDE_PLUGIN_DATA", "CLAUDE_SESSION_ID"];
// Argument substitutions the skill loader expands into the command text.
const ARG_REF = /\$ARGUMENTS|\$\{?ARGUMENTS|\$\d|\$\{?\d|\$\{?[A-Za-z_]+\[|\$name/;

const skills = readdirSync(skillsDir).filter((d) => existsSync(join(skillsDir, d, "SKILL.md")));

test("there are skills to guard", () => {
  assert.ok(skills.length >= 4);
});

for (const name of skills) {
  test(`skill ${name}: no user argument text or foreign variable reaches a \`!\` injected command`, () => {
    const lines = readFileSync(join(skillsDir, name, "SKILL.md"), "utf8").split("\n");
    // Injection lines start with !` (inline form); fenced ```! blocks are checked too.
    let fenced = false;
    for (const l of lines) {
      if (/^```!/.test(l.trim())) { fenced = true; continue; }
      if (fenced && l.trim().startsWith("```")) { fenced = false; continue; }
      const isBang = fenced || /(^|\s)!`/.test(l);
      if (!isBang) continue;
      assert.doesNotMatch(l, ARG_REF, `${name}: ${l}`);
      for (const m of l.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)) {
        assert.ok(ALLOWED_VARS.includes(m[1]!), `${name}: unexpected variable ${m[1]} in: ${l}`);
      }
    }
  });
}
