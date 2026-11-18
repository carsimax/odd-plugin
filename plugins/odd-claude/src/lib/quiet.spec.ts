import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { quietEnabled, setQuietEnabled } from "./quiet.js";
import { quietCli } from "../cli/quiet.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "odd-quiet-"));
}

test("quiet is OFF by default and the state flag toggles it", () => {
  const dir = tmp();
  try {
    assert.equal(quietEnabled({ dataDir: dir }), false);
    setQuietEnabled(true, { dataDir: dir });
    assert.equal(quietEnabled({ dataDir: dir }), true);
    // the mod reads this exact envelope through $.fs
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "quiet.json"), "utf8")), { version: 1, sessionId: "quiet", data: { enabled: true } });
    setQuietEnabled(false, { dataDir: dir });
    assert.equal(quietEnabled({ dataDir: dir }), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("quiet CLI: status, on, off, invalid action, usage errors", () => {
  const dir = tmp();
  try {
    const st = quietCli(["--data-dir", dir], {});
    assert.equal(st.exitCode, 0);
    assert.match(st.stdout, /quiet: off/);
    assert.match(st.stdout, /needs mods/i);
    const on = quietCli(["--action", "on", "--data-dir", dir], {});
    assert.equal(on.exitCode, 0);
    assert.match(on.stdout, /quiet set to: on/);
    assert.match(on.stdout, /needs mods/i);
    assert.match(quietCli(["--data-dir", dir], {}).stdout, /quiet: on/);
    assert.match(quietCli(["--action", "off", "--data-dir", dir], {}).stdout, /quiet set to: off/);
    assert.match(quietCli(["--action", "status", "--data-dir", dir], {}).stdout, /quiet: off/);
    const bad = quietCli(["--action", "rm -rf", "--data-dir", dir], {});
    assert.equal(bad.exitCode, 1);
    assert.match(bad.stderr, /invalid action/);
    assert.equal(quietCli(["--action", "on"], {}).exitCode, 2);
    assert.equal(quietCli(["--bogus"], {}).exitCode, 2);
    assert.equal(quietEnabled({ dataDir: dir }), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
