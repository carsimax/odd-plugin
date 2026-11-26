// always-on-context T3/T4 (S4, S5, S6, S7c, D1, D3, D4, D5): the shipped CLAUDE.md block sources, the path-scoped rules and the neutral
// output style. Reads the authored payload files, never the real ~/.claude.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readDesiredBlocks } from "../installer/claude-md.js";
import { resolvePlaceholders } from "../installer/placeholders.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");
const bytes = (s: string): number => Buffer.byteLength(s, "utf8");
const BUDGET = 80_000;
const EXPECTED_IDS = ["identity", "continuity", "protocol", "task-size", "delegation", "language", "safety", "memory"];

// A realistic, long resolved root so placeholder expansion cannot hide a budget overrun.
const values = { root: "/Users/someone/.odd-claude/current", data: "/Users/someone/.odd-claude/data" };
const blocks = (): { id: string; text: string }[] => readDesiredBlocks(ROOT, (s) => resolvePlaceholders(s, values));
const blockText = (id: string): string => blocks().find((b) => b.id === id)?.text ?? "";

test("claude-md ships exactly the eight port-map blocks with unique ids", () => {
  const ids = blocks().map((b) => b.id);
  assert.equal(new Set(ids).size, ids.length, `duplicate ids in ${ids.join(",")}`);
  assert.deepEqual([...ids].sort(), [...EXPECTED_IDS].sort());
  const files = readdirSync(join(ROOT, "claude-md")).filter((n) => n.endsWith(".md"));
  for (const f of files) assert.match(f, /^\d\d-[a-z0-9][a-z0-9-]*\.md$/, `${f} must be NN-<id>.md`);
});

test("the concatenated rendered blocks, markers included, fit the 80,000 byte budget (S4)", () => {
  const rendered = blocks().map((b) => `<!-- odd-claude:${b.id} -->\n${b.text}\n<!-- /odd-claude:${b.id} -->\n`).join("\n");
  assert.ok(bytes(rendered) > 0, "no blocks");
  assert.ok(bytes(rendered) <= BUDGET, `${bytes(rendered)} bytes > ${BUDGET}`);
});

test("block sources carry no absolute path or plugin placeholder left unresolved", () => {
  for (const b of blocks()) {
    assert.doesNotMatch(b.text, /\$\{CLAUDE_PLUGIN_/, `${b.id}: unresolved placeholder`);
    assert.doesNotMatch(b.text, /<cards>/, `${b.id}: <cards> pseudo path`);
  }
  assert.match(blockText("identity"), /~\/\.claude\/rules\//);
});

test("odd-tracking is path-scoped to odd/tasks/**; the other rules are the always-on card rules (S4, S7c, D3)", () => {
  const dir = join(ROOT, "rules");
  const rules = readdirSync(dir).filter((n) => n.endsWith(".md"));
  assert.ok(rules.includes("odd-tracking.md"));
  for (const r of rules.filter((n) => n !== "odd-tracking.md")) {
    assert.doesNotMatch(read(`rules/${r}`), /^---\n[\s\S]*?\npaths:/, `${r}: always-on, no paths frontmatter`);
  }
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(read("rules/odd-tracking.md"))?.[1] ?? "";
  assert.match(fm, /^\s*-\s*["']?odd\/tasks\/\*\*["']?\s*$/m);
});

test("upstream residue is dropped: no review CLI, no Co-Authored-By ban, no provider names (D4, D5)", () => {
  const all = [...blocks().map((b) => b.text), read("rules/odd-tracking.md"), read("output-styles/odd.md")].join("\n");
  assert.doesNotMatch(all, /gentle.ai/i);
  assert.doesNotMatch(all, /review assess/);
  assert.doesNotMatch(all, /Never add "?Co-Authored-By/i);
  assert.doesNotMatch(all, /Agent Teams/);
});

test("coordinator ON/OFF stays a session-context line; the delegation block defers to it (D5)", () => {
  const d = blockText("delegation");
  assert.match(d, /Coordinator mode: ON/);
  assert.match(d, /Coordinator mode: OFF/);
  assert.match(d, /odd-explore/);
  assert.match(d, /odd-worker/);
  assert.match(d, /odd-verify/);
  assert.match(d, /odd-jd-judge-a/);
});

test("protocol keeps the 7 steps and a minimal feature-document layout (D5)", () => {
  const p = blockText("protocol");
  for (const step of ["Authorize", "Explore", "Resolve uncertainty", "Classify", "Track before the first write", "Implement task by task", "Close"]) {
    assert.ok(p.includes(`**${step}.**`), step);
  }
  for (const part of ["## Specs", "## Tasks", "## Log", "done when:"]) assert.ok(p.includes(part), part);
  assert.match(p, /odd\/tasks\/<feature-name>\.md/);
});

// Moved from the former output-style assertions: same rule, new location.
test("protocol step 5: a failed done-when waits only its dependents or goes to the human", () => {
  const line = blockText("protocol").split("\n").find((l) => l.startsWith("5. **Track before the first write.**")) ?? "";
  assert.ok(line.includes("dependents"), "dependents");
  assert.ok(/\bask\b/.test(line), "ask");
  assert.ok(!line.includes("fix a failed one first"));
});

test("always-on blocks do not mention the new debugging/review skills or add completion-gate sections", () => {
  const all = blocks().map((b) => b.text).join("\n");
  assert.doesNotMatch(all, /systematic-debugging/);
  assert.doesNotMatch(all, /receiving-review/);
  assert.doesNotMatch(all, /Completion gate/);
  assert.doesNotMatch(all, /\| Excuse \| Answer \|/);
  assert.doesNotMatch(all, /Never weaken the bar/);
});

test("task-size, language, safety and memory blocks carry their ported rules", () => {
  const t = blockText("task-size");
  assert.match(t, /Resumable from the diff/);
  assert.match(t, /Risk: item N/);
  assert.match(blockText("language"), /Reply language/);
  const s = blockText("safety");
  assert.match(s, /Remote operation authorization/);
  assert.match(s, /EnterWorktree/);
  const m = blockText("memory");
  assert.match(m, /mem_current_project/);
  assert.match(m, /ambiguous_project/);
  assert.match(blockText("continuity"), /Short replies/i);
});

test("output style: name odd, keep-coding-instructions, persona/tone/format only, no ODD protocol (S5, S6, D1)", () => {
  assert.ok(existsSync(join(ROOT, "output-styles", "odd.md")));
  const s = read("output-styles/odd.md");
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(s)?.[1] ?? "";
  assert.match(fm, /^name: odd$/m);
  assert.match(fm, /^keep-coding-instructions: true$/m);
  for (const h of ["ODD protocol", "Task Size", "Delegation", "Memory Contract", "Safety", "Authorized work continuity", "Identity and Harness"]) {
    assert.ok(!new RegExp(`^#+ .*${h}`, "m").test(s), `style must not hold section ${h}`);
  }
  assert.doesNotMatch(s, /Coordinator mode/);
  assert.doesNotMatch(s, /odd\/tasks\//);
  assert.doesNotMatch(s, /<cards>/);
  assert.doesNotMatch(s, /Co-Authored-By/i);
  assert.ok(bytes(s) < 8_000, `${bytes(s)} bytes`);
});

test("output style: neutral Spanish with tú, never voseo, reply in the user's language", () => {
  const s = read("output-styles/odd.md");
  assert.match(s, /neutral\/professional Spanish/);
  assert.match(s, /Do NOT use voseo/);
  assert.match(s, /tú/);
  for (const pair of ["tienes, not tenés", "ajustas, not ajustás", "mira, not mirá", "haz, not hacé"]) assert.ok(s.includes(pair), pair);
  assert.match(s, /same language the user writes in|user's current language/);
  assert.doesNotMatch(s, /Rioplatense Spanish with voseo/i);
  assert.match(s, /Do not use Hola, dale, listo/);
});

test("identity lives in the identity block, not duplicated in the style", () => {
  assert.match(blockText("identity"), /odd-claude/);
  assert.match(blockText("identity"), /senior architect/i);
  assert.doesNotMatch(read("output-styles/odd.md"), /I am odd-claude/);
});

// S8: the tracking and memory cards were folded into rules/odd-tracking.md; no shipped text may point at the deleted cards.
test("no shipped card, block, skill or style references the deleted tracking/memory cards (S8)", () => {
  assert.equal(existsSync(join(ROOT, "cards")), false);
  const walk = (dir: string): string[] =>
    readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith(".md") ? [join(dir, e.name)] : []));
  for (const f of ["claude-md", "skills", "agents", "rules"].flatMap(walk).concat("output-styles/odd.md", "README.md")) {
    assert.doesNotMatch(read(f), /cards\/(tracking|memory)\.md|<cards>\/(tracking|memory)\.md/, f);
  }
});

// S9: /odd-persona is retired; there is one neutral persona, carried by the output style, with no command or state to set it.
test("no odd-persona skill, CLI or lib ships and no shipped text names the retired command (S9)", () => {
  assert.equal(existsSync(join(ROOT, "skills", "odd-persona")), false);
  for (const rel of ["src/cli/persona.ts", "src/lib/persona.ts", "dist/cli/persona.js", "dist/lib/persona.js"]) assert.equal(existsSync(join(ROOT, rel)), false, rel);
  const walk = (dir: string): string[] =>
    readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith(".md") ? [join(dir, e.name)] : []));
  for (const f of ["claude-md", "skills", "agents", "rules"].flatMap(walk).concat("output-styles/odd.md", "README.md")) {
    assert.doesNotMatch(read(f), /odd-persona|writePersona/, f);
  }
});
