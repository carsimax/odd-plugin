import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveInstallPaths } from "./paths.js";
import { activeVersion, listVersions, stagePayload } from "./payload.js";
import { resolvePlaceholders } from "./placeholders.js";
import { readManifest, sha256, writeManifest } from "./manifest.js";
import { backupFiles, listBackups, restoreBackup } from "./backup.js";
import { applyAgentModel, buildSelection, defaultSelection, readSelection, roleCoverage, writeProfileState } from "./models.js";
import { PROFILE_ROLES, PRESETS, profileContextLine, readProfile } from "../lib/profiles.js";
import { dataDirFromEnv } from "../lib/state.js";
import { runInstall, runUninstall } from "./plan.js";
import { agentMd, makeHome, makeSource, put } from "./installer.testkit.js";

test("resolveInstallPaths: defaults under home, env overrides, data dir matches the runtime resolver", () => {
  const p = resolveInstallPaths({}, "/h");
  assert.deepEqual(p, {
    claudeDir: "/h/.claude",
    oddHome: "/h/.odd-claude",
    versionsDir: "/h/.odd-claude/versions",
    currentLink: "/h/.odd-claude/current",
    dataDir: "/h/.odd-claude/data",
    manifestPath: "/h/.odd-claude/manifest.json",
    backupsDir: "/h/.odd-claude/backups",
  });
  const q = resolveInstallPaths({ CLAUDE_CONFIG_DIR: "/c", ODD_CLAUDE_HOME: "/o" }, "/h");
  assert.equal(q.claudeDir, "/c");
  assert.equal(q.oddHome, "/o");
  assert.equal(q.dataDir, "/o/data");
  assert.equal(q.dataDir, dataDirFromEnv({ ODD_CLAUDE_HOME: "/o" }));
});

test("stagePayload copies the payload into versions/<v> and swaps current atomically", () => {
  const src = makeSource();
  const { paths } = makeHome();
  const r = stagePayload(src, paths, "1.0.0");
  assert.equal(r.changed, true);
  assert.equal(r.versionDir, join(paths.versionsDir, "1.0.0"));
  for (const rel of ["dist/hooks/run.js", "support/memory.md", "agents/odd-worker.md", "skills/odd-doctor/refs/extra.md", "output-styles/odd.md", "support/test-first.md", "hooks/hooks.json", "package.json"]) {
    assert.ok(existsSync(join(paths.versionsDir, "1.0.0", rel)), rel);
  }
  assert.ok(lstatSync(paths.currentLink).isSymbolicLink());
  assert.equal(readlinkSync(paths.currentLink), join("versions", "1.0.0"));
  assert.equal(activeVersion(paths), "1.0.0");
  assert.deepEqual(readdirSync(paths.versionsDir), ["1.0.0"], "no temp leftovers");
  assert.deepEqual(readdirSync(paths.oddHome).sort(), ["current", "versions"]);
});

test("stagePayload resolves placeholders in support, leaves skills raw for the file install", () => {
  const src = makeSource();
  const { paths } = makeHome();
  stagePayload(src, paths, "1.0.0");
  const doc = readFileSync(join(paths.currentLink, "support/verification.md"), "utf8");
  assert.equal(doc, `Support: see ${paths.currentLink}/support/memory.md and data ${paths.dataDir}\n`);
  assert.match(readFileSync(join(paths.currentLink, "skills/odd-doctor/SKILL.md"), "utf8"), /\$\{CLAUDE_PLUGIN_ROOT\}/);
});

test("stagePayload is idempotent, keeps older versions and switches current to the newest", () => {
  const src = makeSource();
  const { paths } = makeHome();
  stagePayload(src, paths, "1.0.0");
  const again = stagePayload(src, paths, "1.0.0");
  assert.equal(again.changed, false);
  put(src, "support/memory.md", "changed doc\n");
  const changed = stagePayload(src, paths, "1.0.0");
  assert.equal(changed.changed, true);
  assert.equal(readFileSync(join(paths.versionsDir, "1.0.0/support/memory.md"), "utf8"), "changed doc\n");
  stagePayload(src, paths, "1.1.0");
  assert.deepEqual(listVersions(paths), ["1.0.0", "1.1.0"]);
  assert.equal(activeVersion(paths), "1.1.0");
  assert.deepEqual(readdirSync(paths.versionsDir).sort(), ["1.0.0", "1.1.0"]);
});

test("stagePayload rejects a version that is not a plain segment and writes nothing", () => {
  const { paths } = makeHome();
  assert.throws(() => stagePayload(makeSource(), paths, "../evil"), /invalid version/);
  assert.equal(existsSync(paths.oddHome) && readdirSync(paths.oddHome).length > 0, false);
  assert.equal(activeVersion(paths), null);
  assert.deepEqual(listVersions(paths), []);
});

test("stages the real plugin tree into a temp oddHome", () => {
  // dist-test/installer -> plugins/odd-claude
  const pluginRoot = resolve(import.meta.dirname, "..", "..");
  const { paths } = makeHome();
  stagePayload(pluginRoot, paths, "5.3.0");
  for (const rel of ["agents/odd-worker.md", "output-styles/odd.md", "rules/odd-delegation.md", "rules/odd-verification.md", "rules/odd-skills.md", "support/SOURCES.md", "skills/odd-doctor/SKILL.md", "package.json"]) assert.ok(existsSync(join(paths.currentLink, rel)), rel);
  assert.ok(statSync(join(paths.currentLink, "dist")).isDirectory());
  assert.equal(existsSync(join(paths.currentLink, "cards")), false, "no cards dir in the payload");
  for (const f of readdirSync(join(paths.currentLink, "support"))) assert.doesNotMatch(readFileSync(join(paths.currentLink, "support", f), "utf8"), /\$\{CLAUDE_PLUGIN_(ROOT|DATA)\}/, f);
});

test("resolvePlaceholders substitutes root and data in a skill line and a support line", () => {
  const v = { root: "/o/current", data: "/o/data" };
  const skill = 'node "${CLAUDE_PLUGIN_ROOT}/dist/cli/x.js" --data-dir "${CLAUDE_PLUGIN_DATA}" --session "${CLAUDE_SESSION_ID}"';
  assert.equal(resolvePlaceholders(skill, v), 'node "/o/current/dist/cli/x.js" --data-dir "/o/data" --session "${CLAUDE_SESSION_ID}"');
  assert.equal(resolvePlaceholders("see `${CLAUDE_PLUGIN_ROOT}/support/memory.md`", v), "see `/o/current/support/memory.md`");
  assert.equal(resolvePlaceholders("x", { root: "$&", data: "$1" }), "x");
  assert.equal(resolvePlaceholders("${CLAUDE_PLUGIN_ROOT}", { root: "/a$&b", data: "" }), "/a$&b");
});

test("manifest round-trips atomically with mode 0644 and sha256 matches", () => {
  const { paths } = makeHome();
  assert.equal(readManifest(paths.manifestPath), null);
  const m = { version: 1 as const, oddVersion: "1.0.0", installedAt: "2026-01-01T00:00:00.000Z", files: { "a/b.md": sha256("x") }, models: defaultSelection() };
  writeManifest(paths.manifestPath, m);
  assert.deepEqual(readManifest(paths.manifestPath), m);
  assert.equal(statSync(paths.manifestPath).mode & 0o777, 0o644);
  assert.equal(sha256("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.deepEqual(readdirSync(paths.oddHome), ["manifest.json"]);
  writeFileSync(paths.manifestPath, "{nope");
  assert.throws(() => readManifest(paths.manifestPath), /not valid JSON/);
});

test("backup copies existing targets before a change and restores them", () => {
  const { paths } = makeHome();
  put(paths.claudeDir, "skills/a/SKILL.md", "original\n");
  const missing = join(paths.claudeDir, "agents/none.md");
  const dir = backupFiles(paths, [join(paths.claudeDir, "skills/a/SKILL.md"), missing]);
  assert.ok(dir && dir.startsWith(paths.backupsDir));
  assert.equal(readFileSync(join(dir, "skills/a/SKILL.md"), "utf8"), "original\n");
  assert.equal(existsSync(join(dir, "agents/none.md")), false);
  const [b] = listBackups(paths);
  assert.deepEqual(b!.files, ["skills/a/SKILL.md"]);
  writeFileSync(join(paths.claudeDir, "skills/a/SKILL.md"), "edited\n");
  assert.deepEqual(restoreBackup(paths, b!.id), ["skills/a/SKILL.md"]);
  assert.equal(readFileSync(join(paths.claudeDir, "skills/a/SKILL.md"), "utf8"), "original\n");
  assert.throws(() => restoreBackup(paths, "nope"), /unknown backup/);
  assert.equal(backupFiles(paths, [missing]), null);
  assert.throws(() => backupFiles(paths, [join(paths.oddHome, "x")]), /outside/);
});

test("models: balanced defaults for every role, presets stay selectable, overrides make a custom profile", () => {
  const bal = defaultSelection();
  assert.equal(bal.profile, "balanced");
  assert.deepEqual(bal.roles, { "odd-explore": "haiku", "odd-verify": "opus", "odd-worker": "sonnet", "odd-jd-fix": "sonnet", "odd-jd-judge-a": "opus", "odd-jd-judge-b": "sonnet", "odd-review-readability": "sonnet", "odd-review-reliability": "sonnet", "odd-review-resilience": "sonnet", "odd-review-risk": "opus" });
  assert.equal(buildSelection("economy").roles["odd-verify"], "haiku");
  assert.equal(buildSelection("max").roles["odd-worker"], "opus");
  const c = buildSelection("balanced", { "odd-worker": "opus" });
  assert.equal(c.profile, "custom");
  assert.equal(c.roles["odd-worker"], "opus");
  assert.equal(buildSelection("balanced", { "odd-worker": "sonnet" }).profile, "balanced");
  assert.throws(() => buildSelection("nope"), /invalid profile/);
  assert.throws(() => buildSelection("balanced", { "odd-nope": "opus" }), /invalid role/);
  assert.throws(() => buildSelection("balanced", { "odd-worker": "gpt" }), /invalid model/);
});

test("applyAgentModel sets, replaces and keeps everything else byte-identical", () => {
  const without = agentMd("odd-worker");
  assert.equal(applyAgentModel(without, "opus"), "---\nname: odd-worker\ndescription: test agent odd-worker\nmaxTurns: 5\nmodel: opus\n---\n\nBody of odd-worker.\n");
  const withModel = agentMd("odd-explore", "haiku");
  assert.equal(applyAgentModel(withModel, "sonnet"), withModel.replace("model: haiku", "model: sonnet"));
  assert.equal(applyAgentModel(withModel, "haiku"), withModel);
  const crlf = "---\r\nname: x\r\nmodel: haiku\r\n---\r\nbody\r\n";
  assert.equal(applyAgentModel(crlf, "opus"), "---\r\nname: x\r\nmodel: opus\r\n---\r\nbody\r\n");
  assert.throws(() => applyAgentModel("no frontmatter", "opus"), /no frontmatter/);
});

test("writeProfileState persists through the profiles API: readProfile and the SessionStart line match", () => {
  const { paths } = makeHome();
  writeProfileState(paths.dataDir, defaultSelection("economy"));
  assert.equal(readProfile({ dataDir: paths.dataDir }).active, "economy");
  assert.deepEqual(readProfile({ dataDir: paths.dataDir }).routing, readProfile({ dataDir: paths.dataDir }).routing);
  assert.equal(readProfile({ dataDir: paths.dataDir }).routing["odd-verify"]!.model, PRESETS.economy["odd-verify"]!.model);
  const custom = buildSelection("balanced", { "odd-worker": "opus", "odd-explore": "sonnet" });
  writeProfileState(paths.dataDir, custom);
  const p = readProfile({ dataDir: paths.dataDir });
  assert.equal(p.active, "custom");
  assert.equal(p.routing["odd-worker"]!.model, "opus");
  assert.equal(p.routing["odd-worker"]!.effort, "medium");
  assert.equal(p.routing["odd-review-risk"]!.model, "opus");
  assert.deepEqual(readSelection(paths.dataDir), custom);
  const line = profileContextLine({ dataDir: paths.dataDir });
  assert.match(line, /Model profile: custom/);
  assert.match(line, /odd-worker=opus/);
  assert.match(line, /odd-explore=sonnet/);
  writeProfileState(paths.dataDir, defaultSelection());
  assert.equal(readProfile({ dataDir: paths.dataDir }).active, "balanced");
  assert.deepEqual(readSelection(paths.dataDir), defaultSelection());
});

test("roleCoverage reports roles without an agent file and unrouted agent files", () => {
  const all = PROFILE_ROLES.map((r) => `${r}.md`);
  assert.deepEqual(roleCoverage(all), { rolesWithoutAgentFile: ["review-refuter", "review-validator"], unroutedAgentFiles: [] });
  const partial = roleCoverage([...all.filter((f) => f !== "odd-jd-fix.md"), "extra.md"]);
  assert.deepEqual(partial.rolesWithoutAgentFile, ["odd-jd-fix", "review-refuter", "review-validator"]);
  assert.deepEqual(partial.unroutedAgentFiles, ["extra.md"]);
});

test("upgrading from a payload with cards/ and older rules leaves no cards dir and exactly the four rules; uninstall removes them", () => {
  const { paths } = makeHome();
  const selection = defaultSelection();
  const old = makeSource();
  put(old, "rules/odd-tracking.md", "old tracking\n");
  put(old, "rules/odd-legacy.md", "old rule\n");
  runInstall({ paths, sourceRoot: old, version: "1.0.0", selection });
  // The current payload no longer ships cards, so simulate the previous release by adding the dir to the staged version.
  put(join(paths.versionsDir, "1.0.0"), "cards/delegation.md", "old card\n");
  assert.ok(existsSync(join(paths.currentLink, "cards")), "precondition: old payload had cards");

  const next = makeSource();
  const RULES = ["odd-delegation.md", "odd-skills.md", "odd-tracking.md", "odd-verification.md"];
  for (const r of RULES) put(next, `rules/${r}`, `new ${r}\n`);
  runInstall({ paths, sourceRoot: next, version: "2.0.0", selection });
  assert.equal(activeVersion(paths), "2.0.0");
  assert.equal(existsSync(join(paths.currentLink, "cards")), false);
  assert.deepEqual(readdirSync(join(paths.claudeDir, "rules")).sort(), RULES);
  assert.equal(readFileSync(join(paths.claudeDir, "rules", "odd-delegation.md"), "utf8"), "new odd-delegation.md\n");

  runUninstall({ paths });
  assert.equal(existsSync(join(paths.claudeDir, "rules", "odd-delegation.md")), false);
});
