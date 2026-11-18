// User decision (v0.5): the plugin has zero deny/ask/block hooks. Coordinator mode and admission
// rules exist only as prompt text. This pins that no shipped hook code or config can block a tool.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runHook } from "../hooks/run.js";

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

test("hooks.json registers only SessionStart, UserPromptSubmit and advisory PostToolUse (no PreToolUse/Stop)", () => {
  const cfg = JSON.parse(readFileSync(join(root, "hooks", "hooks.json"), "utf8")) as { hooks: Record<string, unknown> };
  assert.deepEqual(Object.keys(cfg.hooks).sort(), ["PostToolUse", "SessionStart", "UserPromptSubmit"]);
});

test("PostToolUse outputs are advisory: only hookSpecificOutput.additionalContext, exit 0, never a decision", () => {
  const dir = mkdtempSync(join(tmpdir(), "odd-nodeny-"));
  try {
    const tr = join(dir, "t.jsonl");
    writeFileSync(tr, JSON.stringify({ message: { usage: { input_tokens: 999_999 } } }) + "\n");
    for (let i = 0; i < 6; i++) {
      for (const input of [
        { session_id: "s", tool_name: "Read", tool_response: "x".repeat(50_000), transcript_path: tr },
        { session_id: "s", tool_name: "Grep", tool_response: "x" },
        { session_id: "s", tool_name: "Read", agent_id: "a" },
        { session_id: "s" },
      ]) {
        const r = runHook("PostToolUse", JSON.stringify(input), { dataDir: dir });
        assert.equal(r.exitCode, 0);
        if (r.stdout === "") continue;
        const out = JSON.parse(r.stdout) as Record<string, unknown>;
        assert.deepEqual(Object.keys(out), ["hookSpecificOutput"]);
        assert.deepEqual(Object.keys(out.hookSpecificOutput as object).sort(), ["additionalContext", "hookEventName"]);
        assert.doesNotMatch(r.stdout, FORBIDDEN);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
