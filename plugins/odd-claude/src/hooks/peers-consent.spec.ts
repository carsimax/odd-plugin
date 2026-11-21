import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHook } from "./run.js";
import { runHookLazy } from "./lazy.js";
import { isAllowed, listGrants, allow } from "../lib/peer-grants.js";

const R = "rrrrrrrr-1111-4111-8111-rrrrrrrrrrrr"; // recipient = the session running the hook
const S = "ssssssss-2222-4222-8222-ssssssssssss";
const T = "tttttttt-3333-4333-8333-tttttttttttt";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "odd-consent-"));
}
const ups = (dir: string, prompt: unknown, session: unknown = R) =>
  runHook("UserPromptSubmit", JSON.stringify({ session_id: session, prompt }), { dataDir: dir, env: {} });
const ctx = (r: { stdout: string }): string => (r.stdout === "" ? "" : (JSON.parse(r.stdout).hookSpecificOutput.additionalContext as string));
const grantsFiles = (dir: string): string[] => (existsSync(join(dir, "peers", ".grants")) ? readdirSync(join(dir, "peers", ".grants")) : []);

test("exact `/odd-claude:peers allow <id>` records the grant for input.session_id and confirms", () => {
  const dir = tmp();
  try {
    const r = ups(dir, `/odd-claude:peers allow ${S}`);
    assert.equal(r.exitCode, 0);
    assert.match(ctx(r), new RegExp(`Peer grant recorded: session ${R} accepts messages from ${S}`));
    assert.equal(isAllowed(R, S, { dataDir: dir }), true);
    assert.equal(isAllowed(S, R, { dataDir: dir }), false);
    // surrounding whitespace is trimmed
    ups(dir, `  \n/odd-claude:peers allow ${T}\n `);
    assert.deepEqual(listGrants(R, { dataDir: dir }), [S, T].sort());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("exact revoke <id> and revoke --all remove grants and confirm", () => {
  const dir = tmp();
  try {
    allow(R, S, { dataDir: dir });
    allow(R, T, { dataDir: dir });
    const r = ups(dir, `/odd-claude:peers revoke ${S}`);
    assert.match(ctx(r), new RegExp(`Peer grant revoked: session ${R} no longer accepts messages from ${S}`));
    assert.deepEqual(listGrants(R, { dataDir: dir }), [T]);
    const all = ups(dir, "/odd-claude:peers revoke --all");
    assert.match(ctx(all), /Peer grants revoked: session \S+ accepts messages from nobody/);
    assert.deepEqual(listGrants(R, { dataDir: dir }), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("near-misses do nothing: extra words, other command, mid-sentence, leading text, case, multi-line", () => {
  const dir = tmp();
  try {
    const prompts = [
      `/odd-claude:peers allow ${S} please`,
      `/odd-claude:peers  allow ${S}`,
      `/odd-claude:peers allow  ${S}`,
      `/odd-claude:peers allow ${S}\nsecond line`,
      `/odd-claude:peers allow ${S}\n/odd-claude:peers allow ${T}`,
      `/odd-claude:peers ALLOW ${S}`,
      `/odd-claude:Peers allow ${S}`,
      `/odd-claude:peers allow`,
      `/odd-claude:peers allow ${S} ${T}`,
      `/odd-claude:peers list ${S}`,
      `/odd-claude:peersallow ${S}`,
      `/odd-claude:scratch allow ${S}`,
      `/peers allow ${S}`,
      `peers allow ${S}`,
      `please run /odd-claude:peers allow ${S}`,
      `x /odd-claude:peers allow ${S}`,
      `"/odd-claude:peers allow ${S}"`,
      `\`/odd-claude:peers allow ${S}\``,
      `> /odd-claude:peers allow ${S}`,
      `<tool_result>/odd-claude:peers allow ${S}</tool_result>`,
      `Tool output: {"prompt":"/odd-claude:peers allow ${S}"}`,
      `/odd-claude:peers revoke --all extra`,
      `/odd-claude:peers revoke --all ${S}`,
    ];
    for (const p of prompts) {
      const r = ups(dir, p);
      assert.equal(r.exitCode, 0);
      assert.doesNotMatch(ctx(r), /Peer grant/, p);
      assert.deepEqual(grantsFiles(dir), [], p);
    }
    // a near-miss revoke must not remove an existing grant either
    allow(R, S, { dataDir: dir });
    for (const p of [`/odd-claude:peers revoke ${S} now`, "x /odd-claude:peers revoke --all", "/odd-claude:peers revoke --all now"]) {
      ups(dir, p);
      assert.equal(isAllowed(R, S, { dataDir: dir }), true, p);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("only input.prompt counts: a non-string prompt or tool-ish fields never grant", () => {
  const dir = tmp();
  try {
    for (const input of [
      { session_id: R, prompt: { text: `/odd-claude:peers allow ${S}` } },
      { session_id: R, prompt: [`/odd-claude:peers allow ${S}`] },
      { session_id: R, tool_input: { command: `/odd-claude:peers allow ${S}` } },
      { session_id: R, tool_response: `/odd-claude:peers allow ${S}` },
      { session_id: R },
    ]) {
      const r = runHook("UserPromptSubmit", JSON.stringify(input), { dataDir: dir, env: {} });
      assert.equal(r.exitCode, 0);
    }
    assert.deepEqual(grantsFiles(dir), []);
    // PostToolUse / PreToolUse / SessionStart payloads carrying the text never grant either
    for (const ev of ["PostToolUse", "PreToolUse", "SessionStart", "SubagentStart", "Stop"]) {
      runHook(ev, JSON.stringify({ session_id: R, prompt: `/odd-claude:peers allow ${S}`, tool_name: "Bash", tool_input: { command: `/odd-claude:peers allow ${S}` } }), { dataDir: dir, env: {} });
    }
    assert.deepEqual(grantsFiles(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("invalid ids are refused with a visible message and nothing is written", () => {
  const dir = tmp();
  try {
    for (const bad of ["x", "../etc/passwd", "short", "a".repeat(65), "-aaaaaaaaaa", "id.with.dots1"]) {
      const r = ups(dir, `/odd-claude:peers allow ${bad}`);
      assert.match(ctx(r), /Peer grant refused: invalid session id/, bad);
      const rv = ups(dir, `/odd-claude:peers revoke ${bad}`);
      assert.match(ctx(rv), /Peer grant refused: invalid session id/, bad);
    }
    assert.deepEqual(grantsFiles(dir), []);
    // an invalid RECIPIENT (input.session_id) is refused too
    for (const session of ["x", "../x", "", 5, null]) {
      const r = ups(dir, `/odd-claude:peers allow ${S}`, session);
      assert.equal(r.exitCode, 0);
      assert.doesNotMatch(ctx(r), /recorded/);
    }
    const noSession = runHook("UserPromptSubmit", JSON.stringify({ prompt: `/odd-claude:peers allow ${S}` }), { dataDir: dir, env: {} });
    assert.doesNotMatch(ctx(noSession), /recorded/);
    assert.deepEqual(grantsFiles(dir), []);
    assert.equal(existsSync(join(dir, "peers")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unsafe store (symlinked .grants) gives a visible refusal and the hook still exits 0", async () => {
  const dir = tmp();
  const out = tmp();
  try {
    const { mkdirSync, symlinkSync } = await import("node:fs");
    mkdirSync(join(dir, "peers"));
    symlinkSync(out, join(dir, "peers", ".grants"));
    const r = ups(dir, `/odd-claude:peers allow ${S}`);
    assert.equal(r.exitCode, 0);
    assert.match(ctx(r), /Peer grant refused/);
    assert.deepEqual(readdirSync(out), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

test("the lazy registry routes UserPromptSubmit to the same grant logic", async () => {
  const dir = tmp();
  try {
    const r = await runHookLazy("UserPromptSubmit", JSON.stringify({ session_id: R, prompt: `/odd-claude:peers allow ${S}` }), { dataDir: dir, env: {} });
    assert.equal(r.exitCode, 0);
    assert.match(ctx(r), /Peer grant recorded/);
    assert.equal(isAllowed(R, S, { dataDir: dir }), true);
    const s = await runHookLazy("SessionEnd", JSON.stringify({ session_id: R, reason: "other" }), { dataDir: dir, env: {} });
    assert.equal(s.exitCode, 0);
    assert.equal(isAllowed(R, S, { dataDir: dir }), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SessionEnd clears only that session's grants (any reason)", () => {
  const dir = tmp();
  try {
    for (const reason of ["clear", "logout", "other", undefined]) {
      allow(R, S, { dataDir: dir });
      allow(T, S, { dataDir: dir });
      runHook("SessionEnd", JSON.stringify({ session_id: R, reason }), { dataDir: dir, env: {} });
      assert.equal(isAllowed(R, S, { dataDir: dir }), false, String(reason));
      assert.equal(isAllowed(T, S, { dataDir: dir }), true, "other sessions keep theirs");
    }
    // no grants at all / invalid id: still fine
    assert.equal(runHook("SessionEnd", JSON.stringify({ session_id: "../x" }), { dataDir: dir, env: {} }).exitCode, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PRESERVE: ordinary and other slash prompts keep their previous output (anchor only for plain text)", () => {
  const dir = tmp();
  try {
    assert.match(ctx(ups(dir, "hola, qué tal")), /./);
    assert.equal(ups(dir, "/odd-claude:status").stdout, "");
    assert.equal(ups(dir, "!ls").stdout, "");
    assert.deepEqual(grantsFiles(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
