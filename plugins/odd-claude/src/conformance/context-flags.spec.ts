// T6 (S7b, S7e): read-only bounded agents skip the always-on CLAUDE.md; user-only skills are hidden from model invocation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

function frontmatter(rel: string): string {
  const m = /^---\n([\s\S]*?)\n---/.exec(readFileSync(`${ROOT}${rel}`, "utf8"));
  assert.ok(m, `${rel} has no frontmatter`);
  return m[1];
}

const OMIT = ["odd-explore", "odd-review-readability", "odd-review-reliability", "odd-review-resilience", "odd-review-risk", "odd-jd-judge-a", "odd-jd-judge-b"];
const KEEP = ["odd-worker", "odd-verify", "odd-jd-fix"];
const USER_ONLY = ["odd-skill-registry", "skill-creator", "skill-improver"];

test("read-only bounded agents set omitClaudeMd: true", () => {
  for (const a of OMIT) assert.match(frontmatter(`agents/${a}.md`), /^omitClaudeMd: true$/m, a);
});

test("writer and verifier agents keep project CLAUDE.md", () => {
  for (const a of KEEP) assert.doesNotMatch(frontmatter(`agents/${a}.md`), /omitClaudeMd/, a);
});

test("user-only skills set disable-model-invocation: true", () => {
  for (const s of USER_ONLY) assert.match(frontmatter(`skills/${s}/SKILL.md`), /^disable-model-invocation: true$/m, s);
});

test("odd-retro stays model-invocable by design (cards route to it)", () => {
  assert.doesNotMatch(frontmatter("skills/odd-retro/SKILL.md"), /disable-model-invocation/);
});
