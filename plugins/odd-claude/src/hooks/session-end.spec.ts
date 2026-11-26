import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHook } from "./run.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "odd-se-"));
}
const run = (event: string, stdin: string, dir: string) => runHook(event, stdin, { dataDir: dir, env: { CLAUDE_PLUGIN_ROOT: "/r/odd" } });
const end = (input: object, dir: string) => run("SessionEnd", JSON.stringify(input), dir);
const log = (dir: string) => (existsSync(join(dir, "logs", "hooks.log")) ? readFileSync(join(dir, "logs", "hooks.log"), "utf8") : "");
const TITLE_CLEAR = "\u001b]0;\u0007";

test("SessionEnd prints the resume hint and also logs it for headless runs", () => {
  const dir = tmp();
  try {
    const r = end({ session_id: "abc-1_X", reason: "logout" }, dir);
    assert.equal(r.exitCode, 0);
    assert.deepEqual(JSON.parse(r.stdout), { terminalSequence: TITLE_CLEAR, systemMessage: "odd-claude: resume this session with `claude --resume abc-1_X`" });
    assert.match(log(dir), /SessionEnd: resume with: claude --resume abc-1_X/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SessionEnd with reason clear prints only the title reset and logs no resume hint", () => {
  const dir = tmp();
  try {
    const r = end({ session_id: "s1", reason: "clear" }, dir);
    assert.equal(r.exitCode, 0);
    assert.deepEqual(JSON.parse(r.stdout), { terminalSequence: TITLE_CLEAR });
    assert.doesNotMatch(log(dir), /resume with/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SessionEnd removes the session scratch with its contents and leaves other sessions untouched", () => {
  const dir = tmp();
  try {
    mkdirSync(join(dir, "scratch", "s1", "sub"), { recursive: true });
    mkdirSync(join(dir, "scratch", "s2"), { recursive: true });
    end({ session_id: "s1" }, dir);
    assert.equal(existsSync(join(dir, "scratch", "s1")), false);
    assert.ok(existsSync(join(dir, "scratch", "s2")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SessionEnd marks the status file ended even when no SessionStart ran", () => {
  const dir = tmp();
  try {
    end({ session_id: "s9", cwd: "/w/p" }, dir);
    const s = JSON.parse(readFileSync(join(dir, "status", "s9.json"), "utf8"));
    assert.equal(s.state, "ended");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SessionEnd without a session id only clears the title: no hint, no status, no log", () => {
  const dir = tmp();
  try {
    for (const input of [{}, { reason: "other" }, { session_id: 7 }]) {
      const r = end(input, dir);
      assert.equal(r.exitCode, 0);
      assert.deepEqual(JSON.parse(r.stdout), { terminalSequence: TITLE_CLEAR });
    }
    assert.equal(existsSync(join(dir, "status")), false);
    assert.doesNotMatch(log(dir), /resume with/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SessionEnd with an unsafe session id prints no resume hint and removes no scratch outside its own", () => {
  const dir = tmp();
  try {
    mkdirSync(join(dir, "scratch", "keep"), { recursive: true });
    for (const id of ["../keep", "a b", "x".repeat(129)]) {
      const r = end({ session_id: id }, dir);
      assert.equal(r.exitCode, 0);
      assert.deepEqual(JSON.parse(r.stdout), { terminalSequence: TITLE_CLEAR });
    }
    assert.ok(existsSync(join(dir, "scratch", "keep")));
    assert.doesNotMatch(log(dir), /resume with/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SessionEnd with empty or malformed stdin exits 0 with no output", () => {
  const dir = tmp();
  try {
    assert.equal(run("SessionEnd", "{bad", dir).exitCode, 0);
    assert.equal(run("SessionEnd", "{bad", dir).stdout, "");
    const empty = run("SessionEnd", "", dir);
    assert.equal(empty.exitCode, 0);
    assert.deepEqual(JSON.parse(empty.stdout), { terminalSequence: TITLE_CLEAR });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
