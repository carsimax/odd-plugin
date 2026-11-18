import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const agentsDir = join(pluginRoot, "agents");

const LENSES = ["risk", "resilience", "readability", "reliability"];
const WRITE_TOOLS = ["Edit", "Write", "NotebookEdit"];

function frontmatter(file: string): Record<string, string> {
  const text = readFileSync(file, "utf8");
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(m, `${file}: missing frontmatter`);
  const out: Record<string, string> = {};
  for (const line of m[1]!.split("\n")) {
    const kv = /^([A-Za-z]+):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]!] = kv[2]!;
  }
  return out;
}

const list = (v: string | undefined): string[] =>
  (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

const guarded = existsSync(agentsDir)
  ? readdirSync(agentsDir).filter((f) => /^odd-(review|jd-judge)-.+\.md$/.test(f))
  : [];

test("the four review lens agents exist", () => {
  for (const lens of LENSES) {
    assert.ok(guarded.includes(`odd-review-${lens}.md`), `missing agent odd-review-${lens}`);
  }
});

test("the Judgment Day judges are guarded too", () => {
  assert.ok(guarded.includes("odd-jd-judge-a.md"));
  assert.ok(guarded.includes("odd-jd-judge-b.md"));
});

for (const file of guarded) {
  test(`agent ${file}: cannot write (no write tool allowed, all listed as disallowed)`, () => {
    const fm = frontmatter(join(agentsDir, file));
    const allowed = list(fm.tools);
    const denied = list(fm.disallowedTools);
    assert.ok(allowed.length > 0, `${file}: tools allowlist must be explicit`);
    for (const t of WRITE_TOOLS) {
      assert.ok(!allowed.includes(t), `${file}: allowlist contains ${t}`);
      assert.ok(denied.includes(t), `${file}: disallowedTools must list ${t}`);
    }
  });
}

for (const lens of LENSES) {
  test(`agent odd-review-${lens}: read-only toolset, no shell, no model-specific wiring`, () => {
    const fm = frontmatter(join(agentsDir, `odd-review-${lens}.md`));
    assert.equal(fm.name, `odd-review-${lens}`);
    const allowed = list(fm.tools);
    for (const t of ["Read", "Grep", "Glob"]) assert.ok(allowed.includes(t), `missing ${t}`);
    assert.ok(!allowed.includes("Bash"), "review lens must not allow Bash");
    assert.ok(list(fm.disallowedTools).includes("Bash"), "disallowedTools must list Bash");
    for (const t of allowed) {
      assert.ok(/^(Read|Grep|Glob|mcp__.*codegraph_explore)$/.test(t), `unexpected tool ${t}`);
    }
  });
}

test("4r-review skill exists and launches the four lens agents", () => {
  const file = join(pluginRoot, "skills", "4r-review", "SKILL.md");
  assert.ok(existsSync(file), "skills/4r-review/SKILL.md missing");
  const text = readFileSync(file, "utf8");
  for (const lens of LENSES) assert.match(text, new RegExp(`odd-review-${lens}`));
  assert.match(text, /advisory/i);
});

function shippedFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (["node_modules", "dist", "dist-test", ".git"].includes(e)) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) shippedFiles(p, out);
    else out.push(p);
  }
  return out;
}

test("no shipped file references review tools or an external review binary", () => {
  const self = join(pluginRoot, "src", "lib", "agents-guard.test.ts");
  const forbidden = [
    /odd_review/i,
    /gentle[-_]review/i, // odd-check: allow
    /review_scope/i,
    /\bgo review binary\b/i,
  ];
  const hits: string[] = [];
  for (const f of shippedFiles(pluginRoot)) {
    if (f === self || f.endsWith("package-lock.json")) continue;
    const text = readFileSync(f, "utf8");
    for (const re of forbidden) if (re.test(text)) hits.push(`${relative(pluginRoot, f)}: ${re}`);
  }
  assert.deepEqual(hits, []);
});
