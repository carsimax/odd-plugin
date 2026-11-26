import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setupCli } from "../cli/setup.js";
import { DENY_PROFILE_RULES } from "./deny-profile.js";
import { runFullInstall } from "../installer/orchestrate.js";
import { makeHome, makeSource } from "../installer/installer.testkit.js";
import { fakeRunner, fail, ok } from "../installer/update.testkit.js";

const KEY = "de" + "ny";
const RULES = [...DENY_PROFILE_RULES];

function box(initial?: string) {
  const dir = mkdtempSync(join(tmpdir(), "odd-deny-profile-"));
  const settings = join(dir, "settings.json");
  if (initial !== undefined) writeFileSync(settings, initial);
  const data = join(dir, "data");
  const cli = (...a: string[]) => setupCli([...a, "--settings", settings, "--data-dir", data], {});
  const read = () => JSON.parse(readFileSync(settings, "utf8")) as { permissions?: Record<string, unknown> } & Record<string, unknown>;
  return { dir, settings, data, cli, read, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("the profile lists Read and Edit rules for secrets plus git push and gh pr merge", () => {
  assert.deepEqual(RULES, [
    "Read(**/.env*)", "Read(~/.ssh/**)", "Read(~/.aws/credentials)", "Read(**/*.pem)", "Read(**/*.key)",
    "Edit(**/.env*)", "Edit(~/.ssh/**)", "Edit(~/.aws/credentials)", "Edit(**/*.pem)", "Edit(**/*.key)",
    "Bash(git push *)", "Bash(git push)", "Bash(gh pr merge *)", "Bash(gh pr merge)",
  ]);
});

test("dry run shows the diff and writes nothing; install on a missing file creates it", () => {
  const b = box();
  try {
    const d = b.cli("--deny-profile", "install");
    assert.equal(d.exitCode, 0);
    assert.match(d.stdout, /^\+.*Bash\(git push \*\)/m);
    assert.match(d.stdout, /dry run: nothing written/);
    assert.equal(existsSync(b.settings), false);
    assert.equal(existsSync(b.data), false);
    const a = b.cli("--deny-profile", "install", "--apply");
    assert.equal(a.exitCode, 0, a.stderr);
    assert.match(a.stdout, /backup: none \(no previous file\)/);
    assert.deepEqual(b.read().permissions![KEY], RULES);
  } finally {
    b.cleanup();
  }
});

test("install keeps foreign keys and foreign rules, backs up first and does not duplicate", () => {
  const b = box(JSON.stringify({ model: "opus", permissions: { allow: ["Bash(ls)"], defaultMode: "plan", [KEY]: ["Bash(rm -rf /)"] } }, null, 2) + "\n");
  try {
    const before = readFileSync(b.settings, "utf8");
    const a = b.cli("--deny-profile", "install", "--apply");
    assert.equal(a.exitCode, 0, a.stderr);
    const s = b.read();
    assert.equal(s.model, "opus");
    assert.deepEqual(s.permissions!.allow, ["Bash(ls)"]);
    assert.equal(s.permissions!.defaultMode, "plan");
    assert.deepEqual(s.permissions![KEY], ["Bash(rm -rf /)", ...RULES]);
    const backups = readdirSync(join(b.data, "backups"));
    assert.equal(backups.length, 1);
    assert.equal(readFileSync(join(b.data, "backups", backups[0]!), "utf8"), before);
  } finally {
    b.cleanup();
  }
});

test("reinstall is idempotent: no diff, no new backup, file bytes unchanged", () => {
  const b = box('{"model":"opus"}\n');
  try {
    b.cli("--deny-profile", "install", "--apply");
    const bytes = readFileSync(b.settings, "utf8");
    const n = readdirSync(join(b.data, "backups")).length;
    const r = b.cli("--deny-profile", "install", "--apply");
    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout, "no changes: nothing written");
    assert.equal(readFileSync(b.settings, "utf8"), bytes);
    assert.equal(readdirSync(join(b.data, "backups")).length, n);
    const dry = b.cli("--deny-profile", "install");
    assert.match(dry.stdout, /dry run: nothing to do/);
  } finally {
    b.cleanup();
  }
});

test("remove deletes only the rules install added; a rule the user already had survives; foreign rules stay", () => {
  const b = box(JSON.stringify({ permissions: { [KEY]: ["Bash(git push *)", "Bash(mine)"] } }, null, 2) + "\n");
  try {
    b.cli("--deny-profile", "install", "--apply");
    const installed = b.read().permissions![KEY] as string[];
    assert.equal(installed.length, RULES.length + 1);
    const r = b.cli("--deny-profile", "remove", "--apply");
    assert.equal(r.exitCode, 0, r.stderr);
    assert.deepEqual(b.read().permissions![KEY], ["Bash(git push *)", "Bash(mine)"]);
    assert.equal(b.cli("--deny-profile", "remove", "--apply").stdout, "no changes: nothing written");
  } finally {
    b.cleanup();
  }
});

test("remove after an install on an empty file leaves no empty permissions; remove without install changes nothing", () => {
  const b = box('{"model":"opus"}\n');
  try {
    assert.equal(b.cli("--deny-profile", "remove", "--apply").stdout, "no changes: nothing written");
    b.cli("--deny-profile", "install", "--apply");
    b.cli("--deny-profile", "remove", "--apply");
    assert.deepEqual(b.read(), { model: "opus" });
  } finally {
    b.cleanup();
  }
});

test("restore after install puts the previous bytes back", () => {
  const original = '{\n  "model": "opus"\n}\n';
  const b = box(original);
  try {
    b.cli("--deny-profile", "install", "--apply");
    assert.notEqual(readFileSync(b.settings, "utf8"), original);
    const r = b.cli("--restore", "--apply");
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(readFileSync(b.settings, "utf8"), original);
  } finally {
    b.cleanup();
  }
});

test("invalid arguments are rejected with exit 2 and nothing is written", () => {
  const b = box('{"model":"opus"}\n');
  try {
    const before = readFileSync(b.settings, "utf8");
    for (const a of [
      ["--deny-profile"],
      ["--deny-profile", "bogus"],
      ["--deny-profile", "install", "--mode", "plan"],
      ["--deny-profile", "remove", "--restore"],
    ]) {
      const r = b.cli(...a, "--apply");
      assert.equal(r.exitCode, 2, a.join(" "));
      assert.equal(r.stdout, "");
      assert.match(r.stderr, /^error: usage: .*\nusage: setup\.js/s);
    }
    assert.equal(b.cli("--deny-profile", "bogus").stderr.split("\n")[0], "error: usage: --deny-profile must be one of install, remove");
    assert.equal(readFileSync(b.settings, "utf8"), before);
    assert.equal(existsSync(b.data), false);
  } finally {
    b.cleanup();
  }
});

test("a settings file that is not valid JSON, or whose rule list is not an array, is refused untouched", () => {
  for (const text of ["{ nope", `{"permissions":{"${KEY}":"x"}}`]) {
    const b = box(text);
    try {
      const r = b.cli("--deny-profile", "install", "--apply");
      assert.equal(r.exitCode, 1);
      assert.match(r.stderr, /^error: /);
      assert.equal(readFileSync(b.settings, "utf8"), text);
    } finally {
      b.cleanup();
    }
  }
});

test("existing defaultMode subcommands and restore output are unchanged", () => {
  const b = box('{\n  "model": "opus"\n}\n');
  try {
    const dry = b.cli("--mode", "plan");
    assert.match(dry.stdout, /^\+.*"defaultMode": "plan"/m);
    assert.match(dry.stdout, /dry run: nothing written\. Re-run with --apply to write it$/);
    const a = b.cli("--mode", "plan", "--apply");
    assert.match(a.stdout, /\n\napplied\.\nbackup: .*settings\..*\.json$/);
    assert.equal(b.cli("--mode", "plan", "--apply").stdout, "no changes: nothing written");
    assert.equal(b.cli("--apply").stderr.split("\n")[0], "error: usage: --apply needs --mode <mode>, --deny-profile <install|remove> or --restore");
    const r = b.cli("--restore", "--apply");
    assert.match(r.stdout, /\n\nrestored\.\nbackup: .*settings\..*\.json$/);
    assert.deepEqual(b.read(), { model: "opus" });
    assert.match(b.cli().stdout, /^settings: .*\npermissions\.defaultMode: \(not set\)\navailable modes: default, acceptEdits, auto, plan, bypassPermissions\nbackups: 2/);
  } finally {
    b.cleanup();
  }
});

test("the installer plan writes no permission rules, and no installer source mentions them", async () => {
  const { home } = makeHome();
  const runner = fakeRunner((c) => {
    if (c.cmd === "claude" && c.args[0] === "plugin" && c.args[1] === "list") return ok("[]");
    if (c.cmd === "claude" && c.args[0] === "plugin" && c.args[1] === "marketplace") return ok("[]");
    if (c.cmd === "claude" && c.args[0] === "mcp" && c.args[1] === "get") return fail("No MCP server named x found");
    if (c.cmd === "engram" || c.cmd === "codegraph") return fail("not found", 127);
    return undefined;
  }).runner;
  const settingsPath = join(home, ".claude", "settings.json");
  mkdirSync(dirname(settingsPath), { recursive: true });
  const r = await runFullInstall({ env: {}, homedir: home, runner, source: makeSource(), confirmDep: () => true });
  assert.equal(r.ok, true, JSON.stringify(r.steps.filter((s) => s.status === "failed")));
  const s = JSON.parse(readFileSync(settingsPath, "utf8")) as { permissions?: Record<string, unknown> };
  assert.equal(s.permissions?.[KEY], undefined);
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "installer");
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".ts") && !/\.(spec|testkit)\.ts$/.test(n))) {
    assert.doesNotMatch(readFileSync(join(dir, f), "utf8"), new RegExp(`permissions\\.${KEY}|DENY_PROFILE`), f);
  }
});

test("S6: remove after restore never deletes a rule the user re-added by hand", () => {
  const b = box(JSON.stringify({ permissions: { [KEY]: ["Bash(rm *)"] } }) + "\n");
  try {
    b.cli("--deny-profile", "install", "--apply");
    assert.equal(b.cli("--restore", "--apply").exitCode, 0);
    assert.deepEqual(b.read().permissions![KEY], ["Bash(rm *)"]);
    writeFileSync(b.settings, JSON.stringify({ permissions: { [KEY]: ["Bash(rm *)", "Bash(git push *)"] } }) + "\n");
    const r = b.cli("--deny-profile", "remove", "--apply");
    assert.equal(r.exitCode, 0, r.stderr);
    assert.deepEqual(b.read().permissions![KEY], ["Bash(rm *)", "Bash(git push *)"]);
  } finally {
    b.cleanup();
  }
});

test("S6: a repeated --deny-profile is a usage error and writes nothing", () => {
  const b = box('{"model":"opus"}\n');
  try {
    const before = readFileSync(b.settings, "utf8");
    const r = b.cli("--deny-profile", "install", "--deny-profile", "remove", "--apply");
    assert.equal(r.exitCode, 2);
    assert.equal(r.stdout, "");
    assert.equal(r.stderr.split("\n")[0], "error: usage: --deny-profile given more than once");
    assert.equal(readFileSync(b.settings, "utf8"), before);
    assert.equal(existsSync(b.data), false);
  } finally {
    b.cleanup();
  }
});

test("S6: when the settings write succeeded but the ownership record failed, the error says so", () => {
  const b = box();
  try {
    mkdirSync(join(b.data, "setup.json"), { recursive: true }); // state file path is a directory: only the ownership write fails
    const r = b.cli("--deny-profile", "install", "--apply");
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /settings were written, but ownership of the deny profile rules was not recorded/);
    assert.doesNotMatch(r.stderr, /left as they were/);
    assert.match(r.stderr, /--restore|by hand/);
    assert.deepEqual(b.read().permissions![KEY], RULES);
  } finally {
    b.cleanup();
  }
});
