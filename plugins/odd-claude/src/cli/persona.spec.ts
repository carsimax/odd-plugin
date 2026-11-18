import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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
    assert.match(r.stdout, /persona: mentor/);
    assert.match(r.stdout, /available modes: mentor, neutral/);
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
    assert.equal(personaCli(["--mode", "mentor"], { CLAUDE_PLUGIN_DATA: dir }).exitCode, 0);
    assert.equal(readPersona({ dataDir: dir }), "mentor");
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
