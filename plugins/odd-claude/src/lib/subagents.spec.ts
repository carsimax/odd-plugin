import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSubagents, recordSubagentStart, recordSubagentStop, formatDuration, MAX_SUBAGENTS } from "./subagents.js";
import { readSessionState, updateSessionState } from "./state.js";
import { runHook } from "../hooks/run.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "odd-subagents-"));
}

test("start then stop records one entry with type, start, end", () => {
  const dir = tmp();
  try {
    recordSubagentStart({ session_id: "s1", agent_id: "a1", agent_type: "odd-claude:odd-explore" }, { dataDir: dir }, 1_000);
    assert.deepEqual(readSubagents("s1", { dataDir: dir }), [{ id: "a1", type: "odd-claude:odd-explore", startedAt: 1_000 }]);
    recordSubagentStop({ session_id: "s1", agent_id: "a1", agent_type: "odd-claude:odd-explore" }, { dataDir: dir }, 4_500);
    assert.deepEqual(readSubagents("s1", { dataDir: dir }), [{ id: "a1", type: "odd-claude:odd-explore", startedAt: 1_000, endedAt: 4_500 }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stop without a recorded start adds an ended entry with unknown start; other state keys survive", () => {
  const dir = tmp();
  try {
    updateSessionState("s1", (s) => ({ ...s, keep: 7 }), { dataDir: dir });
    recordSubagentStop({ session_id: "s1", agent_id: "zz", agent_type: "general-purpose" }, { dataDir: dir }, 9_000);
    assert.deepEqual(readSubagents("s1", { dataDir: dir }), [{ id: "zz", type: "general-purpose", endedAt: 9_000 }]);
    assert.equal(readSessionState("s1", { dataDir: dir }).keep, 7);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("missing session id, missing data dir or garbage input never throw and write nothing", () => {
  const dir = tmp();
  try {
    recordSubagentStart({}, { dataDir: dir });
    recordSubagentStart({ session_id: "s1", agent_id: 5 }, { dataDir: dir });
    const home = { env: { ODD_CLAUDE_HOME: join(dir, "home") } };
    recordSubagentStart({ session_id: "s1", agent_id: "a" }, home); // no data dir env: the home default
    assert.deepEqual(readSubagents("s1", { dataDir: dir }), []);
    assert.equal(readSubagents("s1", home).length, 1);
    assert.deepEqual(readSubagents("nope", home), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the list is capped to the newest MAX_SUBAGENTS entries", () => {
  const dir = tmp();
  try {
    for (let i = 0; i < MAX_SUBAGENTS + 5; i++) recordSubagentStart({ session_id: "s1", agent_id: `a${i}`, agent_type: "t" }, { dataDir: dir }, i);
    const list = readSubagents("s1", { dataDir: dir });
    assert.equal(list.length, MAX_SUBAGENTS);
    assert.equal(list[0]!.id, "a5");
    assert.equal(list.at(-1)!.id, `a${MAX_SUBAGENTS + 4}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("formatDuration", () => {
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(3_400), "3s");
  assert.equal(formatDuration(65_000), "1m05s");
  assert.equal(formatDuration(3_725_000), "1h02m05s");
  assert.equal(formatDuration(-5), "0s");
});

test("hooks SubagentStart/SubagentStop record state and print nothing", () => {
  const dir = tmp();
  try {
    const a = runHook("SubagentStart", JSON.stringify({ session_id: "s9", agent_id: "x1", agent_type: "odd-claude:odd-explore" }), { dataDir: dir });
    assert.deepEqual(a, { exitCode: 0, stdout: "" });
    const b = runHook("SubagentStop", JSON.stringify({ session_id: "s9", agent_id: "x1", agent_type: "odd-claude:odd-explore" }), { dataDir: dir });
    assert.deepEqual(b, { exitCode: 0, stdout: "" });
    const [e] = readSubagents("s9", { dataDir: dir });
    assert.equal(e!.id, "x1");
    assert.equal(typeof e!.startedAt, "number");
    assert.equal(typeof e!.endedAt, "number");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
