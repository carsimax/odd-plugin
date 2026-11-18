import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupCli } from "./setup.js";

const SAMPLE = '{\n  "model": "opus",\n  "permissions": { "allow": ["Bash(ls)"] }\n}\n';
const sha = (p: string): string => createHash("sha256").update(readFileSync(p)).digest("hex");

function box(content = SAMPLE) {
  const dir = mkdtempSync(join(tmpdir(), "odd-sl-cli-"));
  const settings = join(dir, "settings.json");
  writeFileSync(settings, content);
  return { dir, settings, data: join(dir, "data"), root: join(dir, "root"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const base = (b: ReturnType<typeof box>): string[] => ["--settings", b.settings, "--data-dir", b.data, "--plugin-root", b.root];

test("--statusline on dry run prints the diff, exits 0 and writes nothing (not even the shim)", () => {
  const b = box();
  try {
    const before = sha(b.settings);
    const r = setupCli(["--statusline", "on", ...base(b)], {});
    assert.equal(r.exitCode, 0);
    assert.match(r.stdout, /^\+.*"statusLine"/m);
    assert.match(r.stdout, /statusline\.mjs/);
    assert.match(r.stdout, /dry run/);
    assert.equal(sha(b.settings), before);
    assert.equal(existsSync(b.data), false);
  } finally {
    b.cleanup();
  }
});

test("--statusline on --apply writes, off --apply reverts; both leave a backup trail; foreign needs --replace-statusline", () => {
  const b = box();
  try {
    const before = JSON.parse(readFileSync(b.settings, "utf8"));
    const on = setupCli(["--statusline", "on", "--apply", ...base(b)], {});
    assert.equal(on.exitCode, 0);
    assert.match(on.stdout, /backup: .*settings\./);
    assert.ok(JSON.parse(readFileSync(b.settings, "utf8")).statusLine);
    const off = setupCli(["--statusline", "off", "--apply", ...base(b)], {});
    assert.equal(off.exitCode, 0);
    assert.deepEqual(JSON.parse(readFileSync(b.settings, "utf8")), before);
  } finally {
    b.cleanup();
  }
  const f = box('{"statusLine":{"type":"command","command":"mine.sh"}}\n');
  try {
    const before = sha(f.settings);
    const dry = setupCli(["--statusline", "on", ...base(f)], {});
    assert.equal(dry.exitCode, 0);
    assert.match(dry.stdout, /WARNING: .*statusLine/);
    assert.match(dry.stdout, /--replace-statusline/);
    const refused = setupCli(["--statusline", "on", "--apply", ...base(f)], {});
    assert.equal(refused.exitCode, 1);
    assert.match(refused.stderr, /^error: .*--replace-statusline/);
    assert.equal(sha(f.settings), before);
    const ok = setupCli(["--statusline", "on", "--apply", "--replace-statusline", ...base(f)], {});
    assert.equal(ok.exitCode, 0);
    assert.match(JSON.parse(readFileSync(f.settings, "utf8")).statusLine.command, /statusline\.mjs/);
  } finally {
    f.cleanup();
  }
});

test("usage errors: bad action, combined with --mode/--restore, --replace-statusline without --statusline", () => {
  const b = box();
  try {
    for (const args of [
      ["--statusline", "maybe"],
      ["--statusline"],
      ["--statusline", "on", "--mode", "plan"],
      ["--statusline", "on", "--restore"],
      ["--replace-statusline"],
    ]) {
      const r = setupCli([...args, ...base(b)], {});
      assert.equal(r.exitCode, 2, args.join(" "));
      assert.match(r.stderr, /^error: usage:/);
    }
  } finally {
    b.cleanup();
  }
});

test("info output lists the current statusLine; invalid JSON is refused with exit 1; --json shape", () => {
  const b = box();
  try {
    const info = setupCli(["--settings", b.settings, "--data-dir", b.data], {});
    assert.match(info.stdout, /statusLine: \(not set\)/);
    const j = setupCli(["--statusline", "on", "--json", ...base(b)], {});
    const o = JSON.parse(j.stdout);
    assert.deepEqual([o.status, o.changed, o.foreign], ["dry-run", true, false]);
  } finally {
    b.cleanup();
  }
  const bad = box("{ nope");
  try {
    const r = setupCli(["--statusline", "on", "--apply", ...base(bad)], {});
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /not valid JSON/);
  } finally {
    bad.cleanup();
  }
});

test("PRESERVE: --mode still works and does not touch statusLine", () => {
  const b = box('{"statusLine":{"type":"command","command":"mine.sh"}}\n');
  try {
    const r = setupCli(["--mode", "plan", "--apply", "--settings", b.settings, "--data-dir", b.data], {});
    assert.equal(r.exitCode, 0);
    const after = JSON.parse(readFileSync(b.settings, "utf8"));
    assert.deepEqual(after, { statusLine: { type: "command", command: "mine.sh" }, permissions: { defaultMode: "plan" } });
  } finally {
    b.cleanup();
  }
});

test("S3: --replace-statusline with off is a usage error", () => {
  const b = box();
  try {
    const r = setupCli(["--statusline", "off", "--replace-statusline", "--settings", b.settings, "--data-dir", join(b.dir, "d")], {});
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /--replace-statusline needs --statusline on/);
  } finally {
    b.cleanup();
  }
});
