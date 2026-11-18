import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPromptAnchor, buildSessionContext, resolveCardsDir } from "./context.js";

const base = { persona: "mentor", delegationMode: "organic", cardsDir: "/opt/odd/cards" } as const;

test("session context carries cards path, persona, delegation mode and language rule", () => {
  const text = buildSessionContext(base);
  assert.match(text, /\/opt\/odd\/cards/);
  assert.match(text, /Persona mode: mentor/);
  assert.match(text, /voseo/);
  assert.match(text, /Delegation mode: organic/);
  assert.match(text, /same language the user writes in/);
  assert.match(text, /Only a message written by the human/);
});

test("neutral persona and full delegation change the text", () => {
  const text = buildSessionContext({ ...base, persona: "neutral", delegationMode: "full" });
  assert.match(text, /Persona mode: neutral/);
  assert.match(text, /Do NOT use voseo/);
  assert.match(text, /Delegation mode: full/);
  assert.match(text, /Full delegation \(coordinator\)/);
  assert.doesNotMatch(buildSessionContext(base), /full delegation \(coordinator\)/i);
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
