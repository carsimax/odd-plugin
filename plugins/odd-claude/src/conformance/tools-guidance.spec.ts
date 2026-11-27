// tools-guidance: Engram and CodeGraph guidance ships in the CLAUDE.md fragments, the always-on rules and the agents.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");

test("claude-md/09-codegraph.md directs codegraph_explore first, counts it in the evidence budget and ties it to the Risk line", () => {
  assert.ok(existsSync(join(ROOT, "claude-md/09-codegraph.md")), "09-codegraph.md missing");
  const t = read("claude-md/09-codegraph.md");
  assert.match(t, /^## CodeGraph/m);
  assert.match(t, /mcp__codegraph__codegraph_explore/);
  assert.match(t, /codegraph_explore[^\n]*FIRST[^\n]*before[^\n]*Grep/i);
  assert.match(t, /evidence budget/i);
  assert.match(t, /Risk: none/);
  assert.match(t, /\.codegraph\/[^\n]*never commit/i);
});

test("claude-md/08-memory.md reinforces recall before deciding and the Prior context handoff", () => {
  const t = read("claude-md/08-memory.md");
  assert.match(t, /Recall before deciding/i);
  assert.match(t, /project-scoped `mem_search`/);
  assert.match(t, /## Prior context \(Engram\)/);
  assert.match(t, /mem_suggest_topic_key/);
});

test("claude-md/08-memory.md keeps the broad save triggers and the worker recall limit", () => {
  const t = read("claude-md/08-memory.md");
  assert.match(t, /mem_save[^\n]*any decision, bugfix, discovery, convention,? or config change/i);
  assert.match(t, /Workers never run broad recall/);
});

test("always-on rules reference the Engram handoff and codegraph_explore", () => {
  assert.match(read("rules/odd-delegation.md"), /## Prior context \(Engram\)/);
  assert.match(read("rules/odd-delegation.md"), /codegraph_explore/);
  assert.match(read("rules/odd-verification.md"), /codegraph_explore/);
});

for (const a of ["odd-worker", "odd-verify", "odd-jd-fix", "odd-jd-judge-a", "odd-jd-judge-b", "odd-review-readability", "odd-review-reliability", "odd-review-resilience", "odd-review-risk"]) {
  test(`${a} uses codegraph_explore first with a fallback`, () => {
    const t = read(`agents/${a}.md`);
    assert.match(t, /Use `codegraph_explore`[^\n]*\bfirst\b[^\n]*before `Grep` or `Read`/);
    assert.match(t, /(fall back|fallback)[^\n]*(Read|Grep)/i);
  });
}

for (const a of ["odd-worker", "odd-verify"]) {
  test(`${a} reads the Prior context (Engram) section`, () => {
    assert.match(read(`agents/${a}.md`), /## Prior context \(Engram\)/);
  });
}
