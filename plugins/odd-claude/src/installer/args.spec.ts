import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FLAG_SPECS, extrasFromArgs, parseArgs, selectionFromArgs, usage, type ParsedArgs } from "./args.js";

const parse = (...argv: string[]): ParsedArgs => {
  const r = parseArgs(argv);
  assert.ok(r.ok, r.ok ? "" : r.error);
  return r.args;
};
const fails = (...argv: string[]): string => {
  const r = parseArgs(argv);
  assert.ok(!r.ok, "expected a parse error");
  return r.ok ? "" : r.error;
};

describe("parseArgs", () => {
  it("defaults: no subcommand means the TUI, everything on", () => {
    const a = parse();
    assert.equal(a.command, undefined);
    assert.deepEqual([a.dryRun, a.yes, a.json, a.deps, a.statusLine, a.keepBuiltin, a.purge, a.force], [false, false, false, true, true, false, false, false]);
    assert.deepEqual(a.claudeAi, { connectors: true, skills: true, plugins: true });
    assert.deepEqual([a.models, a.disableBuiltin], [[], []]);
  });

  it("accepts each subcommand", () => {
    for (const c of ["install", "update", "uninstall", "rollback", "models", "backups", "status"]) assert.equal(parse(c).command, c);
  });

  it("maps every flag", () => {
    const a = parse("install", "--source", "/x", "--profile", "economy", "--model", "worker=opus", "--model", "odd-explore=sonnet", "--dry-run", "--yes", "--no-deps", "--no-statusline",
      "--keep-claude-ai-connectors", "--keep-claude-ai-skills", "--keep-claude-ai-plugins", "--keep-builtin-plugins", "--disable-builtin", "a@builtin", "--disable-builtin", "b@builtin",
      "--purge", "--force", "--to", "1.2.3", "--json", "--restore", "2026-01-01");
    assert.deepEqual(
      [a.source, a.profile, a.models, a.dryRun, a.yes, a.deps, a.statusLine, a.claudeAi, a.keepBuiltin, a.disableBuiltin, a.purge, a.force, a.to, a.json, a.restore],
      ["/x", "economy", ["worker=opus", "odd-explore=sonnet"], true, true, false, false, { connectors: false, skills: false, plugins: false }, true, ["a@builtin", "b@builtin"], true, true, "1.2.3", true, "2026-01-01"],
    );
  });

  it("supports --flag=value", () => {
    const a = parse("install", "--profile=max", "--model=worker=haiku");
    assert.deepEqual([a.profile, a.models], ["max", ["worker=haiku"]]);
  });

  it("accepts the internal reapply subcommand", () => {
    assert.equal(parse("reapply").command, "reapply");
  });

  it("recognizes --help and --version without a subcommand", () => {
    assert.equal(parse("--help").help, true);
    assert.equal(parse("-h").help, true);
    assert.equal(parse("--version").version, true);
  });

  it("rejects an unknown flag, an unknown subcommand and a missing value", () => {
    assert.match(fails("install", "--bogus"), /unknown flag --bogus/);
    assert.match(fails("frobnicate"), /unknown command frobnicate/);
    assert.match(fails("install", "--source"), /--source requires a value/);
    assert.match(fails("install", "--dry-run=1"), /--dry-run does not take a value/);
    assert.match(fails("install", "update"), /unexpected argument update/);
  });
});

describe("selectionFromArgs", () => {
  it("is undefined when neither --profile nor --model is given (keeps the stored selection)", () => {
    assert.equal(selectionFromArgs(parse("install")), undefined);
  });
  it("--profile picks a preset", () => {
    assert.equal(selectionFromArgs(parse("install", "--profile", "economy"))!.profile, "economy");
  });
  it("--model accepts the short and the full role name and turns the preset into custom", () => {
    const s = selectionFromArgs(parse("install", "--model", "worker=opus", "--model", "odd-explore=sonnet"))!;
    assert.equal(s.profile, "custom");
    assert.equal(s.roles["odd-worker"], "opus");
    assert.equal(s.roles["odd-explore"], "sonnet");
    assert.equal(s.roles["odd-verify"], "opus");
  });
  it("--model equal to the preset keeps the preset", () => {
    assert.equal(selectionFromArgs(parse("install", "--model", "worker=sonnet"))!.profile, "balanced");
  });
  it("rejects bad input with the available values", () => {
    assert.throws(() => selectionFromArgs(parse("install", "--model", "worker=gpt")), /invalid model "gpt"; available models: haiku, sonnet, opus/);
    assert.throws(() => selectionFromArgs(parse("install", "--model", "nobody=opus")), /invalid role "nobody"; available roles: odd-explore/);
    assert.throws(() => selectionFromArgs(parse("install", "--model", "worker")), /--model expects <role>=<model>/);
    assert.throws(() => selectionFromArgs(parse("install", "--profile", "turbo")), /invalid profile "turbo"; available profiles: balanced, economy, max, custom/);
  });
});

describe("extrasFromArgs", () => {
  it("defaults to every extra on and every builtin disabled", () => {
    assert.deepEqual(extrasFromArgs(parse("install")), { statusLine: true, claudeAi: { connectors: true, skills: true, plugins: true }, builtin: { mode: "all" } });
  });
  it("maps the opt-out flags", () => {
    assert.deepEqual(extrasFromArgs(parse("install", "--no-statusline", "--keep-claude-ai-skills", "--keep-builtin-plugins")), {
      statusLine: false,
      claudeAi: { connectors: true, skills: false, plugins: true },
      builtin: { mode: "keep" },
    });
  });
  it("--disable-builtin selects a subset", () => {
    assert.deepEqual(extrasFromArgs(parse("install", "--disable-builtin", "x@builtin")).builtin, { mode: "subset", ids: ["x@builtin"] });
  });
});

describe("usage", () => {
  it("documents every flag and every subcommand", () => {
    const text = usage();
    for (const f of FLAG_SPECS) assert.ok(text.includes(`--${f.name}`), `usage misses --${f.name}`);
    for (const c of ["install", "update", "uninstall", "rollback", "models", "backups", "status"]) assert.ok(text.includes(c), `usage misses ${c}`);
    assert.match(text, /^Usage: odd-claude/);
  });
  it("covers the flags the task lists", () => {
    const names = FLAG_SPECS.map((f) => f.name);
    for (const n of ["source", "profile", "model", "dry-run", "yes", "no-deps", "no-statusline", "keep-claude-ai-connectors", "keep-claude-ai-skills", "keep-claude-ai-plugins", "keep-builtin-plugins", "disable-builtin", "purge", "force", "to", "json", "help", "version"]) {
      assert.ok(names.includes(n), `missing spec ${n}`);
    }
  });
});
