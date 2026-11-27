// autonomous-review S1: `single-pr` is the default delivery strategy; no shipped text names `ask-on-risk` as the default.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");
const walk = (dir: string): string[] =>
  readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith(".md") ? [join(dir, e.name)] : []));

test("the delivery rule and the feature-document format name single-pr as the default strategy", () => {
  assert.match(read("rules/odd-tracking.md"), /`single-pr` \(default\)/);
  assert.match(read("support/feature-doc-format.md"), /`single-pr` default/);
  assert.match(read("support/feature-doc-format.md"), /Delivery: `single-pr`/);
});

test("no shipped text names ask-on-risk as the default", () => {
  for (const f of ["rules", "claude-md", "skills", "support"].flatMap(walk)) {
    assert.doesNotMatch(read(f), /ask-on-risk`\s*\(?default\b|default (?:is|strategy)[^.\n]{0,20}`ask-on-risk`/i, f);
  }
});

test("under the default no chain menu is asked, and the other strategies stay available", () => {
  const rule = read("rules/odd-tracking.md");
  assert.match(rule, /default[^.]*no chain menu/i);
  for (const s of ["ask-on-risk", "auto-chain", "exception-ok"]) assert.ok(rule.includes(`\`${s}\``), s);
});
