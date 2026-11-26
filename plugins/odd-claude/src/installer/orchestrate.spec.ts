import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { buildSelection, defaultSelection, readSelection, writeProfileState } from "./models.js";
import { activeVersion } from "./payload.js";
import { applyModels, backupsOf, detect, flowContext, planFullInstall, runFullInstall, runFullUninstall, runRollback, runUpdateFlow, type StepResult } from "./orchestrate.js";
import { makeHome, makeSource, put } from "./installer.testkit.js";
import { fail, fakeRunner, ghRunner, makeRelease, ok, type Call } from "./update.testkit.js";
import type { RunResult } from "./mcp.js";

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BUILTINS = JSON.stringify([
  { id: "alpha@builtin", scope: "user", enabled: true },
  { id: "cc-plugin-sec-default@builtin", scope: "user", enabled: true },
  { id: "managed-one@builtin", scope: "managed", enabled: true },
  { id: "someone@market", scope: "user", enabled: true },
]);

/** A fake machine: claude, gh, brew and npm answer; engram and codegraph are missing. */
function machine(opts: { pluginIds?: string[]; failOn?: (c: Call) => RunResult | undefined } = {}): ReturnType<typeof fakeRunner> {
  return fakeRunner((c) => {
    const f = opts.failOn?.(c);
    if (f) return f;
    const key = [c.cmd, ...c.args].join(" ");
    if (c.cmd === "claude" && c.args[0] === "plugin" && c.args[1] === "list") {
      return ok(JSON.stringify([...(opts.pluginIds ?? []).map((id) => ({ id })), ...JSON.parse(BUILTINS)]));
    }
    if (c.cmd === "claude" && c.args[0] === "plugin" && c.args[1] === "marketplace") return ok("[]");
    if (c.cmd === "claude" && c.args[0] === "mcp" && c.args[1] === "get") return fail("No MCP server named x found");
    if ((c.cmd === "engram" && c.args[0] === "version") || (c.cmd === "codegraph" && c.args[0] === "--version")) return fail("not found", 127);
    if (key === "gh auth status") return ok("logged in");
    return undefined;
  });
}

const MUTATING = [/^claude mcp add/, /^claude mcp remove/, /^claude plugin uninstall/, /^claude plugin marketplace remove/, /^brew install/, /^npm install/, /^engram setup/, /^gh release download/];

function snapshot(dir: string, base = dir, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (lstatSync(p).isSymbolicLink()) out.push(`${p.slice(base.length)} -> ${readlinkSync(p)}`);
    else if (e.isDirectory()) snapshot(p, base, out);
    else out.push(`${p.slice(base.length)}:${readFileSync(p, "utf8")}`);
  }
  return out.sort();
}

const ids = (steps: StepResult[]): string[] => steps.map((s) => s.id);

function setup(): { home: string; env: Record<string, string>; source: string; ctx: ReturnType<typeof flowContext> } {
  const { home } = makeHome();
  const env = {};
  return { home, env, source: makeSource(), ctx: flowContext({ env, homedir: home }) };
}

describe("runFullInstall", () => {
  it("runs the steps in order and reports each through onStep", async () => {
    const { home, env, source } = setup();
    const { runner } = machine();
    const seen: string[] = [];
    const r = await runFullInstall({ env, homedir: home, runner, source, confirmDep: () => true }, (s) => seen.push(s.id));
    assert.deepEqual(ids(r.steps), ["migrate", "source", "install", "hooks", "output-style", "mcp", "extras", "deps"]);
    assert.deepEqual(seen, ids(r.steps));
    assert.equal(r.ok, true);
    assert.equal(r.version, "9.9.9");
    assert.equal(r.steps.find((s) => s.id === "source")!.status, "ok");
    assert.equal(activeVersion(flowContext({ env, homedir: home }).paths), "9.9.9");
  });

  it("dry run writes nothing and runs no mutating command", async () => {
    const { home, env, source } = setup();
    const before = snapshot(home);
    const { runner, calls } = machine({ pluginIds: ["odd-claude@odd-claude"] });
    const r = await planFullInstall({ env, homedir: home, runner, source, confirmDep: () => true });
    assert.deepEqual(snapshot(home), before);
    assert.equal(r.dryRun, true);
    assert.equal(r.ok, true);
    assert.ok(r.plan, "a local source yields a file plan");
    assert.match(r.summary ?? "", /file: \d+ create/);
    for (const c of calls) assert.ok(!MUTATING.some((re) => re.test([c.cmd, ...c.args].join(" "))), `mutating call in dry run: ${c.cmd} ${c.args.join(" ")}`);
    assert.match(r.steps.find((s) => s.id === "migrate")!.detail, /would uninstall plugin odd-claude@odd-claude/);
    assert.match(r.steps.find((s) => s.id === "deps")!.detail, /engram: would install/);
  });

  it("dry run with a release source checks but never downloads", async () => {
    const { home, env } = setup();
    const rel = makeRelease("9.9.10");
    const { runner, calls } = ghRunner(rel);
    const before = snapshot(home);
    const r = await runFullInstall({ env, homedir: home, runner, dryRun: true });
    assert.equal(r.ok, true);
    assert.equal(r.version, "9.9.10");
    assert.equal(r.plan, undefined);
    assert.deepEqual(snapshot(home), before);
    assert.ok(!calls.some((c) => c.args[1] === "download"));
  });

  it("a failed source stops the dependent steps and is reported, not thrown", async () => {
    const { home, env } = setup();
    const { runner } = machine();
    const r = await runFullInstall({ env, homedir: home, runner, source: join(home, "no-such-dir") });
    assert.equal(r.ok, false);
    assert.equal(r.steps.find((s) => s.id === "source")!.status, "failed");
    for (const id of ["install", "hooks", "output-style", "mcp", "extras", "deps"]) {
      const s = r.steps.find((x) => x.id === id)!;
      assert.equal(s.status, "skipped");
      assert.match(s.detail, /source failed/);
    }
    assert.equal(existsSync(join(home, ".odd-claude")), false);
  });

  it("a failed release check is a failed source step", async () => {
    const { home, env } = setup();
    const { runner } = machine({ failOn: (c) => (c.cmd === "gh" && c.args[0] === "release" ? fail("gh: not logged in") : undefined) });
    const r = await runFullInstall({ env, homedir: home, runner });
    assert.equal(r.steps.find((s) => s.id === "source")!.status, "failed");
    assert.match(r.steps.find((s) => s.id === "source")!.detail, /not logged in/);
  });

  it("a settings.json that is not JSON fails hooks and output style but leaves it untouched, and later steps still run", async () => {
    const { home, env, source, ctx } = setup();
    mkdirSync(ctx.paths.claudeDir, { recursive: true });
    writeFileSync(ctx.managed.settingsPath, "{ not json");
    const { runner } = machine();
    const r = await runFullInstall({ env, homedir: home, runner, source, deps: false });
    assert.equal(r.ok, false);
    assert.equal(r.steps.find((s) => s.id === "hooks")!.status, "failed");
    assert.equal(r.steps.find((s) => s.id === "output-style")!.status, "failed");
    assert.equal(r.steps.find((s) => s.id === "mcp")!.status, "ok");
    assert.equal(r.steps.find((s) => s.id === "deps")!.status, "skipped");
    assert.equal(readFileSync(ctx.managed.settingsPath, "utf8"), "{ not json");
  });

  it("migrates from the plugin first: uninstalls it and carries its profile over", async () => {
    const { home, env, source, ctx } = setup();
    const pluginData = join(home, ".claude", "plugins", "data", "odd-claude-odd-claude");
    writeProfileState(pluginData, buildSelection("economy"));
    const { runner, calls } = machine({ pluginIds: ["odd-claude@odd-claude"] });
    const r = await runFullInstall({ env, homedir: home, runner, source, deps: false });
    const uninstallAt = calls.findIndex((c) => c.args.join(" ") === "plugin uninstall odd-claude@odd-claude");
    const firstMcp = calls.findIndex((c) => c.args[0] === "mcp");
    assert.ok(uninstallAt >= 0 && uninstallAt < firstMcp);
    assert.equal(r.steps[0]!.status, "ok");
    assert.equal(readSelection(ctx.paths.dataDir).profile, "economy");
  });

  it("a plugin that cannot be uninstalled is a warning, the install goes on", async () => {
    const { home, env, source } = setup();
    const { runner } = machine({ pluginIds: ["odd-claude@odd-claude"], failOn: (c) => (c.args[0] === "plugin" && c.args[1] === "uninstall" ? fail("denied") : undefined) });
    const r = await runFullInstall({ env, homedir: home, runner, source, deps: false });
    assert.equal(r.steps[0]!.status, "warning");
    assert.match(r.steps[0]!.detail, /denied/);
    assert.equal(r.ok, true);
  });

  it("reinstalling without a selection keeps the stored one", async () => {
    const { home, env, source, ctx } = setup();
    const { runner } = machine();
    await runFullInstall({ env, homedir: home, runner, source, selection: buildSelection("economy"), deps: false });
    await runFullInstall({ env, homedir: home, runner, source, deps: false });
    assert.equal(readSelection(ctx.paths.dataDir).profile, "economy");
  });

  it("deps are only installed when confirmed", async () => {
    const { home, env, source } = setup();
    const a = machine();
    await runFullInstall({ env, homedir: home, runner: a.runner, source });
    assert.ok(!a.calls.some((c) => c.cmd === "brew" && c.args[0] === "install"), "no confirm callback means nothing is installed");
    const b = machine();
    const r = await runFullInstall({ env, homedir: home, runner: b.runner, source, confirmDep: () => true });
    assert.ok(b.calls.some((c) => c.cmd === "brew" && c.args[0] === "install"));
    assert.equal(r.steps.find((s) => s.id === "deps")!.status, "ok");
  });

  it("--no-deps skips the step without detection or install calls", async () => {
    const { home, env, source } = setup();
    const { runner, calls } = machine();
    const r = await runFullInstall({ env, homedir: home, runner, source, deps: false, confirmDep: () => true });
    assert.equal(r.steps.find((s) => s.id === "deps")!.status, "skipped");
    assert.ok(!calls.some((c) => c.cmd === "brew" || c.cmd === "engram"));
  });
});

describe("runFullUninstall", () => {
  it("runs in reverse order and never touches the dependencies", async () => {
    const { home, env, source } = setup();
    const m = machine();
    await runFullInstall({ env, homedir: home, runner: m.runner, source, confirmDep: () => true });
    const u = machine();
    const seen: string[] = [];
    const r = await runFullUninstall({ env, homedir: home, runner: u.runner }, (s) => seen.push(s.id));
    assert.deepEqual(seen, ["extras", "mcp", "output-style", "hooks", "files"]);
    assert.equal(r.ok, true);
    assert.ok(!u.calls.some((c) => c.cmd === "brew" || c.cmd === "npm" || c.cmd === "engram"));
    assert.deepEqual(u.calls.filter((c) => c.args[1] === "remove").map((c) => c.args[c.args.length - 1]), ["odd-review", "codegraph"]);
    assert.equal(activeVersion(flowContext({ env, homedir: home }).paths), null);
  });

  it("uninstall keeps working on an old state file that still lists odd-peers", async () => {
    const { home, env, source, ctx } = setup();
    await runFullInstall({ env, homedir: home, runner: machine().runner, source, deps: false });
    writeFileSync(ctx.managed.statePath, JSON.stringify({ ...JSON.parse(readFileSync(ctx.managed.statePath, "utf8")), mcp: { added: ["odd-review", "odd-peers", "codegraph"] } }));
    const u = machine();
    const r = await runFullUninstall({ env, homedir: home, runner: u.runner });
    assert.equal(r.ok, true);
    assert.deepEqual(u.calls.filter((c) => c.args[1] === "remove").map((c) => c.args[c.args.length - 1]), ["odd-review", "odd-peers", "codegraph"]);
  });

  it("dry run writes nothing and removes nothing", async () => {
    const { home, env, source } = setup();
    await runFullInstall({ env, homedir: home, runner: machine().runner, source, deps: false });
    const before = snapshot(home);
    const u = machine();
    const r = await runFullUninstall({ env, homedir: home, runner: u.runner, dryRun: true, purge: true });
    assert.deepEqual(snapshot(home), before);
    assert.equal(r.dryRun, true);
    assert.ok(!u.calls.some((c) => c.args[1] === "remove"));
  });

  it("without --purge keeps data and backups, with --purge removes them and the odd home", async () => {
    const { home, env, source, ctx } = setup();
    await runFullInstall({ env, homedir: home, runner: machine().runner, source, deps: false });
    await runFullUninstall({ env, homedir: home, runner: machine().runner });
    assert.ok(existsSync(ctx.paths.dataDir));
    await runFullUninstall({ env, homedir: home, runner: machine().runner, purge: true });
    assert.equal(existsSync(ctx.paths.oddHome), false);
  });
});

describe("end to end with the real plugin tree", () => {
  it("installs hooks, output style, status line, models and manifest, and uninstall restores settings.json", async () => {
    const { home, env, ctx } = setup();
    mkdirSync(ctx.paths.claudeDir, { recursive: true });
    const original = { theme: "dark", outputStyle: "Explanatory", hooks: { Stop: [{ hooks: [{ type: "command", command: "echo foreign" }] }] }, enabledPlugins: { "someone@market": true } };
    const originalText = JSON.stringify(original, null, 2) + "\n";
    writeFileSync(ctx.managed.settingsPath, originalText);
    const m = machine();
    const r = await runFullInstall({ env, homedir: home, runner: m.runner, source: PLUGIN_ROOT, selection: buildSelection("balanced"), confirmDep: () => true });
    assert.equal(r.ok, true, JSON.stringify(r.steps.filter((s) => s.status === "failed")));

    const s = JSON.parse(readFileSync(ctx.managed.settingsPath, "utf8")) as Record<string, any>;
    assert.equal(s.outputStyle, "odd");
    assert.match(s.statusLine.command, /statusline\/statusline\.sh/);
    assert.equal(s.disableClaudeAiConnectors, true);
    assert.equal(s.syncClaudeAiSkills, false);
    assert.equal(s.syncClaudeAiPlugins, false);
    assert.equal(s.enabledPlugins["alpha@builtin"], false);
    assert.equal(s.enabledPlugins["cc-plugin-sec-default@builtin"], undefined);
    assert.equal(s.enabledPlugins["someone@market"], true);
    assert.equal(Object.keys(s.hooks).length, 9);
    assert.ok(s.hooks.Stop.some((g: any) => g.hooks.some((h: any) => h.command === "echo foreign")));
    assert.match(JSON.stringify(s.hooks), /dist\/hooks\/run\.js/);

    const worker = readFileSync(join(ctx.paths.claudeDir, "agents", "odd-worker.md"), "utf8");
    assert.match(worker, /^model: sonnet$/m);
    assert.match(readFileSync(join(ctx.paths.claudeDir, "agents", "odd-explore.md"), "utf8"), /^model: haiku$/m);
    const manifest = JSON.parse(readFileSync(ctx.paths.manifestPath, "utf8")) as { files: Record<string, string>; oddVersion: string };
    assert.ok(manifest.files["agents/odd-worker.md"]);
    assert.equal(manifest.oddVersion, JSON.parse(readFileSync(join(PLUGIN_ROOT, "package.json"), "utf8")).version);
    assert.ok(m.calls.some((c) => c.cmd === "brew" && c.args[0] === "install"));
    assert.deepEqual(m.calls.filter((c) => c.args[0] === "mcp" && c.args[1] === "add").map((c) => c.args[4]), ["odd-review", "codegraph"]);

    const u = await runFullUninstall({ env, homedir: home, runner: machine().runner });
    assert.equal(u.ok, true, JSON.stringify(u.steps));
    assert.equal(readFileSync(ctx.managed.settingsPath, "utf8"), originalText);
    assert.equal(existsSync(join(ctx.paths.claudeDir, "agents", "odd-worker.md")), false);
    assert.equal(existsSync(ctx.paths.manifestPath), false);
  });
});

describe("applyModels", () => {
  it("rewrites the agent model lines and the stored profile of the installed version", async () => {
    const { home, env, source, ctx } = setup();
    await runFullInstall({ env, homedir: home, runner: machine().runner, source, deps: false });
    const r = applyModels({ env, homedir: home, selection: buildSelection("balanced", { "odd-worker": "opus" }) });
    assert.equal(r.ok, true);
    assert.match(readFileSync(join(ctx.paths.claudeDir, "agents", "odd-worker.md"), "utf8"), /^model: opus$/m);
    assert.equal(readSelection(ctx.paths.dataDir).roles["odd-worker"], "opus");
    assert.equal(readSelection(ctx.paths.dataDir).profile, "custom");
  });
  it("fails clearly when nothing is installed", () => {
    const { home, env } = setup();
    const r = applyModels({ env, homedir: home, selection: defaultSelection() });
    assert.equal(r.ok, false);
    assert.match(r.steps[0]!.detail, /not installed/);
  });
});

describe("odd-peers retirement on install and update", () => {
  const legacy = (ctx: ReturnType<typeof flowContext>): void => {
    mkdirSync(join(ctx.paths.dataDir, "peers", "mailbox"), { recursive: true });
    writeFileSync(join(ctx.paths.dataDir, "peers", "grants.json"), "{}");
    mkdirSync(dirname(ctx.managed.statePath), { recursive: true });
    writeFileSync(ctx.managed.statePath, JSON.stringify({ version: 1, mcp: { added: ["odd-review", "odd-peers"] } }));
  };
  const hasPeers = (c: Call): RunResult | undefined => (c.cmd === "claude" && c.args[0] === "mcp" && c.args[1] === "get" && c.args[2] === "odd-peers" ? ok("odd-peers:\n  Scope: User") : undefined);
  const removed = (calls: Call[]): string[] => calls.filter((c) => c.args[0] === "mcp" && c.args[1] === "remove").map((c) => c.args[c.args.length - 1]!);

  it("install removes our recorded odd-peers and the peers/ directory", async () => {
    const { home, env, source, ctx } = setup();
    legacy(ctx);
    const m = machine({ failOn: hasPeers });
    const r = await runFullInstall({ env, homedir: home, runner: m.runner, source, deps: false });
    assert.deepEqual(removed(m.calls), ["odd-peers"]);
    assert.ok(!m.calls.some((c) => c.args[1] === "add" && c.args.includes("odd-peers")));
    assert.match(r.steps.find((s) => s.id === "mcp")!.detail, /odd-peers: removed/);
    assert.deepEqual(JSON.parse(readFileSync(ctx.managed.statePath, "utf8")).mcp.added.includes("odd-peers"), false);
    assert.equal(existsSync(join(ctx.paths.dataDir, "peers")), false);
  });

  it("update removes our recorded odd-peers and the peers/ directory", async () => {
    const { home, env, source, ctx } = setup();
    await runFullInstall({ env, homedir: home, runner: machine().runner, source, deps: false });
    legacy(ctx);
    const rel = makeRelease("9.9.10");
    const gh = ghRunner(rel, (c) => (c.cmd === "claude" && c.args[0] === "mcp" && c.args[1] === "get" ? (c.args[2] === "odd-peers" ? ok("odd-peers:") : fail("No MCP server named x found")) : undefined));
    const r = await runUpdateFlow({ env, homedir: home, runner: gh.runner, force: true });
    assert.equal(r.status, "updated");
    assert.deepEqual(removed(gh.calls), ["odd-peers"]);
    assert.equal(JSON.parse(readFileSync(ctx.managed.statePath, "utf8")).mcp.added.includes("odd-peers"), false);
    assert.equal(existsSync(join(ctx.paths.dataDir, "peers")), false);
  });

  it("install removes the stale odd-peers skill we installed earlier", async () => {
    const { home, env, source, ctx } = setup();
    await runFullInstall({ env, homedir: home, runner: machine().runner, source, deps: false });
    const content = "---\nname: odd-peers\n---\n";
    const skill = join(ctx.paths.claudeDir, "skills", "odd-peers", "SKILL.md");
    mkdirSync(dirname(skill), { recursive: true });
    writeFileSync(skill, content);
    const manifest = JSON.parse(readFileSync(ctx.paths.manifestPath, "utf8"));
    manifest.files["skills/odd-peers/SKILL.md"] = createHash("sha256").update(content).digest("hex");
    writeFileSync(ctx.paths.manifestPath, JSON.stringify(manifest));
    await runFullInstall({ env, homedir: home, runner: machine().runner, source, deps: false });
    assert.equal(existsSync(skill), false);
    assert.equal(existsSync(dirname(skill)), false);
    assert.equal("skills/odd-peers/SKILL.md" in JSON.parse(readFileSync(ctx.paths.manifestPath, "utf8")).files, false);
  });

  it("a dry run keeps the peers/ directory and the recorded odd-peers and removes nothing", async () => {
    const { home, env, source, ctx } = setup();
    legacy(ctx);
    const m = machine({ failOn: hasPeers });
    await runFullInstall({ env, homedir: home, runner: m.runner, source, deps: false, dryRun: true });
    assert.ok(existsSync(join(ctx.paths.dataDir, "peers", "grants.json")));
    assert.ok(JSON.parse(readFileSync(ctx.managed.statePath, "utf8")).mcp.added.includes("odd-peers"));
    assert.deepEqual(removed(m.calls), []);
  });

  it("install without a recorded odd-peers never removes one", async () => {
    const { home, env, source } = setup();
    const m = machine();
    await runFullInstall({ env, homedir: home, runner: m.runner, source, deps: false });
    assert.deepEqual(removed(m.calls), []);
  });
});

describe("runUpdateFlow and runRollback", () => {
  it("updates, re-applies hooks, MCP and extras with the saved options, then rolls back", async () => {
    const { home, env, source, ctx } = setup();
    await runFullInstall({ env, homedir: home, runner: machine().runner, source, deps: false, extras: { statusLine: false, claudeAi: { connectors: false, skills: true, plugins: true }, builtin: { mode: "keep" } } });
    const rel = makeRelease("9.9.10");
    const gh = ghRunner(rel, (c) => (c.cmd === "claude" && c.args[0] === "mcp" && c.args[1] === "get" ? fail("No MCP server named x found") : undefined));
    const seen: string[] = [];
    const r = await runUpdateFlow({ env, homedir: home, runner: gh.runner, force: true }, (s) => seen.push(s.id));
    assert.equal(r.status, "updated");
    assert.deepEqual(seen, ["update", "hooks", "mcp", "extras"]);
    assert.equal(activeVersion(ctx.paths), "9.9.10");
    const s = JSON.parse(readFileSync(ctx.managed.settingsPath, "utf8")) as Record<string, unknown>;
    assert.equal(s.statusLine, undefined, "saved extras: no status line");
    assert.equal(s.disableClaudeAiConnectors, undefined);
    assert.equal(s.syncClaudeAiSkills, false);

    const back = runRollback({ env, homedir: home });
    assert.equal(back.ok, true);
    assert.equal(activeVersion(ctx.paths), "9.9.9");
    assert.equal(runRollback({ env, homedir: home }).ok, false);
  });

  it("reports up to date and a failed check as steps", async () => {
    const { home, env, source } = setup();
    await runFullInstall({ env, homedir: home, runner: machine().runner, source, deps: false });
    const same = await runUpdateFlow({ env, homedir: home, runner: ghRunner(makeRelease("9.9.9")).runner });
    assert.equal(same.status, "up-to-date");
    assert.equal(same.steps[0]!.status, "skipped");
    const bad = await runUpdateFlow({ env, homedir: home, runner: fakeRunner(() => fail("no gh")).runner, force: true });
    assert.equal(bad.ok, false);
    assert.equal(bad.steps[0]!.status, "failed");
  });
});

describe("detect and backups", () => {
  it("reports node, claude, gh, deps, installed version and the plugin", async () => {
    const { home, env, source } = setup();
    const m = machine({ pluginIds: ["odd-claude@odd-claude"] });
    const before = await detect({ env, homedir: home, runner: m.runner, nodeVersion: "22.1.0" });
    assert.deepEqual(before.node, { version: "22.1.0", ok: true });
    assert.equal(before.claude.present, true);
    assert.deepEqual(before.gh, { present: true, authenticated: true });
    assert.equal(before.deps.engram, false);
    assert.equal(before.deps.brew, true);
    assert.equal(before.installedVersion, null);
    assert.deepEqual(before.pluginIds, ["odd-claude@odd-claude"]);
    assert.equal(before.selection.profile, "balanced");
    assert.equal((await detect({ env, homedir: home, runner: m.runner, nodeVersion: "20.0.0" })).node.ok, false);
    await runFullInstall({ env, homedir: home, runner: machine().runner, source, deps: false });
    assert.equal((await detect({ env, homedir: home, runner: m.runner })).installedVersion, "9.9.9");
  });

  it("a missing claude CLI is reported, not thrown", async () => {
    const { home, env } = setup();
    const runner = (): never => {
      throw new Error("spawn ENOENT");
    };
    const d = await detect({ env, homedir: home, runner });
    assert.equal(d.claude.present, false);
    assert.equal(d.pluginIds, null);
    assert.equal(d.gh.present, false);
  });

  it("lists the backups made by a reinstall over an edited file", async () => {
    const { home, env, source, ctx } = setup();
    await runFullInstall({ env, homedir: home, runner: machine().runner, source, deps: false });
    put(source, "agents/odd-worker.md", "---\nname: odd-worker\ndescription: changed\n---\nnew body\n");
    await runFullInstall({ env, homedir: home, runner: machine().runner, source, deps: false });
    assert.ok(backupsOf({ env, homedir: home }).length >= 1);
    assert.ok(existsSync(ctx.paths.backupsDir));
  });
});
