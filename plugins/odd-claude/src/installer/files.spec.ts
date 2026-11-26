import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stagePayload } from "./payload.js";
import { applyInstallFiles, applyUninstallFiles, planInstallFiles, planUninstallFiles } from "./files.js";
import { readManifest, sha256 } from "./manifest.js";
import { buildSelection, defaultSelection } from "./models.js";
import { listBackups } from "./backup.js";
import { installPlan, runInstall, runUninstall, summarizePlan, uninstallPlan } from "./plan.js";
import { readProfile } from "../lib/profiles.js";
import { makeHome, makeSource, put } from "./installer.testkit.js";

function setup() {
  const src = makeSource();
  const h = makeHome();
  stagePayload(src, h.paths, "1.0.0");
  return { src, ...h };
}
const actions = (plan: { actions: { action: string }[] }) => plan.actions.map((a) => a.action);

test("install plan targets skills, agents and the output style with placeholders resolved and models applied", () => {
  const { paths } = setup();
  const plan = planInstallFiles(paths, defaultSelection());
  const byRel = Object.fromEntries(plan.actions.map((a) => [a.rel, a]));
  assert.ok(plan.actions.every((a) => a.action === "create"));
  assert.deepEqual(Object.keys(byRel).sort(), ["agents/odd-explore.md", "agents/odd-jd-fix.md", "agents/odd-jd-judge-a.md", "agents/odd-jd-judge-b.md", "agents/odd-review-readability.md", "agents/odd-review-reliability.md", "agents/odd-review-resilience.md", "agents/odd-review-risk.md", "agents/odd-verify.md", "agents/odd-worker.md", "output-styles/odd.md", "skills/odd-doctor/SKILL.md", "skills/odd-doctor/refs/extra.md"]);
  assert.equal(byRel["skills/odd-doctor/SKILL.md"]!.target, join(paths.claudeDir, "skills/odd-doctor/SKILL.md"));
  assert.equal(byRel["skills/odd-doctor/SKILL.md"]!.content!.toString(), `---\nname: odd-doctor\n---\nRun \`node "${paths.currentLink}/dist/cli/doctor.js" --data-dir "${paths.dataDir}"\` for \${CLAUDE_SESSION_ID}\n`);
  assert.equal(byRel["output-styles/odd.md"]!.content!.toString(), `style at ${paths.currentLink}/cards\n`);
  assert.match(byRel["agents/odd-verify.md"]!.content!.toString(), /\nmodel: opus\n/);
  assert.match(byRel["agents/odd-explore.md"]!.content!.toString(), /\nmodel: haiku\n/);
  assert.match(byRel["agents/odd-worker.md"]!.content!.toString(), /\nmodel: sonnet\n/);
  assert.deepEqual(plan.warnings, []);
  assert.equal(existsSync(paths.claudeDir), false, "planning writes nothing");
});

test("agent model: written for each role from balanced defaults and from a custom override", () => {
  const { paths } = setup();
  for (const sel of [defaultSelection(), buildSelection("balanced", { "odd-worker": "opus", "odd-explore": "sonnet" })]) {
    const plan = planInstallFiles(paths, sel);
    for (const [role, model] of Object.entries(sel.roles)) {
      const a = plan.actions.find((x) => x.rel === `agents/${role}.md`)!;
      assert.match(a.content!.toString(), new RegExp(`\\nmodel: ${model}\\n`), `${role} -> ${model}`);
    }
  }
});

test("install writes files, manifest and profile state; a second run is all unchanged", () => {
  const { paths, src } = setup();
  const sel = buildSelection("economy");
  const r = runInstall({ paths, sourceRoot: src, version: "1.0.0", selection: sel });
  assert.equal(r.written.length, 13);
  assert.equal(readFileSync(join(paths.claudeDir, "agents/odd-verify.md"), "utf8").includes("model: haiku"), true);
  const m = readManifest(paths.manifestPath)!;
  assert.equal(m.oddVersion, "1.0.0");
  assert.equal(m.files["agents/odd-worker.md"], sha256(readFileSync(join(paths.claudeDir, "agents/odd-worker.md"))));
  assert.deepEqual(m.models, sel);
  assert.equal(readProfile({ dataDir: paths.dataDir }).active, "economy");
  const again = planInstallFiles(paths, sel);
  assert.ok(again.actions.every((a) => a.action === "unchanged"), JSON.stringify(actions(again)));
  const r2 = applyInstallFiles(paths, again);
  assert.deepEqual([r2.written, r2.backupDir], [[], null]);
  assert.equal(listBackups(paths).length, 0);
});

test("update backs up the previous file before overwriting and the backup is restorable", () => {
  const { paths, src } = setup();
  applyInstallFiles(paths, planInstallFiles(paths, defaultSelection()));
  const target = join(paths.claudeDir, "output-styles/odd.md");
  const before = readFileSync(target, "utf8");
  put(src, "output-styles/odd.md", "new style ${CLAUDE_PLUGIN_ROOT}\n");
  stagePayload(src, paths, "1.1.0");
  const plan = planInstallFiles(paths, defaultSelection());
  assert.equal(plan.actions.find((a) => a.rel === "output-styles/odd.md")!.action, "update");
  const r = applyInstallFiles(paths, plan);
  assert.equal(readFileSync(target, "utf8"), `new style ${paths.currentLink}\n`);
  assert.ok(r.backupDir);
  assert.equal(readFileSync(join(r.backupDir!, "output-styles/odd.md"), "utf8"), before);
  assert.equal(readManifest(paths.manifestPath)!.oddVersion, "1.1.0");
});

test("a user-edited file is a conflict: never overwritten, reported, kept in the ledger", () => {
  const { paths, src } = setup();
  applyInstallFiles(paths, planInstallFiles(paths, defaultSelection()));
  const target = join(paths.claudeDir, "skills/odd-doctor/SKILL.md");
  const originalHash = readManifest(paths.manifestPath)!.files["skills/odd-doctor/SKILL.md"];
  writeFileSync(target, "my edits\n");
  put(src, "skills/odd-doctor/SKILL.md", "new upstream\n");
  stagePayload(src, paths, "1.1.0");
  const plan = planInstallFiles(paths, defaultSelection());
  const c = plan.actions.find((a) => a.rel === "skills/odd-doctor/SKILL.md")!;
  assert.equal(c.action, "conflict");
  assert.match(c.reason!, /edited/);
  const r = applyInstallFiles(paths, plan);
  assert.equal(readFileSync(target, "utf8"), "my edits\n");
  assert.deepEqual(r.conflicts, ["skills/odd-doctor/SKILL.md"]);
  assert.equal(readManifest(paths.manifestPath)!.files["skills/odd-doctor/SKILL.md"], originalHash);
});

test("a foreign file at a target path is a conflict and is never overwritten nor adopted", () => {
  const { paths } = setup();
  put(paths.claudeDir, "agents/odd-worker.md", "someone else's agent\n");
  const plan = planInstallFiles(paths, defaultSelection());
  const c = plan.actions.find((a) => a.rel === "agents/odd-worker.md")!;
  assert.equal(c.action, "conflict");
  assert.match(c.reason!, /not installed by odd-claude/);
  const r = applyInstallFiles(paths, plan);
  assert.equal(readFileSync(join(paths.claudeDir, "agents/odd-worker.md"), "utf8"), "someone else's agent\n");
  assert.equal(readManifest(paths.manifestPath)!.files["agents/odd-worker.md"], undefined);
  assert.equal(r.written.length, 12);
  assert.equal(listBackups(paths).length, 0);
});

test("files that left the payload are removed only when their hash matches, else reported", () => {
  const { paths, src } = setup();
  applyInstallFiles(paths, planInstallFiles(paths, defaultSelection()));
  const extra = join(paths.claudeDir, "skills/odd-doctor/refs/extra.md");
  const style = join(paths.claudeDir, "output-styles/odd.md");
  rmSync(join(src, "skills/odd-doctor/refs/extra.md"));
  rmSync(join(src, "output-styles/odd.md"));
  writeFileSync(style, "edited style\n");
  stagePayload(src, paths, "1.1.0");
  const plan = planInstallFiles(paths, defaultSelection());
  assert.equal(plan.actions.find((a) => a.rel === "skills/odd-doctor/refs/extra.md")!.action, "remove");
  assert.equal(plan.actions.find((a) => a.rel === "output-styles/odd.md")!.action, "conflict");
  const r = applyInstallFiles(paths, plan);
  assert.equal(existsSync(extra), false);
  assert.equal(existsSync(join(paths.claudeDir, "skills/odd-doctor/refs")), false, "emptied dir is removed");
  assert.equal(readFileSync(style, "utf8"), "edited style\n");
  assert.deepEqual(r.removed, ["skills/odd-doctor/refs/extra.md"]);
  const files = readManifest(paths.manifestPath)!.files;
  assert.equal(files["skills/odd-doctor/refs/extra.md"], undefined);
  assert.ok(files["output-styles/odd.md"]);
});

test("uninstall removes only hash-matching files, keeps modified ones, data and backups, and drops current/versions", () => {
  const { paths, src } = setup();
  runInstall({ paths, sourceRoot: src, version: "1.0.0", selection: defaultSelection() });
  put(paths.claudeDir, "skills/mine/SKILL.md", "user skill\n");
  put(paths.dataDir, "persona.json", "{}");
  put(paths.backupsDir, "old/x.md", "b");
  writeFileSync(join(paths.claudeDir, "agents/odd-worker.md"), "edited\n");
  const plan = planUninstallFiles(paths);
  assert.equal(plan.actions.find((a) => a.rel === "agents/odd-worker.md")!.action, "keep");
  const r = runUninstall({ paths, purge: false });
  assert.deepEqual(r.kept, ["agents/odd-worker.md"]);
  assert.equal(r.removed.length, 12);
  assert.equal(readFileSync(join(paths.claudeDir, "agents/odd-worker.md"), "utf8"), "edited\n");
  assert.equal(readFileSync(join(paths.claudeDir, "skills/mine/SKILL.md"), "utf8"), "user skill\n");
  assert.equal(existsSync(join(paths.claudeDir, "skills/odd-doctor")), false);
  assert.equal(existsSync(paths.currentLink), false);
  assert.equal(existsSync(paths.versionsDir), false);
  assert.ok(existsSync(join(paths.dataDir, "persona.json")));
  assert.ok(existsSync(join(paths.backupsDir, "old/x.md")));
  assert.deepEqual(Object.keys(readManifest(paths.manifestPath)!.files), ["agents/odd-worker.md"], "modified file stays in the ledger");
});

test("uninstall with nothing modified removes the ledger; purge also removes data and backups", () => {
  const { paths, src } = setup();
  runInstall({ paths, sourceRoot: src, version: "1.0.0", selection: defaultSelection() });
  put(paths.backupsDir, "old/x.md", "b");
  const r = runUninstall({ paths, purge: true });
  assert.deepEqual(r.kept, []);
  assert.deepEqual(readdirSync(paths.claudeDir), [], "only files we wrote were there, so the dirs we created are gone");
  assert.equal(existsSync(paths.manifestPath), false);
  assert.equal(existsSync(paths.dataDir), false);
  assert.equal(existsSync(paths.backupsDir), false);
  assert.equal(existsSync(paths.oddHome), false);
});

test("uninstall without a manifest removes nothing under the Claude dir", () => {
  const { paths } = makeHome();
  put(paths.claudeDir, "agents/odd-worker.md", "foreign\n");
  const r = runUninstall({ paths, purge: false });
  assert.deepEqual([r.removed, r.kept], [[], []]);
  assert.equal(readFileSync(join(paths.claudeDir, "agents/odd-worker.md"), "utf8"), "foreign\n");
});

test("dry-run plans install and uninstall as serializable actions and writes nothing", () => {
  const src = makeSource();
  const { paths, home } = makeHome();
  const plan = installPlan({ paths, sourceRoot: src, version: "1.0.0", selection: buildSelection("max") });
  const round = JSON.parse(JSON.stringify(plan.actions));
  assert.deepEqual(round, plan.actions);
  assert.ok(plan.actions.some((a) => a.area === "payload" && a.action === "create"));
  assert.ok(plan.actions.some((a) => a.area === "profile" && a.action === "create" && /max/.test(a.detail ?? "")));
  assert.equal(plan.actions.filter((a) => a.area === "file" && a.action === "create").length, 13);
  assert.ok(plan.actions.some((a) => a.area === "manifest"));
  assert.match(summarizePlan(plan), /13 create/);
  assert.deepEqual(readdirSync(home), [], "nothing written under the home");
  const un = uninstallPlan({ paths, purge: true });
  assert.deepEqual(JSON.parse(JSON.stringify(un.actions)), un.actions);
  assert.deepEqual(readdirSync(home), []);
});

test("dry-run after an install reports everything unchanged and writes nothing", () => {
  const { paths, src } = setup();
  runInstall({ paths, sourceRoot: src, version: "1.0.0", selection: defaultSelection() });
  const link = readlinkSync(paths.currentLink);
  const plan = installPlan({ paths, sourceRoot: src, version: "1.0.0", selection: defaultSelection() });
  assert.ok(plan.actions.filter((a) => a.area !== "manifest").every((a) => a.action === "unchanged"), JSON.stringify(plan.actions));
  assert.equal(readlinkSync(paths.currentLink), link);
  assert.deepEqual(listBackups(paths), []);
});
