import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { personaCli } from "./persona.js";
import { readPersona } from "../lib/persona.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "odd-pcli-"));
}

test("no argument prints the current persona and the modes, writes nothing", () => {
  const dir = tmp();
  try {
    const r = personaCli(["--data-dir", dir], {});
    assert.equal(r.exitCode, 0);
    assert.match(r.stdout, /persona: neutral/);
    assert.match(r.stdout, /available modes: neutral$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--mode sets the persona (via --data-dir or CLAUDE_PLUGIN_DATA)", () => {
  const dir = tmp();
  try {
    const r = personaCli(["--mode", "neutral", "--data-dir", dir], {});
    assert.equal(r.exitCode, 0);
    assert.match(r.stdout, /persona set to: neutral/);
    assert.equal(readPersona({ dataDir: dir }), "neutral");
    assert.equal(personaCli(["--mode", "neutral"], { CLAUDE_PLUGIN_DATA: dir }).exitCode, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--mode mentor is refused: exit 1, clear message, state unchanged", () => {
  const dir = tmp();
  try {
    const r = personaCli(["--mode", "mentor", "--data-dir", dir], {});
    assert.notEqual(r.exitCode, 0);
    assert.equal(r.exitCode, 1);
    assert.equal(r.stdout, "");
    assert.equal(r.stderr, 'error: invalid persona "mentor"; available modes: neutral');
    assert.equal(existsSync(join(dir, "persona.json")), false);
    assert.equal(readPersona({ dataDir: dir }), "neutral");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("invalid mode: exit 1, stderr error, stored persona unchanged", () => {
  const dir = tmp();
  try {
    personaCli(["--mode", "neutral", "--data-dir", dir], {});
    const r = personaCli(["--mode", "pirate", "--data-dir", dir], {});
    assert.equal(r.exitCode, 1);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /^error: invalid persona "pirate"/);
    assert.equal(readPersona({ dataDir: dir }), "neutral");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("usage errors exit 2; missing data dir on write exits 2", () => {
  assert.equal(personaCli(["--bogus"], {}).exitCode, 2);
  assert.equal(personaCli(["--mode"], {}).exitCode, 2);
  const r = personaCli(["--mode", "neutral"], {});
  assert.equal(r.exitCode, 2);
  assert.match(r.stderr, /no data dir/);
});
