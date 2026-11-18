import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectTranscriptStats, readTranscriptPath, recordTranscriptPath, renderStats, STATS_TAIL_BYTES } from "./stats.js";
import { runHook } from "../hooks/run.js";
import { updateSessionState, readSessionState } from "./state.js";
import { recordSubagentStart, recordSubagentStop } from "./subagents.js";
import { statsCli } from "../cli/stats.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "odd-stats-"));
}

const asst = (id: string, model: string, u: Record<string, number>, ts: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "assistant", timestamp: ts, message: { id, model, usage: u }, ...extra });

const FIXTURE = [
  JSON.stringify({ type: "user", timestamp: "2026-11-18T10:00:00.000Z", message: { content: "hi" } }),
  // streamed duplicates of one message id: only the last usage counts
  asst("m1", "claude-sonnet-5-5", { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 }, "2026-11-18T10:00:01.000Z"),
  asst("m1", "claude-sonnet-5-5", { input_tokens: 10, output_tokens: 40, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 }, "2026-11-18T10:00:02.000Z"),
  asst("m2", "claude-haiku-5-5", { input_tokens: 3, output_tokens: 7, cache_read_input_tokens: 50 }, "2026-11-18T10:01:00.000Z"),
  asst("m3", "<synthetic>", { input_tokens: 0, output_tokens: 0 }, "2026-11-18T10:01:30.000Z"),
  "not json at all",
  '{"usage": broken',
  "",
].join("\n");

test("collectTranscriptStats sums tokens, dedups by message id, skips garbage and synthetic turns", () => {
  const dir = tmp();
  try {
    const p = join(dir, "t.jsonl");
    writeFileSync(p, FIXTURE);
    const s = collectTranscriptStats(p)!;
    assert.equal(s.turns, 2);
    assert.equal(s.input, 13);
    assert.equal(s.output, 47);
    assert.equal(s.cacheRead, 150);
    assert.equal(s.cacheWrite, 5);
    assert.equal(s.spanMs, 90_000);
    assert.equal(s.truncated, false);
    assert.deepEqual(s.models.map((m) => [m.model, m.turns]), [["claude-sonnet-5-5", 1], ["claude-haiku-5-5", 1]]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectTranscriptStats: missing, directory and empty files never throw", () => {
  const dir = tmp();
  try {
    assert.equal(collectTranscriptStats(join(dir, "nope.jsonl")), undefined);
    assert.equal(collectTranscriptStats(dir), undefined);
    writeFileSync(join(dir, "e.jsonl"), "");
    assert.equal(collectTranscriptStats(join(dir, "e.jsonl"))!.turns, 0);
    writeFileSync(join(dir, "g.jsonl"), Buffer.from([0xff, 0xfe, 0x00, 0x7b, 0x0a, 0x80]));
    assert.equal(collectTranscriptStats(join(dir, "g.jsonl"))!.turns, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectTranscriptStats reads at most the tail of a huge transcript and says so", () => {
  const dir = tmp();
  try {
    const p = join(dir, "huge.jsonl");
    const filler = asst("old", "claude-sonnet-5-5", { input_tokens: 1, output_tokens: 1 }, "2026-11-18T09:00:00.000Z") + "\n";
    const lines: string[] = [];
    for (let i = 0; i < Math.ceil((STATS_TAIL_BYTES * 2) / filler.length); i++) lines.push(filler.replace('"old"', `"o${i}"`));
    lines.push(asst("last", "claude-sonnet-5-5", { input_tokens: 5, output_tokens: 6 }, "2026-11-18T10:00:00.000Z"));
    writeFileSync(p, lines.join(""));
    const s = collectTranscriptStats(p)!;
    assert.equal(s.truncated, true);
    assert.ok(s.turns > 1);
    assert.ok(s.turns < lines.length);
    assert.ok(s.bytesRead <= STATS_TAIL_BYTES);
    assert.match(renderStats({ transcript: s, subagents: [], exploration: undefined }), /last \d+(\.\d+)? MiB/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a single oversized line is skipped, not parsed", () => {
  const dir = tmp();
  try {
    const p = join(dir, "big.jsonl");
    const big = JSON.stringify({ type: "assistant", message: { id: "x", usage: { input_tokens: 9 }, pad: "x".repeat(3 * 1024 * 1024) } });
    writeFileSync(p, `${big}\n${asst("m", "claude-haiku-5-5", { input_tokens: 2, output_tokens: 3 }, "2026-11-18T10:00:00.000Z")}\n`);
    const s = collectTranscriptStats(p)!;
    assert.equal(s.turns, 1);
    assert.equal(s.input, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("transcript path is persisted from SessionStart and UserPromptSubmit and read back; bad paths are ignored", () => {
  const dir = tmp();
  try {
    runHook("SessionStart", JSON.stringify({ session_id: "s1", transcript_path: "/a/b/one.jsonl" }), { dataDir: dir, env: {} });
    assert.equal(readTranscriptPath("s1", { dataDir: dir }), "/a/b/one.jsonl");
    runHook("UserPromptSubmit", JSON.stringify({ session_id: "s1", prompt: "/x", transcript_path: "/a/b/two.jsonl" }), { dataDir: dir, env: {} });
    assert.equal(readTranscriptPath("s1", { dataDir: dir }), "/a/b/two.jsonl");
    for (const bad of ["relative.jsonl", "/a/b/c.txt", "/a/\u0007b.jsonl", 5, null, "/a/" + "x".repeat(5000) + ".jsonl"]) {
      recordTranscriptPath({ session_id: "s1", transcript_path: bad }, { dataDir: dir });
      assert.equal(readTranscriptPath("s1", { dataDir: dir }), "/a/b/two.jsonl");
    }
    // other state survives
    assert.ok(typeof readSessionState("s1", { dataDir: dir }).startedAt === "string");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("UserPromptSubmit output is unchanged by recording the transcript path", () => {
  const dir = tmp();
  try {
    const a = runHook("UserPromptSubmit", JSON.stringify({ session_id: "s1", prompt: "hola" }), { dataDir: dir, env: {} });
    const b = runHook("UserPromptSubmit", JSON.stringify({ session_id: "s2", prompt: "hola", transcript_path: "/a/t.jsonl" }), { dataDir: dir, env: {} });
    assert.equal(a.stdout, b.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("statsCli: transcript tokens, subagents and exploration; local only", () => {
  const dir = tmp();
  try {
    const p = join(dir, "t.jsonl");
    writeFileSync(p, FIXTURE);
    recordTranscriptPath({ session_id: "s1", transcript_path: p }, { dataDir: dir });
    recordSubagentStart({ session_id: "s1", agent_id: "a1", agent_type: "odd-claude:odd-explore" }, { dataDir: dir }, 1_000);
    recordSubagentStop({ session_id: "s1", agent_id: "a1", agent_type: "odd-claude:odd-explore" }, { dataDir: dir }, 66_000);
    updateSessionState("s1", (s) => ({ ...s, exploration: { lookups: 4, bytes: 41_000, notified: true } }), { dataDir: dir });
    const r = statsCli(["--session", "s1", "--data-dir", dir], {});
    assert.equal(r.exitCode, 0);
    assert.match(r.stdout, /turns\s+2/);
    assert.match(r.stdout, /in 13/);
    assert.match(r.stdout, /out 47/);
    assert.match(r.stdout, /cache.*150 read/);
    assert.match(r.stdout, /1 subagent.*1m05s/);
    assert.match(r.stdout, /4 lookups/);
    assert.match(r.stdout, /claude-sonnet-5-5/);
    const j = JSON.parse(statsCli(["--session", "s1", "--data-dir", dir, "--json"], {}).stdout);
    assert.equal(j.transcript.turns, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("statsCli never throws: no session, no data dir, no transcript, unreadable transcript", () => {
  const dir = tmp();
  try {
    assert.equal(statsCli([], {}).exitCode, 0);
    assert.equal(statsCli(["--session", "s1"], {}).exitCode, 0);
    const none = statsCli(["--session", "s1", "--data-dir", dir], {});
    assert.equal(none.exitCode, 0);
    assert.match(none.stdout, /no transcript/i);
    mkdirSync(join(dir, "d.jsonl"));
    recordTranscriptPath({ session_id: "s1", transcript_path: join(dir, "d.jsonl") }, { dataDir: dir });
    const bad = statsCli(["--session", "s1", "--data-dir", dir], {});
    assert.equal(bad.exitCode, 0);
    assert.match(bad.stdout, /unreadable|no transcript/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
