import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHook } from "./run.js";

function repoWithDoc(): { root: string; data: string; done: () => void } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "odd-ss-repo-")));
  const data = mkdtempSync(join(tmpdir(), "odd-ss-data-"));
  const r = spawnSync("git", ["-C", root, "init", "-q", "-b", "feat/reinject"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  mkdirSync(join(root, "odd", "tasks"), { recursive: true });
  writeFileSync(join(root, "odd", "tasks", "f.md"), "# Reinject feature\nBranch: `feat/reinject`.\n\n## Specs\n- **S1** one\n\n## Tasks\n- T1 | S1 | worker | pending — open\n\n## Log\n- L1: only entry\n");
  return { root, data, done: () => { rmSync(root, { recursive: true, force: true }); rmSync(data, { recursive: true, force: true }); } };
}

const ctx = (root: string, data: string, source: string): string =>
  JSON.parse(runHook("SessionStart", JSON.stringify({ session_id: "s-reinject-1", cwd: root, source }), { dataDir: data, env: { CLAUDE_PLUGIN_ROOT: "/r/odd" } }).stdout).hookSpecificOutput.additionalContext;

for (const source of ["compact", "resume"]) {
  test(`SessionStart ${source} appends the active feature document summary`, () => {
    const r = repoWithDoc();
    try {
      const c = ctx(r.root, r.data, source);
      assert.match(c, /Active ODD feature document \(reinjected\): odd\/tasks\/f\.md/);
      assert.match(c, /Specs: S1/);
      assert.match(c, /T1 \| S1 \| worker \| pending/);
      assert.match(c, /Coordinator mode: (ON|OFF)/);
      assert.doesNotMatch(c, /Persona mode|Cards directory:|same language the user writes in/);
    } finally {
      r.done();
    }
  });
}

for (const source of ["startup", "clear"]) {
  test(`SessionStart ${source} adds no feature document summary`, () => {
    const r = repoWithDoc();
    try {
      assert.doesNotMatch(ctx(r.root, r.data, source), /Active ODD feature document/);
    } finally {
      r.done();
    }
  });
}

test("SessionStart compact outside a git repository stays silent about the feature document and does not fail", () => {
  const dir = mkdtempSync(join(tmpdir(), "odd-ss-nogit-"));
  try {
    assert.doesNotMatch(ctx(dir, dir, "compact"), /Active ODD feature document/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SessionStart prunes per-session files older than 7 days, keeping fresh, current and locked ones", () => {
  const data = mkdtempSync(join(tmpdir(), "odd-ss-prune-"));
  try {
    const old = new Date(Date.now() - 8 * 86_400_000);
    const files = ["sessions/old.json", "sessions/cur.json", "sessions/held.json", "sessions/held.json.lock", "sessions/new.json", "status/old.json", "status/cur.json", "status/new.json"];
    for (const f of files) {
      mkdirSync(join(data, f, ".."), { recursive: true });
      writeFileSync(join(data, f), "{}");
      if (!f.includes("new")) utimesSync(join(data, f), old, old);
    }
    runHook("SessionStart", JSON.stringify({ session_id: "cur", source: "startup" }), { dataDir: data, env: {} });
    const left = (f: string) => existsSync(join(data, f));
    assert.equal(left("sessions/old.json"), false);
    assert.equal(left("status/old.json"), false);
    for (const f of ["sessions/cur.json", "sessions/held.json", "sessions/held.json.lock", "sessions/new.json", "status/cur.json", "status/new.json"]) assert.ok(left(f), f);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("SessionStart prune keeps the current id's sanitized files and non-.json leftovers; a newer-schema state file survives a hook update", () => {
  const data = mkdtempSync(join(tmpdir(), "odd-ss-prune2-"));
  try {
    const old = new Date(Date.now() - 8 * 86_400_000);
    const kept = ["sessions/a_b.json", "status/a_b.json", "sessions/x.json.1.2.tmp", "sessions/y.json.lock.1.stale", "sessions/notes.txt"];
    for (const f of kept) {
      mkdirSync(join(data, f, ".."), { recursive: true });
      writeFileSync(join(data, f), "{}");
      utimesSync(join(data, f), old, old);
    }
    runHook("SessionStart", JSON.stringify({ session_id: "a/b", source: "startup" }), { dataDir: data, env: {} });
    for (const f of kept) assert.ok(existsSync(join(data, f)), f);
    const v = join(data, "sessions", "v.json");
    const raw = JSON.stringify({ version: 2, sessionId: "v", data: { keep: 1 } });
    writeFileSync(v, raw);
    const r = runHook("PostToolUse", JSON.stringify({ session_id: "v", tool_name: "Read", tool_response: "x" }), { dataDir: data, env: {} });
    assert.equal(r.exitCode, 0);
    assert.equal(readFileSync(v, "utf8"), raw);
    assert.equal(existsSync(`${v}.lock`), false);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});
