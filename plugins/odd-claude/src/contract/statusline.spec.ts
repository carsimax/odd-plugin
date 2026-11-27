// Black-box tests of the status line script entry, moved from installer/statusline.spec.ts (the in-process tests stay there).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { entry } from "./impl.testkit.js";

const hasJq = spawnSync("jq", ["--version"]).status === 0;
const skip = hasJq ? false : "jq is not installed; the status line script needs it";
// eslint-disable-next-line no-control-regex
const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

const INPUT = JSON.stringify({
  model: { display_name: "Opus 4.7" },
  effort: { level: "high" },
  context_window: { used_percentage: 42.5 },
  workspace: { current_dir: "/nonexistent-dir", repo: { name: "demo" } },
});

function fixture(version?: string) {
  const sl = entry("statusline");
  const root = mkdtempSync(join(tmpdir(), "odd-sl-"));
  mkdirSync(join(root, "statusline"));
  // The script is copied beside a fake package.json: the version segment is read from the script's own parent directory.
  copyFileSync(sl.args[0]!, join(root, "statusline", "statusline.sh"));
  if (version) writeFileSync(join(root, "package.json"), JSON.stringify({ name: "odd-claude", version }));
  const home = mkdtempSync(join(tmpdir(), "odd-sl-home-"));
  const run = (input = INPUT, extraEnv: Record<string, string> = {}) =>
    spawnSync(sl.command, [join(root, "statusline", "statusline.sh")], { input, encoding: "utf8", env: { PATH: process.env.PATH, HOME: home, ...extraEnv } });
  return {
    root,
    home,
    run,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    },
  };
}

test("status line shows model, effort, ctx and the odd version segment", { skip }, () => {
  const f = fixture("1.2.3");
  try {
    const r = f.run();
    assert.equal(r.status, 0);
    const out = strip(r.stdout);
    assert.match(out, /Opus 4\.7/);
    assert.match(out, /high/);
    assert.match(out, /ctx .* 42%/);
    assert.match(out, /demo/);
    assert.match(out.trimEnd(), /odd v1\.2\.3$/);
  } finally {
    f.cleanup();
  }
});

test("status line omits the odd segment silently when package.json is missing", { skip }, () => {
  const f = fixture();
  try {
    const r = f.run();
    assert.equal(r.status, 0);
    assert.equal(r.stderr, "");
    assert.match(strip(r.stdout), /Opus 4\.7/);
    assert.doesNotMatch(strip(r.stdout), /odd v/);
  } finally {
    f.cleanup();
  }
});

test("status line reads the autocompact marker from CLAUDE_CONFIG_DIR/settings.json and prints English day names", { skip }, () => {
  const f = fixture("1.0.0");
  try {
    const cfg = join(f.home, "cfg");
    mkdirSync(cfg);
    writeFileSync(join(cfg, "settings.json"), JSON.stringify({ env: { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "50" } }));
    const input = JSON.stringify({ model: { display_name: "M" }, context_window: { used_percentage: 10 }, rate_limits: { seven_day: { used_percentage: 5, resets_at: 1767225600 } } });
    const r = f.run(input, { CLAUDE_CONFIG_DIR: cfg });
    assert.equal(r.status, 0);
    // 10% of 10 cells fills 1 cell, the marker at 50% sits on cell index 5.
    assert.match(strip(r.stdout), /ctx ━─{4}┃/);
    assert.match(strip(r.stdout), /7d .* (Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d\d\/\d\d \d\d:\d\d/);
  } finally {
    f.cleanup();
  }
});

test("status line keeps the missing-jq fallback", () => {
  const f = fixture("1.0.0");
  try {
    const r = spawnSync(entry("statusline").command, [join(f.root, "statusline", "statusline.sh")], { input: INPUT, encoding: "utf8", env: { PATH: "/nonexistent", HOME: f.home } });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /statusline: jq is missing/);
  } finally {
    f.cleanup();
  }
});
