import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bannerEnabled, bannerText, setBannerEnabled } from "./banner.js";
import { bannerCli } from "../cli/banner.js";
import { sessionStart } from "../hooks/session-start.js";
import { runHook } from "../hooks/run.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "odd-banner-"));
}

test("banner text is short, plain odd-claude text with the version and no control characters", () => {
  const t = bannerText("1.2.3");
  assert.match(t, /odd-claude/);
  assert.match(t, /1\.2\.3/);
  assert.ok(t.split("\n").length <= 3);
  assert.doesNotMatch(t, /[\u0000-\u0009\u000b-\u001f\u007f]/);
  assert.doesNotMatch(t, /gentle|rose/i);
});

test("banner is on by default, the state flag and ODD_CLAUDE_NO_BANNER turn it off", () => {
  const dir = tmp();
  try {
    assert.equal(bannerEnabled({ dataDir: dir, env: {} }), true);
    setBannerEnabled(false, { dataDir: dir });
    assert.equal(bannerEnabled({ dataDir: dir, env: {} }), false);
    setBannerEnabled(true, { dataDir: dir });
    assert.equal(bannerEnabled({ dataDir: dir, env: {} }), true);
    assert.equal(bannerEnabled({ dataDir: dir, env: { ODD_CLAUDE_NO_BANNER: "1" } }), false);
    assert.equal(bannerEnabled({ dataDir: dir, env: { ODD_CLAUDE_NO_BANNER: "0" } }), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SessionStart on startup adds a systemMessage (not additionalContext) unless opted out; other sources stay silent", () => {
  const dir = tmp();
  try {
    const on = sessionStart({ session_id: "s1", source: "startup" }, { dataDir: dir, env: {} });
    assert.match(String(on.systemMessage), /odd-claude/);
    assert.doesNotMatch(String((on.hookSpecificOutput as any).additionalContext), /ODD harness for Claude Code|odd-claude changes/);
    for (const source of ["resume", "clear", "compact"]) {
      assert.equal(Object.hasOwn(sessionStart({ session_id: "s1", source }, { dataDir: dir, env: {} }), "systemMessage"), false, source);
    }
    assert.equal(Object.hasOwn(sessionStart({ session_id: "s1", source: "startup" }, { dataDir: dir, env: { ODD_CLAUDE_NO_BANNER: "1" } }), "systemMessage"), false);
    setBannerEnabled(false, { dataDir: dir });
    assert.equal(Object.hasOwn(sessionStart({ session_id: "s1", source: "startup" }, { dataDir: dir, env: {} }), "systemMessage"), false);
    const r = runHook("SessionStart", JSON.stringify({ session_id: "s2", source: "startup" }), { dataDir: dir, env: {} });
    assert.equal(r.exitCode, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("banner CLI: status, on, off, invalid action and missing data dir", () => {
  const dir = tmp();
  try {
    assert.match(bannerCli(["--data-dir", dir], {}).stdout, /banner: on/);
    const off = bannerCli(["--action", "off", "--data-dir", dir], {});
    assert.equal(off.exitCode, 0);
    assert.match(off.stdout, /banner set to: off/);
    assert.match(bannerCli(["--data-dir", dir], {}).stdout, /banner: off/);
    assert.match(bannerCli(["--action", "on", "--data-dir", dir], {}).stdout, /banner set to: on/);
    assert.match(bannerCli(["--data-dir", dir], {}).stdout, /banner: on/);
    const bad = bannerCli(["--action", "rm -rf", "--data-dir", dir], {});
    assert.equal(bad.exitCode, 1);
    assert.match(bad.stderr, /invalid action/);
    assert.equal(bannerCli(["--action", "off"], {}).exitCode, 2);
    assert.match(bannerCli(["--data-dir", dir], { ODD_CLAUDE_NO_BANNER: "1" }).stdout, /banner: off \(env ODD_CLAUDE_NO_BANNER\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
