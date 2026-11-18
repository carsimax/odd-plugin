import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupCli } from "./setup.js";

const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

function box() {
  const dir = mkdtempSync(join(tmpdir(), "odd-setup-err-"));
  return { dir, data: join(dir, "data"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// F4
test("--settings pointing to a directory: error on stderr, exit 1 (dry run and apply)", () => {
  const b = box();
  try {
    const asDir = join(b.dir, "adir");
    mkdirSync(asDir);
    for (const extra of [[], ["--apply"]]) {
      const r = setupCli(["--mode", "plan", ...extra, "--settings", asDir, "--data-dir", b.data], {});
      assert.equal(r.exitCode, 1);
      assert.match(r.stderr, /^error: /);
      assert.equal(r.stdout, "");
    }
    const info = setupCli(["--settings", asDir, "--data-dir", b.data], {});
    assert.equal(info.exitCode, 1);
    assert.match(info.stderr, /^error: /);
  } finally {
    b.cleanup();
  }
});

test("unreadable settings (chmod 000): error on stderr, exit 1", { skip: isRoot }, () => {
  const b = box();
  const f = join(b.dir, "settings.json");
  try {
    writeFileSync(f, "{}");
    chmodSync(f, 0o000);
    for (const extra of [[], ["--apply"]]) {
      const r = setupCli(["--mode", "plan", ...extra, "--settings", f, "--data-dir", b.data], {});
      assert.equal(r.exitCode, 1);
      assert.match(r.stderr, /^error: /);
    }
  } finally {
    chmodSync(f, 0o600);
    b.cleanup();
  }
});

test("handled errors go to stderr as `error: <message>`", () => {
  const b = box();
  try {
    const f = join(b.dir, "settings.json");
    writeFileSync(f, "{}");
    const r = setupCli(["--mode", "yolo", "--settings", f, "--data-dir", b.data], {});
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /^error: invalid mode/);
  } finally {
    b.cleanup();
  }
});

// F7
test("--json with no data dir emits a JSON error object (exit 2)", () => {
  const b = box();
  try {
    const f = join(b.dir, "settings.json");
    writeFileSync(f, "{}");
    const r = setupCli(["--mode", "plan", "--apply", "--json", "--settings", f], {});
    assert.equal(r.exitCode, 2);
    const o = JSON.parse(r.stdout);
    assert.equal(o.status, "error");
    assert.match(o.error, /data dir/);
    const u = setupCli(["--bogus", "--json"], {});
    assert.equal(u.exitCode, 2);
    assert.equal(JSON.parse(u.stdout).status, "error");
  } finally {
    b.cleanup();
  }
});

test("--help documents exit codes and the known limitations", () => {
  const r = setupCli(["--help"], {});
  assert.equal(r.exitCode, 0);
  assert.match(r.stdout, /exit codes/i);
  assert.match(r.stdout, /reserializ/i);
  assert.match(r.stdout, /toggle/i);
});
