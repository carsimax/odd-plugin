// cards-to-rules (S1-S3): the former lazy cards are fused, always-on rules under rules/ (no `paths:`), within a byte budget.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defaultSelection } from "../installer/models.js";
import { runInstall } from "../installer/plan.js";
import { makeHome } from "../installer/installer.testkit.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");
const bytes = (s: string): number => Buffer.byteLength(s, "utf8");
const BUDGET = 24_000;
const CARD_RULES = ["odd-delegation.md", "odd-verification.md", "odd-skills.md"];
const frontmatter = (rel: string): string => /^---\n([\s\S]*?)\n---\n/.exec(read(rel))?.[1] ?? "";
const alwaysOn = (): string[] => readdirSync(join(ROOT, "rules")).filter((n) => n.endsWith(".md") && !/^paths:/m.test(frontmatter(`rules/${n}`)));
const walk = (dir: string): string[] =>
  readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith(".md") ? [join(dir, e.name)] : []));

test("the cards directory is gone and the always-on rules are exactly the fused card rules (S1)", () => {
  assert.equal(existsSync(join(ROOT, "cards")), false);
  assert.deepEqual(alwaysOn().sort(), [...CARD_RULES].sort());
});

test("card-derived rules (no paths: frontmatter) total at most 24,000 bytes (S3)", () => {
  const total = alwaysOn().reduce((n, f) => n + bytes(read(`rules/${f}`)), 0);
  assert.ok(total > 0);
  assert.ok(total <= BUDGET, `${total} bytes > ${BUDGET}`);
});

test("provenance is not installed under rules/ and lives in support/ (S3)", () => {
  assert.equal(existsSync(join(ROOT, "rules", "SOURCES.md")), false);
  const s = read("support/SOURCES.md");
  assert.match(s, /Technique sources/);
  for (const r of CARD_RULES) assert.ok(s.includes(`rules/${r}`), r);
});

test("no shipped text points at a card path or tells the model to read a card (S2)", () => {
  for (const f of ["claude-md", "skills", "agents", "rules", "support"].flatMap(walk).concat("output-styles/odd.md", "README.md")) {
    assert.doesNotMatch(read(f), /cards\/|Read a card|read a card/, f);
  }
});

test("delegation rule: coordinator mode, writer handoff, prompts and no-enforcement claim survive the fusion", () => {
  const s = read("rules/odd-delegation.md");
  assert.match(s, /COORDINATOR in full delegation mode/);
  assert.match(s, /no hook blocks edits/);
  assert.doesNotMatch(s, /harness denies|hook denies|PreToolUse/i);
  assert.match(s, /No hook enforces/);
  assert.match(s, /Allowed edit surfaces/);
  assert.match(s, /Lossless Blocking Prompts/);
  assert.match(s, /status: interaction_required/);
  assert.match(s, /run_in_background: true/);
});

test("verification rule: tiers, handoff without the writer's claim, quota recovery survive the fusion", () => {
  const s = read("rules/odd-verification.md");
  assert.match(s, /No hook enforces/);
  assert.match(s, /never the writer's conclusions, success claims or summary/);
  assert.match(s, /\| high \|/);
  assert.match(s, /--fallback-model/);
});

test("skills rule: registry protocol and both skill hints", () => {
  const s = read("rules/odd-skills.md");
  assert.match(s, /Skills to load before work/);
  assert.match(s, /`\/systematic-debugging`/);
  assert.match(s, /`\/receiving-review`/);
});

test("a temp-HOME install of the real tree writes the card rules under rules/ and no cards dir in the payload (S1, S3)", () => {
  const { home, paths } = makeHome();
  try {
    runInstall({ paths, sourceRoot: ROOT, version: "9.9.9", selection: defaultSelection() });
    for (const r of CARD_RULES) {
      const text = readFileSync(join(paths.claudeDir, "rules", r), "utf8");
      assert.doesNotMatch(text, /^---\n[\s\S]*?\npaths:/, `${r}: no paths frontmatter after install`);
      assert.doesNotMatch(text, /\$\{CLAUDE_PLUGIN_/, `${r}: placeholders resolved`);
    }
    assert.equal(existsSync(join(paths.claudeDir, "rules", "SOURCES.md")), false);
    assert.equal(existsSync(join(paths.currentLink, "cards")), false);
    assert.ok(existsSync(join(paths.currentLink, "support", "SOURCES.md")));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("restored rules: surface authority, per-tool updates, verifier fallback, skills subject, prompt details", () => {
  const d = read("rules/odd-delegation.md");
  assert.match(d, /A surface grants no repository authority or prohibited operation\./);
  assert.match(d, /never end the turn on one: take the next step it names/);
  assert.match(d, /no per-tool updates/);
  assert.doesNotMatch(d, /per-token/);
  assert.match(d, /Run the required focused verification before that claim, and retain legitimate post-correction verification\. This does not invent a universal full-suite requirement\./);
  assert.match(d, /general-purpose `Agent` with the same read-only verification constraints, the exact parent-authorized commands/);
  assert.match(d, /Native-tool-only wording elsewhere never disables this fallback\./);
  assert.match(d, /keep its configured model/);
  assert.match(d, /Pass sources already available through task\/context when useful/);
  assert.match(d, /Subagents also run in the background by default\./);
  const v = read("rules/odd-verification.md");
  assert.match(v, /use the existing command path and retain its observed result/);
  assert.match(v, /do not pass missing proof/);
  assert.match(v, /the next application outcome/);
  assert.match(v, /the parent commits when a commit is authorized/);
  const k = read("rules/odd-skills.md");
  assert.match(k, /the parent continues without project skill injection and reports `skill_resolution: none`/);
  assert.match(k, /during normal runtime/);
  assert.match(read("README.md").split("\n")[2]!, /orchestrator rules/);
});
