// S5: the plan-check step between Track and Implement, and the read-only odd-plan-check agent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PRESETS, PRESET_NAMES, PROFILE_ROLES } from "../lib/profiles.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const read = (rel: string): string => readFileSync(`${ROOT}${rel}`, "utf8");

test("odd-plan-check is a read-only agent that names its checks", () => {
  const t = read("agents/odd-plan-check.md");
  const fm = /^---\n([\s\S]*?)\n---/.exec(t)?.[1] ?? "";
  assert.match(fm, /^name: odd-plan-check$/m);
  assert.match(fm, /^tools: Read, Grep, Glob$/m);
  assert.match(fm, /^disallowedTools: Edit, Write, NotebookEdit$/m);
  assert.match(fm, /^omitClaudeMd: true$/m);
  assert.doesNotMatch(fm, /^tools:.*\b(Edit|Write|Bash)\b/m);
  for (const re of [/`L1`/, /missing, unrequested or misread/, /done when/, /`S#`/, /Risk line/, /no findings/i]) assert.match(t, re);
});

test("protocol text puts plan-check between Track and Implement, lint first", () => {
  const p = read("claude-md/03-protocol.md");
  const track = p.indexOf("5. **Track");
  const impl = p.indexOf("6. **Implement");
  const step = p.indexOf("odd-plan-check");
  assert.ok(track >= 0 && impl > track && step > track && step < impl, "odd-plan-check sits in step 5 or before 6");
  const seg = p.slice(track, impl);
  assert.ok(seg.indexOf("tasks.js") >= 0 && seg.indexOf("tasks.js") < seg.indexOf("odd-plan-check"), "lint first");
  const r = read("rules/odd-tracking.md");
  assert.ok(r.indexOf("odd-plan-check") > r.indexOf("tasks.js"), "rule names the agent after the lint");
  assert.match(read("claude-md/05-delegation.md"), /`odd-plan-check`/);
});

test("every profile routes odd-plan-check", () => {
  assert.ok((PROFILE_ROLES as readonly string[]).includes("odd-plan-check"));
  for (const n of PRESET_NAMES) assert.ok(PRESETS[n]["odd-plan-check"], n);
});
