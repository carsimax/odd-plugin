// User decision (v0.5): the plugin has zero deny/ask/block hooks. Coordinator mode and admission
// rules exist only as prompt text. This pins that no shipped hook code or config can block a tool.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Pattern assembled from parts so a repo-wide grep for the literals only finds real decisions.
const q = String.fromCharCode(34);
const FORBIDDEN = new RegExp([`${q}de${"ny"}${q}`, `${q}as${"k"}${q}`, "permission" + "Decision", `${q}decision${q}\\s*:\\s*${q}blo${"ck"}${q}`].join("|"));

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function files(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) files(p, out);
    else out.push(p);
  }
  return out;
}

test("no source or hook config returns or declares a deny/ask/block decision", () => {
  const targets = [...files(join(root, "src")).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")), join(root, "hooks", "hooks.json")];
  for (const f of targets) {
    const text = readFileSync(f, "utf8");
    assert.doesNotMatch(text, FORBIDDEN, f);
  }
});

test("hooks.json registers only SessionStart and UserPromptSubmit (no PreToolUse/PostToolUse/Stop)", () => {
  const cfg = JSON.parse(readFileSync(join(root, "hooks", "hooks.json"), "utf8")) as { hooks: Record<string, unknown> };
  assert.deepEqual(Object.keys(cfg.hooks).sort(), ["SessionStart", "UserPromptSubmit"]);
});

test("the full-delegation card exists, is listed in SOURCES and claims no enforcement", () => {
  const card = join(root, "cards", "full-delegation.md");
  assert.ok(existsSync(card));
  const text = readFileSync(card, "utf8");
  assert.match(text, /COORDINATOR in full delegation mode/);
  assert.match(text, /no hook blocks edits/);
  assert.doesNotMatch(text, /harness denies|hook denies|PreToolUse/i);
  assert.match(readFileSync(join(root, "cards", "SOURCES.md"), "utf8"), /cards\/full-delegation\.md .*odd-check: allow/);
});

test("admission cards and the Judgment Day skill state their rules without claiming a hook enforces them", () => {
  for (const f of ["cards/writer.md", "cards/delegation.md", "cards/verification.md", "skills/judgment-day/SKILL.md"]) {
    const text = readFileSync(join(root, f), "utf8");
    assert.match(text, /No hook enforces/, f);
    assert.doesNotMatch(text, /hook for this dispatch is planned|Phase 3 hook/i, f);
  }
});
