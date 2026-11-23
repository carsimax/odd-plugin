// T5 (S6): skill references resolve relative to the skill directory (upstream commit 2307c5cd8).
// Every markdown link target and every backticked relative `.md` path in a skills/*/SKILL.md must exist when resolved against that skill's own directory.
// Paths meant for the user's project (docs/, .atl/, .github/) are not skill references and are skipped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SKILLS = fileURLToPath(new URL("../../skills/", import.meta.url));

const PROJECT_PATHS = /^(docs|\.atl|\.github)\//;

function referencesOf(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) out.add(m[1]);
  for (const m of text.matchAll(/`([A-Za-z0-9_.][A-Za-z0-9_./-]*\/[A-Za-z0-9_./-]+\.md)`/g)) if (!PROJECT_PATHS.test(m[1])) out.add(m[1]);
  return [...out].filter((r) => !/^(https?:|mailto:|#)/.test(r)).map((r) => r.split("#")[0]).filter(Boolean);
}

test("every relative reference in skills/*/SKILL.md resolves against its own skill directory", () => {
  const broken: string[] = [];
  let checked = 0;
  for (const name of readdirSync(SKILLS, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)) {
    const file = join(SKILLS, name, "SKILL.md");
    if (!existsSync(file)) continue;
    for (const ref of referencesOf(readFileSync(file, "utf8"))) {
      checked++;
      if (!existsSync(join(SKILLS, name, ref))) broken.push(`${name}/SKILL.md -> ${ref}`);
    }
  }
  assert.ok(checked > 0, "no skill references were found; the scanner is broken");
  assert.deepEqual(broken, []);
});
