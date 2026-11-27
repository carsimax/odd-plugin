import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHookEntries, installHooks, mergeHooks, uninstallHooks, unmergeHooks } from "./hooks-config.js";

const HOOKS_JSON = {
  hooks: {
    SessionStart: [{ hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/dist/hooks/run.js" SessionStart' }] }],
    PreToolUse: [{ matcher: "Bash|Edit|Write|NotebookEdit", hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/dist/hooks/run.js" PreToolUse', timeout: 30 }] }],
    PostToolUse: [
      {
        matcher: "Read|Grep|mcp__codegraph__.*|mcp__plugin_odd-claude_codegraph__.*",
        hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/dist/hooks/run.js" PostToolUse', timeout: 5 }],
      },
    ],
    SubagentStart: [{ hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/dist/hooks/run.js" SubagentStart', timeout: 5, async: true }] }],
  },
};

function sandbox(initialSettings?: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "odd-hooks-"));
  const oddRoot = join(dir, "odd", "current");
  mkdirSync(join(oddRoot, "hooks"), { recursive: true });
  writeFileSync(join(oddRoot, "hooks", "hooks.json"), JSON.stringify(HOOKS_JSON));
  const settingsPath = join(dir, "settings.json");
  if (initialSettings !== undefined) writeFileSync(settingsPath, JSON.stringify(initialSettings, null, 2) + "\n");
  const defaultOddHome = join(dir, "odd");
  return {
    dir,
    oddRoot,
    settingsPath,
    backupDir: join(dir, "odd", "backups"),
    oddHome: defaultOddHome,
    defaultOddHome,
    read: () => JSON.parse(readFileSync(settingsPath, "utf8")),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const FOREIGN = { hooks: [{ type: "command", command: "foreign.sh" }] };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

test("buildHookEntries mirrors events, matchers, timeouts and async from hooks.json", () => {
  const s = sandbox();
  try {
    const e = buildHookEntries(s);
    assert.deepEqual(Object.keys(e), ["SessionStart", "PreToolUse", "PostToolUse", "SubagentStart"]);
    const run = `node "${s.oddRoot}/dist/hooks/run.js"`;
    assert.deepEqual(e.SessionStart, [{ hooks: [{ type: "command", command: `${run} SessionStart` }] }]);
    assert.deepEqual(e.PreToolUse, [{ matcher: "Bash|Edit|Write|NotebookEdit", hooks: [{ type: "command", command: `${run} PreToolUse`, timeout: 30 }] }]);
    assert.deepEqual(e.SubagentStart[0].hooks[0], { type: "command", command: `${run} SubagentStart`, timeout: 5, async: true });
  } finally {
    s.cleanup();
  }
});

test("buildHookEntries drops the plugin-namespaced codegraph matcher alternative", () => {
  const s = sandbox();
  try {
    assert.equal(buildHookEntries(s).PostToolUse[0].matcher, "Read|Grep|mcp__codegraph__.*");
  } finally {
    s.cleanup();
  }
});

test("buildHookEntries prefixes ODD_CLAUDE_HOME only for a non-default home", () => {
  const s = sandbox();
  try {
    const e = buildHookEntries({ ...s, oddHome: "/custom/home" });
    assert.equal(e.SessionStart[0].hooks[0].command, `ODD_CLAUDE_HOME="/custom/home" node "${s.oddRoot}/dist/hooks/run.js" SessionStart`);
  } finally {
    s.cleanup();
  }
});

test("mergeHooks is idempotent and keeps foreign hooks in order", () => {
  const s = sandbox();
  try {
    const entries = buildHookEntries(s);
    const before = { theme: "x", hooks: { SessionStart: [FOREIGN], Notification: [FOREIGN] } };
    const once = mergeHooks(before, entries) as Any;
    assert.deepEqual(once.hooks.SessionStart[0], FOREIGN);
    assert.equal(once.hooks.SessionStart.length, 2);
    assert.deepEqual(once.hooks.Notification, [FOREIGN]);
    assert.deepEqual(Object.keys(once.hooks).slice(0, 2), ["SessionStart", "Notification"]);
    assert.equal(once.theme, "x");
    assert.deepEqual(mergeHooks(once, entries), once);
    assert.equal(before.hooks.SessionStart.length, 1, "input is not mutated");
  } finally {
    s.cleanup();
  }
});

test("mergeHooks refreshes our entry in place when its definition changed", () => {
  const s = sandbox();
  try {
    const once = mergeHooks({ hooks: { PreToolUse: [FOREIGN] } }, buildHookEntries(s));
    const entries = buildHookEntries(s);
    entries.PreToolUse[0].hooks[0].timeout = 99;
    const twice = mergeHooks(once, entries) as Any;
    assert.equal(twice.hooks.PreToolUse.length, 2);
    assert.equal(twice.hooks.PreToolUse[1].hooks[0].timeout, 99);
  } finally {
    s.cleanup();
  }
});

test("unmergeHooks removes exactly ours, keeps foreign (even in a shared group) and drops empties", () => {
  const s = sandbox();
  try {
    const entries = buildHookEntries(s);
    const mixed = { hooks: { SessionStart: [{ hooks: [FOREIGN.hooks[0], entries.SessionStart[0].hooks[0]] }], PreToolUse: [FOREIGN] } };
    const out = unmergeHooks(mergeHooks(mixed, entries), s.oddRoot);
    assert.deepEqual(out, { hooks: { SessionStart: [FOREIGN], PreToolUse: [FOREIGN] } });
    assert.deepEqual(unmergeHooks(mergeHooks({ a: 1 }, entries), s.oddRoot), { a: 1 });
  } finally {
    s.cleanup();
  }
});

test("installHooks backs up, writes atomically and is idempotent; uninstallHooks restores the foreign content", () => {
  const s = sandbox({ theme: "x", hooks: { Stop: [FOREIGN] } });
  try {
    const r = installHooks(s);
    assert.equal(r.status, "applied");
    assert.equal(readdirSync(s.backupDir).length, 1);
    const after = readFileSync(s.settingsPath, "utf8");
    assert.ok(after.endsWith("\n"));
    assert.equal(installHooks(s).status, "unchanged");
    assert.equal(readFileSync(s.settingsPath, "utf8"), after);
    const u = uninstallHooks(s);
    assert.equal(u.status, "applied");
    assert.deepEqual(s.read(), { theme: "x", hooks: { Stop: [FOREIGN] } });
    assert.equal(uninstallHooks(s).status, "unchanged");
  } finally {
    s.cleanup();
  }
});

test("installHooks refuses invalid settings JSON and uninstall without a settings file is a no-op", () => {
  const s = sandbox();
  try {
    assert.equal(uninstallHooks(s).status, "unchanged");
    writeFileSync(s.settingsPath, "{oops");
    const r = installHooks(s);
    assert.equal(r.status, "error");
    assert.equal(readFileSync(s.settingsPath, "utf8"), "{oops");
  } finally {
    s.cleanup();
  }
});

test("installHooks drops odd events a newer hooks.json no longer ships and keeps foreign hooks", () => {
  const s = sandbox({ hooks: { SubagentStart: [FOREIGN] } });
  try {
    installHooks(s);
    assert.equal(s.read().hooks.SubagentStart.length, 2);
    const { SubagentStart: _gone, ...rest } = HOOKS_JSON.hooks;
    writeFileSync(join(s.oddRoot, "hooks", "hooks.json"), JSON.stringify({ hooks: rest }));
    installHooks(s);
    assert.deepEqual(s.read().hooks.SubagentStart, [FOREIGN]);
    assert.ok(s.read().hooks.SessionStart);
  } finally {
    s.cleanup();
  }
});
