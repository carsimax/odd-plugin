import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { coordinatorCli } from "./coordinator.js";
import { readDelegationMode } from "../lib/context.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "odd-ccli-"));
}

test("status (default and explicit) reports ON when nothing is stored, writes nothing", () => {
  const dir = tmp();
  try {
    for (const argv of [["--data-dir", dir], ["--action", "status", "--data-dir", dir]]) {
      const r = coordinatorCli(argv, {});
      assert.equal(r.exitCode, 0);
      assert.match(r.stdout, /coordinator mode: on \(default\)/);
      assert.match(r.stdout, /available actions: on, off, status/);
      assert.equal(r.stderr, "");
    }
    assert.equal(readDelegationMode({ dataDir: dir }), "full");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("off then on store the mode and status reflects it; both say when it applies", () => {
  const dir = tmp();
  try {
    const off = coordinatorCli(["--action", "off", "--data-dir", dir], {});
    assert.equal(off.exitCode, 0);
    assert.match(off.stdout, /coordinator mode set to: off/);
    assert.match(off.stdout, /next session start/);
    assert.equal(readDelegationMode({ dataDir: dir }), "organic");
    assert.match(coordinatorCli(["--data-dir", dir], {}).stdout, /coordinator mode: off \(stored\)/);
    const on = coordinatorCli(["--action", "on"], { CLAUDE_PLUGIN_DATA: dir });
    assert.equal(on.exitCode, 0);
    assert.match(on.stdout, /coordinator mode set to: on/);
    assert.equal(readDelegationMode({ dataDir: dir }), "full");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("output never claims enforcement", () => {
  const dir = tmp();
  try {
    const r = coordinatorCli(["--action", "on", "--data-dir", dir], {});
    assert.match(r.stdout, /prompt rule/);
    assert.match(r.stdout, /no hook blocks edits/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("invalid action: exit 1, stderr error, stored mode unchanged", () => {
  const dir = tmp();
  try {
    coordinatorCli(["--action", "off", "--data-dir", dir], {});
    const r = coordinatorCli(["--action", "maybe", "--data-dir", dir], {});
    assert.equal(r.exitCode, 1);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /^error: invalid action "maybe"; available actions: on, off, status$/);
    assert.equal(readDelegationMode({ dataDir: dir }), "organic");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("corrupt delegation.json reads as the default ON; --action ON is rejected and leaves the state bytes unchanged", () => {
  const dir = tmp();
  try {
    const file = join(dir, "delegation.json");
    writeFileSync(file, "{garbage");
    const digest = (): string => createHash("sha256").update(readFileSync(file)).digest("hex");
    const before = digest();
    const st = coordinatorCli(["--data-dir", dir], {});
    assert.equal(st.exitCode, 0);
    assert.match(st.stdout, /^coordinator mode: on \(default\)/);
    const r = coordinatorCli(["--action", "ON", "--data-dir", dir], {});
    assert.equal(r.exitCode, 1);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /^error: invalid action "ON"/);
    assert.equal(digest(), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("usage errors exit 2: unknown flag, missing value, set without a data dir", () => {
  assert.equal(coordinatorCli(["--bogus"], {}).exitCode, 2);
  assert.equal(coordinatorCli(["--action"], {}).exitCode, 2);
  const r = coordinatorCli(["--action", "off"], {});
  assert.equal(r.exitCode, 2);
  assert.match(r.stderr, /no data dir/);
});
