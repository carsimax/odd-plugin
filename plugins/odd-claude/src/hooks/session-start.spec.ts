import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
      assert.match(c, /Persona mode/);
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
