// T1 (S3, S5, S6a): skill descriptions stay short and no skill points at the retired "odd output style" holder of the always-on rules.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SKILLS = fileURLToPath(new URL("../../skills/", import.meta.url));
const MAX_DESCRIPTION = 200;

const names = readdirSync(SKILLS, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);

function descriptionOf(text: string): string {
  const fm = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";
  const line = fm.split("\n").find((l) => l.startsWith("description:")) ?? "";
  return line.slice("description:".length).trim().replace(/^"(.*)"$/, "$1");
}

test("every skill description is at most 200 characters", () => {
  const long: string[] = [];
  for (const n of names) {
    const d = descriptionOf(readFileSync(join(SKILLS, n, "SKILL.md"), "utf8"));
    assert.ok(d.length > 0, `${n} has no description`);
    if (d.length > MAX_DESCRIPTION) long.push(`${n}: ${d.length}`);
  }
  assert.deepEqual(long, []);
});

test("no SKILL.md mentions the odd output style", () => {
  const hits = names.filter((n) => readFileSync(join(SKILLS, n, "SKILL.md"), "utf8").includes("odd output style"));
  assert.deepEqual(hits, []);
});
