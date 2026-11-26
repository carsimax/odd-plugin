import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { FLAG_SPECS } from "./args.js";
import { runCli, type CliIo } from "./cli.js";
import { flowContext } from "./orchestrate.js";
import { activeVersion } from "./payload.js";
import { readSelection } from "./models.js";
import { makeHome, makeSource } from "./installer.testkit.js";
import { fail, fakeRunner, ok, type Call } from "./update.testkit.js";

function harness(opts: { tty?: boolean; startTui?: CliIo["startTui"] } = {}): { io: CliIo; out: string[]; err: string[]; calls: Call[]; home: string } {
  const { home } = makeHome();
  const out: string[] = [];
  const err: string[] = [];
  const { runner, calls } = fakeRunner((c) => {
    if (c.cmd === "claude" && c.args[0] === "plugin" && c.args[1] === "list") return ok("[]");
    if (c.cmd === "claude" && c.args[0] === "mcp" && c.args[1] === "get") return fail("No MCP server named x found");
    if ((c.cmd === "engram" && c.args[0] === "version") || (c.cmd === "codegraph" && c.args[0] === "--version")) return fail("missing", 127);
    return undefined;
  });
  const io: CliIo = { env: {}, homedir: home, runner, stdout: (s) => out.push(s), stderr: (s) => err.push(s), isTty: opts.tty ?? false, version: "7.7.7", startTui: opts.startTui };
  return { io, out, err, calls, home };
}

describe("runCli", () => {
  it("--help prints usage with every flag and exits 0", async () => {
    const h = harness();
    assert.equal(await runCli(["--help"], h.io), 0);
    const text = h.out.join("");
    for (const f of FLAG_SPECS) assert.ok(text.includes(`--${f.name}`), `help misses --${f.name}`);
    assert.deepEqual(h.err, []);
  });

  it("the internal reapply command re-applies hooks, MCP and extras, prints one JSON document with --json and stays out of --help", async () => {
    const h = harness();
    assert.equal(await runCli(["install", "--source", makeSource(), "--yes", "--no-deps"], h.io), 0);
    h.out.length = 0;
    assert.equal(await runCli(["reapply"], h.io), 0);
    assert.deepEqual(h.out.join("").trim().split("\n").map((l) => l.split(" ")[0]), ["[ok]", "[ok]", "[ok]"]);
    h.out.length = 0;
    assert.equal(await runCli(["reapply", "--json"], h.io), 0);
    const doc = JSON.parse(h.out.join("")) as { ok: boolean; command: string; steps: { id: string }[] };
    assert.equal(doc.command, "reapply");
    assert.deepEqual(doc.steps.map((s) => s.id), ["hooks", "mcp", "extras"]);
    h.out.length = 0;
    await runCli(["--help"], h.io);
    assert.equal(h.out.join("").includes("reapply"), false);
  });

  it("reapply without an install fails before touching anything, dry run included", async () => {
    for (const extra of [[], ["--dry-run"]]) {
      const h = harness();
      assert.equal(await runCli(["reapply", "--json", ...extra], h.io), 1);
      const doc = JSON.parse(h.out.join("")) as { ok: boolean; steps: { status: string; detail: string }[] };
      assert.equal(doc.ok, false);
      assert.equal(doc.steps[0]!.status, "failed");
      assert.match(doc.steps[0]!.detail, /not installed; run install first/);
      assert.equal(h.calls.some((c) => c.cmd === "claude" && c.args.includes("add")), false);
      assert.equal(existsSync(join(h.home, ".odd-claude")), false);
      assert.equal(existsSync(join(h.home, ".claude", "settings.json")), false);
    }
  });

  it("--version prints the version", async () => {
    const h = harness();
    assert.equal(await runCli(["--version"], h.io), 0);
    assert.equal(h.out.join("").trim(), "7.7.7");
  });

  it("an unknown flag exits 2 with the error and the usage on stderr", async () => {
    const h = harness();
    assert.equal(await runCli(["install", "--bogus"], h.io), 2);
    assert.match(h.err.join(""), /unknown flag --bogus/);
    assert.match(h.err.join(""), /Usage: odd-claude/);
    assert.deepEqual(h.out, []);
  });

  it("an invalid --model exits 2 without installing anything", async () => {
    const h = harness();
    assert.equal(await runCli(["install", "--source", makeSource(), "--yes", "--model", "worker=gpt"], h.io), 2);
    assert.match(h.err.join(""), /invalid model "gpt"/);
    assert.equal(existsSync(join(h.home, ".odd-claude")), false);
    assert.equal(h.calls.length, 0);
  });

  it("no subcommand without a TTY prints usage and exits 2", async () => {
    const h = harness({ tty: false });
    assert.equal(await runCli([], h.io), 2);
    assert.match(h.err.join(""), /Usage: odd-claude/);
  });

  it("no subcommand with a TTY starts the TUI with the parsed flags", async () => {
    let got: string | undefined;
    const h = harness({ tty: true, startTui: async (init) => ((got = init.args.source), 0) });
    assert.equal(await runCli(["--source", "/some/dir"], h.io), 0);
    assert.equal(got, "/some/dir");
  });

  it("install --dry-run --yes --json prints one JSON document and writes nothing", async () => {
    const h = harness();
    const code = await runCli(["install", "--source", makeSource(), "--dry-run", "--yes", "--json"], h.io);
    assert.equal(code, 0);
    const j = JSON.parse(h.out.join("")) as { ok: boolean; command: string; dryRun: boolean; version: string; steps: { id: string; status: string }[] };
    assert.deepEqual([j.ok, j.command, j.dryRun, j.version], [true, "install", true, "9.9.9"]);
    assert.deepEqual(j.steps.map((s) => s.id), ["migrate", "source", "install", "hooks", "output-style", "mcp", "extras", "deps"]);
    assert.equal(existsSync(join(h.home, ".odd-claude")), false);
    assert.equal(existsSync(join(h.home, ".claude")), false);
  });

  it("install maps the flags to the options and prints a step line per step", async () => {
    const h = harness();
    const code = await runCli(["install", "--source", makeSource(), "--yes", "--profile", "economy", "--model", "worker=opus", "--no-statusline", "--keep-builtin-plugins", "--keep-claude-ai-skills"], h.io);
    assert.equal(code, 0, h.err.join(""));
    const ctx = flowContext({ env: {}, homedir: h.home });
    const sel = readSelection(ctx.paths.dataDir);
    assert.equal(sel.profile, "custom");
    assert.equal(sel.roles["odd-worker"], "opus");
    assert.match(readFileSync(join(ctx.paths.claudeDir, "agents", "odd-worker.md"), "utf8"), /^model: opus$/m);
    const s = JSON.parse(readFileSync(ctx.managed.settingsPath, "utf8")) as Record<string, unknown>;
    assert.equal(s.statusLine, undefined);
    assert.equal(s.syncClaudeAiSkills, undefined);
    assert.equal(s.disableClaudeAiConnectors, true);
    assert.equal(s.enabledPlugins, undefined);
    assert.ok(h.calls.some((c) => c.cmd === "brew" && c.args[0] === "install"), "--yes confirms the dependencies");
    assert.match(h.out.join(""), /\[ok\] .*Install files/);
  });

  it("--no-deps never installs dependencies, and without --yes nothing is confirmed", async () => {
    const a = harness();
    await runCli(["install", "--source", makeSource(), "--no-deps"], a.io);
    assert.ok(!a.calls.some((c) => c.cmd === "brew" || c.cmd === "engram"));
    const b = harness();
    await runCli(["install", "--source", makeSource()], b.io);
    assert.ok(!b.calls.some((c) => c.cmd === "brew" && c.args[0] === "install"));
  });

  it("a failing step exits 1", async () => {
    const h = harness();
    assert.equal(await runCli(["install", "--source", join(h.home, "missing"), "--yes"], h.io), 1);
    assert.match(h.out.join(""), /\[FAIL\] Resolve the payload/);
  });

  it("status --json reports the installed version", async () => {
    const h = harness();
    await runCli(["install", "--source", makeSource(), "--yes", "--no-deps"], h.io);
    h.out.length = 0;
    assert.equal(await runCli(["status", "--json"], h.io), 0);
    const j = JSON.parse(h.out.join("")) as { installedVersion: string; node: { ok: boolean } };
    assert.equal(j.installedVersion, "9.9.9");
    assert.equal(j.node.ok, true);
  });

  it("models applies the selection to the installed version", async () => {
    const h = harness();
    await runCli(["install", "--source", makeSource(), "--yes", "--no-deps"], h.io);
    assert.equal(await runCli(["models", "--profile", "max"], h.io), 0);
    assert.equal(readSelection(flowContext({ env: {}, homedir: h.home }).paths.dataDir).profile, "max");
  });

  it("uninstall --purge removes everything, rollback without a previous version exits 1, backups lists", async () => {
    const h = harness();
    await runCli(["install", "--source", makeSource(), "--yes", "--no-deps"], h.io);
    assert.equal(await runCli(["rollback"], h.io), 1);
    h.out.length = 0;
    assert.equal(await runCli(["backups", "--json"], h.io), 0);
    assert.ok(Array.isArray((JSON.parse(h.out.join("")) as { backups: unknown[] }).backups));
    assert.equal(await runCli(["uninstall", "--purge"], h.io), 0);
    const ctx = flowContext({ env: {}, homedir: h.home });
    assert.equal(activeVersion(ctx.paths), null);
    assert.equal(existsSync(ctx.paths.oddHome), false);
    assert.deepEqual(readdirSync(h.home).filter((n) => n === ".odd-claude"), []);
  });

  it("backups --restore with an unknown id exits 1", async () => {
    const h = harness();
    assert.equal(await runCli(["backups", "--restore", "nope"], h.io), 1);
    assert.match(h.out.join("") + h.err.join(""), /unknown backup/);
  });
});
