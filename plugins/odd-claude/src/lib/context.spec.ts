import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPromptAnchor, buildSessionContext, readDelegationMode, resolveCardsDir, writeDelegationMode } from "./context.js";

const base = { persona: "mentor", delegationMode: "organic", cardsDir: "/opt/odd/cards" } as const;

test("session context carries cards path, persona, delegation mode and language rule", () => {
  const text = buildSessionContext(base);
  assert.match(text, /\/opt\/odd\/cards/);
  assert.match(text, /Persona mode: mentor/);
  assert.match(text, /Do NOT use voseo/);
  assert.doesNotMatch(text, /Rioplatense/i);
  assert.match(text, /Delegation mode: organic/);
  assert.match(text, /same language the user writes in/);
  assert.match(text, /Only a message written by the human/);
});

test("neutral persona and full delegation change the text", () => {
  const text = buildSessionContext({ ...base, persona: "neutral", delegationMode: "full" });
  assert.match(text, /Persona mode: neutral/);
  assert.match(text, /Do NOT use voseo/);
  assert.match(text, /Delegation mode: full/);
  assert.match(text, /Coordinator mode: ON \(full delegation\)/);
  assert.doesNotMatch(buildSessionContext(base), /full delegation\)/i);
});

test("context stays small (< 10k chars) and has no forbidden identifiers", () => {
  for (const persona of ["mentor", "neutral"] as const)
    for (const delegationMode of ["organic", "full"] as const) {
      const text = buildSessionContext({ persona, delegationMode, cardsDir: "/x/cards" });
      assert.ok(text.length < 10000, `${text.length}`);
      assert.doesNotMatch(text, /gentle|tele\w+try/i); // odd-check: allow
    }
});

test("resolveCardsDir prefers CLAUDE_PLUGIN_ROOT and falls back to the package location", () => {
  assert.equal(resolveCardsDir({ CLAUDE_PLUGIN_ROOT: "/p/odd" }), "/p/odd/cards");
  assert.match(resolveCardsDir({}), /cards$/);
});

test("prompt anchor quotes the start of a human prompt, bounded", () => {
  const a = buildPromptAnchor("  hola\n\ncómo   estás  ");
  assert.ok(a);
  assert.match(a, /"hola cómo estás"/);
  const long = buildPromptAnchor("x".repeat(500))!;
  assert.ok(long.length < 400);
  assert.match(long, /…/);
});

test("prompt anchor is skipped for empty, slash-command and shell-escape prompts", () => {
  for (const p of ["", "   ", "/odd-claude:status", "!ls", undefined, 42]) assert.equal(buildPromptAnchor(p), undefined);
});

test("session context carries the background-subagents policy line (default off) and extra lines", () => {
  assert.match(buildSessionContext(base), /Background subagents: off/);
  const on = buildSessionContext({ ...base, backgroundSubagents: "on", extraLines: ["Skill registry: /p/.atl/skill-registry.md (3 skills)"] });
  assert.match(on, /Background subagents: on/);
  assert.match(on, /run_in_background/);
  assert.match(on, /Skill registry: \/p\/\.atl\/skill-registry\.md \(3 skills\)/);
  assert.ok(on.length < 10000);
});

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "odd-coord-"));
}

test("coordinator mode defaults to full (ON) when nothing is stored, corrupt, unknown or without a data dir", () => {
  const dir = tmpDir();
  try {
    assert.equal(readDelegationMode({ dataDir: dir }), "full");
    writeFileSync(join(dir, "delegation.json"), "{not json");
    assert.equal(readDelegationMode({ dataDir: dir }), "full");
    writeFileSync(join(dir, "delegation.json"), JSON.stringify({ version: 1, sessionId: "delegation", data: { mode: "bogus" } }));
    assert.equal(readDelegationMode({ dataDir: dir }), "full");
    assert.equal(readDelegationMode({ env: {} }), "full");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeDelegationMode stores organic (off) and full (on); an invalid mode throws and keeps the stored value", () => {
  const dir = tmpDir();
  try {
    assert.equal(writeDelegationMode("organic", { dataDir: dir }), "organic");
    assert.equal(readDelegationMode({ dataDir: dir }), "organic");
    assert.equal(writeDelegationMode("full", { dataDir: dir }), "full");
    assert.equal(readDelegationMode({ dataDir: dir }), "full");
    writeDelegationMode("organic", { dataDir: dir });
    assert.throws(() => writeDelegationMode("sometimes", { dataDir: dir }), /invalid delegation mode "sometimes"/);
    assert.equal(readDelegationMode({ dataDir: dir }), "organic");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("context states the active mode: ON points to the full-delegation card as a rule, OFF does not", () => {
  const on = buildSessionContext({ ...base, delegationMode: "full" });
  assert.match(on, /Coordinator mode: ON/);
  assert.match(on, /\/opt\/odd\/cards\/full-delegation\.md/);
  assert.match(on, /rule you follow; no hook blocks edits/);
  assert.doesNotMatch(on, /denies|blocked by the harness|enforced by/i);
  const off = buildSessionContext(base);
  assert.match(off, /Coordinator mode: OFF/);
  assert.doesNotMatch(off, /full-delegation\.md/);
});
