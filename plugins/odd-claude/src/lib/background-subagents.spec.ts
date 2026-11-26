import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  backgroundSubagentsLine,
  readBackgroundSubagents,
  resolveBackgroundSubagents,
  writeBackgroundSubagents,
} from "./background-subagents.js";
import { backgroundSubagentsCli } from "../cli/background-subagents.js";

function withDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "odd-bg-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("default is off, source default", () =>
  withDir((dir) => {
    assert.deepEqual(resolveBackgroundSubagents({ dataDir: dir, env: {} }), { policy: "off", source: "default", malformed: false });
    assert.equal(readBackgroundSubagents({ env: { ODD_CLAUDE_HOME: join(dir, "nohome") } }), "off"); // nothing stored under the home default
  }));

test("set on/off round-trips through plugin state and wins over the environment", () =>
  withDir((dir) => {
    const env = { ODD_CLAUDE_BACKGROUND_SUBAGENTS: "off" };
    assert.equal(writeBackgroundSubagents("on", { dataDir: dir }), "on");
    assert.deepEqual(resolveBackgroundSubagents({ dataDir: dir, env }), { policy: "on", source: "state", malformed: false });
    writeBackgroundSubagents("off", { dataDir: dir });
    assert.equal(readBackgroundSubagents({ dataDir: dir, env: {} }), "off");
  }));

test("environment applies when no state exists; unknown env values are inert", () =>
  withDir((dir) => {
    assert.deepEqual(resolveBackgroundSubagents({ dataDir: dir, env: { ODD_CLAUDE_BACKGROUND_SUBAGENTS: "on" } }), {
      policy: "on", source: "environment", malformed: false,
    });
    assert.equal(resolveBackgroundSubagents({ dataDir: dir, env: { ODD_CLAUDE_BACKGROUND_SUBAGENTS: "yes" } }).source, "default");
  }));

test("invalid policy throws and leaves the stored value untouched", () =>
  withDir((dir) => {
    writeBackgroundSubagents("on", { dataDir: dir });
    assert.throws(() => writeBackgroundSubagents("maybe", { dataDir: dir }), /invalid policy "maybe"/);
    assert.equal(readBackgroundSubagents({ dataDir: dir, env: {} }), "on");
  }));

test("a malformed state file fails closed to off and is reported", () =>
  withDir((dir) => {
    writeFileSync(join(dir, "background-subagents.json"), JSON.stringify({ version: 1, sessionId: "x", data: { policy: "sure" } }));
    assert.deepEqual(resolveBackgroundSubagents({ dataDir: dir, env: { ODD_CLAUDE_BACKGROUND_SUBAGENTS: "on" } }), {
      policy: "off", source: "state", malformed: true,
    });
  }));

test("context line states the policy and the run_in_background consequence", () => {
  assert.match(backgroundSubagentsLine("on"), /^Background subagents: on/);
  assert.match(backgroundSubagentsLine("on"), /run_in_background/);
  assert.match(backgroundSubagentsLine("off"), /^Background subagents: off/);
  assert.match(backgroundSubagentsLine("off"), /foreground/);
});

test("CLI: status, enable, disable, invalid action", () =>
  withDir((dir) => {
    const env = { CLAUDE_PLUGIN_DATA: dir };
    const s = backgroundSubagentsCli(["--data-dir", dir], env);
    assert.equal(s.exitCode, 0);
    assert.match(s.stdout, /background subagents: off \(default\)/);
    const e = backgroundSubagentsCli(["--action", "enable", "--data-dir", dir], {});
    assert.equal(e.exitCode, 0);
    assert.match(e.stdout, /set to: on/);
    assert.equal(JSON.parse(readFileSync(join(dir, "background-subagents.json"), "utf8")).data.policy, "on");
    assert.match(backgroundSubagentsCli(["--data-dir", dir], {}).stdout, /background subagents: on \(state\)/);
    assert.equal(backgroundSubagentsCli(["--action", "disable", "--data-dir", dir], {}).exitCode, 0);
    assert.match(backgroundSubagentsCli(["--action", "status", "--data-dir", dir], {}).stdout, /: off \(state\)/);
    const bad = backgroundSubagentsCli(["--action", "maybe", "--data-dir", dir], {});
    assert.equal(bad.exitCode, 1);
    assert.match(bad.stderr, /invalid action "maybe"/);
    assert.match(backgroundSubagentsCli(["--data-dir", dir], {}).stdout, /: off \(state\)/);
    assert.equal(backgroundSubagentsCli(["--action", "enable"], { ODD_CLAUDE_HOME: join(dir, "home") }).exitCode, 0); // home default data dir
    assert.match(backgroundSubagentsCli(["--action", "status"], { ODD_CLAUDE_HOME: join(dir, "home") }).stdout, /: on \(state\)/);
    assert.equal(backgroundSubagentsCli(["--bogus"], {}).exitCode, 2);
  }));
