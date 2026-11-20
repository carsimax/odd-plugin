import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reviewModeCli } from "./review-mode.js";

function fx(): { data: string; repo: string; cleanup: () => void } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "odd-rmcli-")));
  const repo = join(dir, "repo");
  mkdirSync(repo);
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (k.toUpperCase().startsWith("GIT_")) delete env[k];
  assert.equal(spawnSync("git", ["-C", repo, "init", "-q", "-b", "main"], { env }).status, 0);
  return { data: join(dir, "data"), repo, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("status defaults to off, is read-only and names both sources", () => {
  const f = fx();
  try {
    const r = reviewModeCli(["status", "--cwd", f.repo, "--data-dir", f.data], {});
    assert.equal(r.exitCode, 0);
    assert.equal(r.stderr, "");
    assert.match(r.stdout, /review-driven development: off \(decided by default\)/);
    assert.match(r.stdout, /global:\s+unset/);
    assert.match(r.stdout, /clone-local:\s+unset/);
    assert.equal(existsSync(f.data), false);
    assert.equal(reviewModeCli([], { CLAUDE_PLUGIN_DATA: f.data }).exitCode, 2); // a verb is required
  } finally {
    f.cleanup();
  }
});

test("enable/disable per scope, --json, and the clone note when the global switch decides", () => {
  const f = fx();
  try {
    const on = reviewModeCli(["enable", "--cwd", f.repo, "--data-dir", f.data], {});
    assert.equal(on.exitCode, 0);
    assert.match(on.stdout, /review-driven development: on \(decided by global\)/);
    const cloneOff = reviewModeCli(["disable", "--scope", "clone", "--cwd", f.repo, "--data-dir", f.data], {});
    assert.match(cloneOff.stdout, /off \(decided by clone-local\)/);
    const json = reviewModeCli(["status", "--json", "--cwd", f.repo, "--data-dir", f.data], {});
    assert.deepEqual(JSON.parse(json.stdout), {
      schema: "odd-claude.review-mode/v1", operation: "status", scope: "both",
      status: { effective: "off", source: "clone-local", global: "on", cloneLocal: "off", problems: [] },
    });
    const cleared = reviewModeCli(["enable", "--scope", "clone", "--cwd", f.repo, "--data-dir", f.data], {});
    assert.match(cleared.stdout, /on \(decided by global\)/);
    reviewModeCli(["disable", "--data-dir", f.data], {});
    const note = reviewModeCli(["enable", "--scope", "clone", "--cwd", f.repo, "--data-dir", f.data], {});
    assert.match(note.stdout, /off \(decided by global\)/);
    assert.match(note.stdout, /can only disable/);
  } finally {
    f.cleanup();
  }
});

test("usage errors exit 2 and write nothing; a failing write exits 1", () => {
  const f = fx();
  try {
    for (const argv of [["bogus"], ["enable", "--scope", "weird"], ["enable", "--scope"], ["enable", "--nope"], ["enable", "extra", "more"]]) {
      const r = reviewModeCli([...argv, "--data-dir", f.data], {});
      assert.equal(r.exitCode, 2, argv.join(" "));
      assert.equal(r.stdout, "");
      assert.match(r.stderr, /usage/);
    }
    assert.equal(existsSync(f.data), false);
    const noData = reviewModeCli(["enable"], {});
    assert.equal(noData.exitCode, 1);
    assert.match(noData.stderr, /cannot write the global review mode/);
    const noRepo = reviewModeCli(["disable", "--scope", "clone", "--cwd", join(f.repo, "..", "nowhere"), "--data-dir", f.data], {});
    assert.equal(noRepo.exitCode, 1);
    assert.equal(existsSync(f.data), false);
  } finally {
    f.cleanup();
  }
});
