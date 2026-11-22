import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { profilesCli } from "./profiles.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "odd-profiles-cli-"));
}

test("S2/S4: with no stored profile `show` prints the balanced table incl. review-refuter and review-validator", () => {
  const dir = tmp();
  try {
    const r = profilesCli(["show", "--data-dir", dir], {});
    assert.equal(r.exitCode, 0);
    assert.equal(r.stderr, "");
    assert.match(r.stdout, /^active: balanced/);
    assert.match(r.stdout, /review-refuter\s+opus\s+medium/);
    assert.match(r.stdout, /review-validator\s+opus\s+medium/);
    assert.match(r.stdout, /odd-explore\s+haiku\s+medium/);
    assert.match(r.stdout, /odd-verify\s+opus\s+medium/);
    assert.match(r.stdout, /odd-jd-judge-b\s+sonnet\s+medium/);
    assert.deepEqual(readdirSync(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S2: use economy -> economy, clear -> back to balanced (not to no routing)", () => {
  const dir = tmp();
  try {
    const run = (...a: string[]) => profilesCli([...a, "--data-dir", dir], {});
    assert.equal(run("use", "economy").exitCode, 0);
    assert.match(run("show").stdout, /^active: economy/);
    const cleared = run("clear");
    assert.equal(cleared.exitCode, 0);
    assert.match(cleared.stdout, /balanced/);
    assert.match(run("show").stdout, /^active: balanced[\s\S]*review-refuter\s+opus/);
    assert.match(run("list").stdout, /\* balanced/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
