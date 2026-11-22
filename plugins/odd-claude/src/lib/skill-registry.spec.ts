import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refreshRegistry, scanSkills, renderRegistry, parseFrontmatter, type RefreshDeps } from "./skill-registry.js";
import { skillRegistryCli } from "../cli/skill-registry.js";

function skill(root: string, dir: string, fm: string): string {
  const d = join(root, dir);
  mkdirSync(d, { recursive: true });
  const p = join(d, "SKILL.md");
  writeFileSync(p, `---\n${fm}\n---\n\nbody\n`);
  return p;
}

function fixture(): { base: string; cwd: string; home: string; plugin: string; deps: RefreshDeps; cleanup: () => void } {
  const base = mkdtempSync(join(tmpdir(), "odd-reg-"));
  const cwd = join(base, "proj");
  const home = join(base, "home");
  const plugin = join(base, "plug");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(home, { recursive: true });
  skill(join(cwd, "skills"), "alpha", 'name: alpha\ndescription: "Trigger: alpha things. Project one."');
  skill(join(cwd, ".claude", "skills"), "beta", "name: beta\ndescription: >-\n  Trigger: beta\n  folded text");
  skill(join(home, ".claude", "skills"), "alpha", "name: alpha\ndescription: User alpha");
  skill(join(home, ".claude", "skills"), "gamma", "name: gamma\ndescription: User gamma | pipe");
  skill(join(home, ".claude", "skills"), "sdd-init", "name: sdd-init\ndescription: skipped");
  skill(join(home, ".claude", "skills"), "hidden", "name: hidden\ndescription: nope\ndisable-model-invocation: true");
  skill(join(plugin, "skills"), "delta", "name: delta\ndescription: Plugin delta");
  skill(join(plugin, "skills"), "skill-registry", "name: skill-registry\ndescription: self");
  const deps: RefreshDeps = {
    cwd,
    home,
    plugins: [{ name: "odd-claude", root: plugin }],
    env: {},
    gitTracked: () => [],
  };
  return { base, cwd, home, plugin, deps, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

test("parseFrontmatter handles quotes, folded blocks and flags", () => {
  const fm = parseFrontmatter('---\nname: x\ndescription: >-\n  a\n  b\ndisable-model-invocation: true\n---\nbody');
  assert.deepEqual(fm, { name: "x", description: "a b", disableModelInvocation: true });
  assert.deepEqual(parseFrontmatter("no frontmatter"), {});
});

test("scan: project beats user, plugin skills are namespaced, excluded/hidden skills are dropped", () => {
  const f = fixture();
  try {
    const { entries } = scanSkills(f.deps);
    const names = entries.map((e) => e.name);
    assert.deepEqual(names, ["alpha", "beta", "gamma", "odd-claude:delta"]);
    const alpha = entries.find((e) => e.name === "alpha")!;
    assert.equal(alpha.scope, "project");
    assert.match(alpha.path, /proj\/skills\/alpha\/SKILL\.md$/);
    assert.equal(entries.find((e) => e.name === "gamma")!.scope, "user");
    assert.equal(entries.find((e) => e.name === "odd-claude:delta")!.scope, "plugin");
  } finally {
    f.cleanup();
  }
});

test("render: rows by trigger and path, pipes escaped, deterministic", () => {
  const f = fixture();
  try {
    const { sources, entries } = scanSkills(f.deps);
    const md = renderRegistry(f.cwd, sources, entries);
    assert.match(md, /^# Skill Registry — proj/);
    assert.match(md, /\| `gamma` \| User gamma \\\| pipe \| user \| `.*gamma\/SKILL\.md` \|/);
    assert.match(md, /\| `beta` \| Trigger: beta folded text \| project \|/);
    assert.equal(md, renderRegistry(f.cwd, sources, entries));
  } finally {
    f.cleanup();
  }
});

test("refresh writes registry, cache and .atl/.gitignore; second run skips without touching files", () => {
  const f = fixture();
  try {
    const first = refreshRegistry(f.deps);
    assert.equal(first.status, "written");
    assert.equal(first.skillCount, 4);
    const reg = join(f.cwd, ".atl", "skill-registry.md");
    assert.match(readFileSync(reg, "utf8"), /`odd-claude:delta`/);
    assert.equal(readFileSync(join(f.cwd, ".atl", ".gitignore"), "utf8"), "*\n");
    const old = new Date(Date.now() - 100000);
    utimesSync(reg, old, old);
    const before = statSync(reg, { bigint: true });
    const second = refreshRegistry(f.deps);
    assert.deepEqual([second.status, second.reason], ["unchanged", "fingerprint-unchanged"]);
    const after = statSync(reg, { bigint: true });
    assert.deepEqual([after.mtimeNs, after.ino, after.size], [before.mtimeNs, before.ino, before.size]);
    // a changed skill file triggers a rewrite
    skill(join(f.cwd, "skills"), "alpha", 'name: alpha\ndescription: "changed description"');
    const third = refreshRegistry(f.deps);
    assert.equal(third.status, "written");
    assert.match(readFileSync(reg, "utf8"), /changed description/);
  } finally {
    f.cleanup();
  }
});

test("a fingerprint change with identical rendered bytes does not rewrite the registry", () => {
  const f = fixture();
  try {
    refreshRegistry(f.deps);
    const reg = join(f.cwd, ".atl", "skill-registry.md");
    const old = new Date(Date.now() - 100000);
    utimesSync(reg, old, old);
    const before = statSync(reg, { bigint: true });
    const p = join(f.cwd, "skills", "alpha", "SKILL.md");
    utimesSync(p, new Date(), new Date(Date.now() + 5000)); // mtime only
    const r = refreshRegistry(f.deps);
    assert.deepEqual([r.status, r.reason], ["unchanged", "bytes-identical"]);
    const after = statSync(reg, { bigint: true });
    assert.deepEqual([after.mtimeNs, after.ino, after.size], [before.mtimeNs, before.ino, before.size]);
  } finally {
    f.cleanup();
  }
});

test("opt-out env, home/root cwd and subagents skip with no writes", () => {
  const f = fixture();
  try {
    const r = refreshRegistry({ ...f.deps, env: { ODD_CLAUDE_NO_SKILL_REGISTRY: "1" } });
    assert.deepEqual([r.status, r.reason], ["skipped", "opt-out"]);
    assert.equal(existsSync(join(f.cwd, ".atl")), false);
    assert.equal(refreshRegistry({ ...f.deps, cwd: f.home }).reason, "home-or-broad-directory");
    assert.equal(refreshRegistry({ ...f.deps, cwd: "/" }).reason, "home-or-broad-directory");
    assert.equal(refreshRegistry({ ...f.deps, cwd: join(f.base, "missing") }).reason, "no-cwd");
  } finally {
    f.cleanup();
  }
});

test("git-tracked targets are preserved on automatic refresh and overridden by force", () => {
  const f = fixture();
  try {
    const tracked = { ...f.deps, gitTracked: () => [".atl/skill-registry.md"] };
    const r = refreshRegistry(tracked);
    assert.equal(r.status, "skipped");
    assert.equal(r.reason, "tracked-target");
    assert.match(r.warning ?? "", /tracked targets: \.atl\/skill-registry\.md/);
    assert.equal(existsSync(join(f.cwd, ".atl", "skill-registry.md")), false);
    const forced = refreshRegistry({ ...tracked, force: true });
    assert.equal(forced.status, "written");
    // git cannot answer: fail closed on automatic runs
    const broken = refreshRegistry({ ...f.deps, gitTracked: () => { throw new Error("boom"); }, cwd: f.cwd });
    assert.equal(broken.reason, "git-unavailable");
  } finally {
    f.cleanup();
  }
});

test(".atl/.gitignore keeps an existing trailing * and appends otherwise", () => {
  const f = fixture();
  try {
    mkdirSync(join(f.cwd, ".atl"));
    writeFileSync(join(f.cwd, ".atl", ".gitignore"), "foo");
    refreshRegistry(f.deps);
    assert.equal(readFileSync(join(f.cwd, ".atl", ".gitignore"), "utf8"), "foo\n*\n");
    refreshRegistry({ ...f.deps, force: true });
    assert.equal(readFileSync(join(f.cwd, ".atl", ".gitignore"), "utf8"), "foo\n*\n");
  } finally {
    f.cleanup();
  }
});

test("empty scan writes an empty registry so agents stop searching", () => {
  const base = mkdtempSync(join(tmpdir(), "odd-reg-empty-"));
  try {
    const cwd = join(base, "p");
    mkdirSync(cwd);
    const r = refreshRegistry({ cwd, home: join(base, "h"), plugins: [], env: {}, gitTracked: () => [] });
    assert.deepEqual([r.status, r.skillCount], ["written", 0]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("CLI refresh prints path, count and whether bytes changed", () => {
  const f = fixture();
  try {
    const a = skillRegistryCli(["--cwd", f.cwd, "--force"], { ...f.deps, env: {} });
    assert.equal(a.exitCode, 0);
    assert.match(a.stdout, /skill registry: 4 skills written to .*\.atl\/skill-registry\.md/);
    const b = skillRegistryCli(["--cwd", f.cwd], { ...f.deps, env: {} });
    assert.match(b.stdout, /unchanged/);
    const guarded = skillRegistryCli(["--cwd", f.cwd], { ...f.deps, gitTracked: () => [".atl/skill-registry.md"] });
    assert.equal(guarded.exitCode, 1);
    assert.match(guarded.stderr, /skipped: tracked-target/);
    assert.equal(skillRegistryCli(["--bogus"], f.deps).exitCode, 2);
  } finally {
    f.cleanup();
  }
});
