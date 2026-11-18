import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scratchCli } from "./scratch.js";
import { createSessionScratch } from "../lib/scratch.js";

test("scratch CLI shows the session dir, its entries and size; read-only, exit 0", () => {
  const dir = mkdtempSync(join(tmpdir(), "odd-scli-"));
  try {
    const p = createSessionScratch("s1", { dataDir: dir });
    writeFileSync(join(p, "a.txt"), "abc");
    const r = scratchCli(["--session", "s1", "--data-dir", dir]);
    assert.equal(r.exitCode, 0);
    assert.match(r.stdout, new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(r.stdout, /a\.txt/);
    assert.match(r.stdout, /3 B/);
    assert.match(r.stdout, /removed when the session ends/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scratch CLI without a session or data dir explains and exits 0", () => {
  const r = scratchCli([], {});
  assert.equal(r.exitCode, 0);
  assert.match(r.stdout, /no session/i);
});
