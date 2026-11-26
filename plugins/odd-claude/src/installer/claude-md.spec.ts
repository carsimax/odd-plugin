import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { stagePayload } from "./payload.js";
import { planInstallFiles } from "./files.js";
import { readManifest, sha256 } from "./manifest.js";
import { defaultSelection } from "./models.js";
import { listBackups } from "./backup.js";
import { installPlan, runInstall, runUninstall, summarizePlan, uninstallPlan } from "./plan.js";
import { parseBlocks, readDesiredBlocks } from "./claude-md.js";
import { makeHome, makeSource, put } from "./installer.testkit.js";

const sel = defaultSelection();
const open = (id: string) => `<!-- odd-claude:${id} -->`;
const close = (id: string) => `<!-- /odd-claude:${id} -->`;
const blk = (id: string, text: string, eol = "\n") => `${open(id)}${eol}${text}${eol}${close(id)}`;

function setup(blocks: Record<string, string> = { "10-core.md": "Core text ${CLAUDE_PLUGIN_ROOT}\n", "20-style.md": "Style text\n" }) {
  const src = makeSource();
  for (const [n, t] of Object.entries(blocks)) put(src, `claude-md/${n}`, t);
  const h = makeHome();
  const md = join(h.paths.claudeDir, "CLAUDE.md");
  const install = () => runInstall({ paths: h.paths, sourceRoot: src, version: "1.0.0", selection: sel });
  return { src, ...h, md, install };
}
const read = (p: string) => readFileSync(p, "utf8");

test("block ids come from filenames without .md and numeric prefix, ordered by filename", () => {
  const src = makeSource();
  put(src, "claude-md/20-b.md", "B\r\n");
  put(src, "claude-md/10-a-x.md", "A\n\n");
  put(src, "claude-md/zeta.md", "Z");
  put(src, "claude-md/.gitkeep", "");
  put(src, "claude-md/notes.txt", "ignored");
  assert.deepEqual(readDesiredBlocks(src, (s) => s), [{ id: "a-x", text: "A" }, { id: "b", text: "B" }, { id: "zeta", text: "Z" }]);
  put(src, "claude-md/30-zeta.md", "dup");
  assert.throws(() => readDesiredBlocks(src, (s) => s), /duplicate block id zeta/);
});

test("a payload without claude-md or rules installs as before", () => {
  const { src, paths, md } = setup({});
  const r = runInstall({ paths, sourceRoot: src, version: "1.0.0", selection: sel });
  assert.equal(existsSync(md), false);
  assert.equal(existsSync(join(paths.claudeDir, "rules")), false);
  assert.equal(readManifest(paths.manifestPath)!.blocks, undefined);
  assert.deepEqual(r.conflicts, []);
});

test("install creates CLAUDE.md with the blocks in order, placeholders resolved, ledger hashes recorded", () => {
  const { paths, md, install } = setup();
  const r = install();
  assert.equal(read(md), `${blk("core", `Core text ${paths.currentLink}`)}\n\n${blk("style", "Style text")}\n`);
  assert.ok(r.written.includes("CLAUDE.md#core") && r.written.includes("CLAUDE.md#style"));
  assert.deepEqual(readManifest(paths.manifestPath)!.blocks, { core: sha256(`Core text ${paths.currentLink}`), style: sha256("Style text") });
});

test("install appends to a user file and keeps the user text byte for byte, in the file's line ending", () => {
  const { paths, md, install } = setup();
  const user = "# Mine\r\nkeep  me\t\n\nno trailing newline";
  mkdirSync(paths.claudeDir, { recursive: true });
  writeFileSync(md, user);
  install();
  const after = read(md);
  assert.ok(after.startsWith(user + "\r\n\r\n" + open("core")), JSON.stringify(after));
  assert.ok(after.includes(`${open("core")}\r\nCore text`), "CRLF file gets CRLF blocks");
  const appended = after.slice(user.length);
  assert.equal(appended.split("\r\n").length, appended.split("\n").length, "appended text has no bare LF");
  assert.equal(listBackups(paths).length, 1, "the existing file was backed up before the append");
});

test("install over an existing CLAUDE.md backs it up first", () => {
  const { paths, md, install } = setup();
  mkdirSync(paths.claudeDir, { recursive: true });
  writeFileSync(md, "user\n");
  const r = install();
  assert.ok(r.backupDir);
  assert.equal(read(join(r.backupDir!, "CLAUDE.md")), "user\n");
});

test("second install is unchanged: file untouched, no backup, plan says unchanged", () => {
  const { paths, md, install } = setup();
  install();
  const before = read(md);
  const plan = planInstallFiles(paths, sel);
  assert.deepEqual(plan.blocks.map((b) => b.action), ["unchanged", "unchanged"]);
  const r = install();
  assert.equal(read(md), before);
  assert.deepEqual([r.written.filter((w) => w.startsWith("CLAUDE.md")), r.backupDir], [[], null]);
});

test("a changed block source updates only that block, with a backup, leaving user text around it", () => {
  const { src, paths, md, install } = setup();
  install();
  writeFileSync(md, `top\n\n${read(md)}\nbottom\n`);
  put(src, "claude-md/10-core.md", "Core v2\n");
  const r = install();
  const text = read(md);
  assert.ok(text.startsWith(`top\n\n${blk("core", "Core v2")}\n\n${blk("style", "Style text")}\n\nbottom\n`.slice(0, 40)));
  assert.ok(text.includes(blk("core", "Core v2")) && text.endsWith("\nbottom\n") && text.startsWith("top\n\n"));
  assert.ok(r.backupDir && read(join(r.backupDir, "CLAUDE.md")).includes("Core text"));
  assert.equal(readManifest(paths.manifestPath)!.blocks!.core, sha256("Core v2"));
});

test("an edited block is a conflict: kept, reported, ledger keeps the old hash", () => {
  const { src, paths, md, install } = setup();
  install();
  const oldHash = readManifest(paths.manifestPath)!.blocks!.core;
  writeFileSync(md, read(md).replace("Core text", "My edit of core text"));
  put(src, "claude-md/10-core.md", "Core v2\n");
  const plan = installPlan({ paths, sourceRoot: src, version: "1.0.0", selection: sel });
  assert.ok(plan.actions.some((a) => a.action === "conflict" && a.path.endsWith("CLAUDE.md#core")));
  assert.match(summarizePlan(plan), /conflict: .*CLAUDE\.md#core \(block was edited since odd-claude installed it\)/);
  const r = install();
  assert.deepEqual(r.conflicts, ["CLAUDE.md#core"]);
  assert.ok(read(md).includes("My edit of core text") && !read(md).includes("Core v2"));
  assert.equal(readManifest(paths.manifestPath)!.blocks!.core, oldHash);
});

test("a foreign block with a shipped id is a conflict, not overwritten", () => {
  const { paths, md, install } = setup();
  mkdirSync(paths.claudeDir, { recursive: true });
  const mine = `${blk("core", "hand written")}\n`;
  writeFileSync(md, mine);
  const r = install();
  assert.ok(r.conflicts.includes("CLAUDE.md#core"));
  assert.ok(read(md).startsWith(mine));
  assert.ok(read(md).includes(blk("style", "Style text")));
});

test("a block no longer shipped is removed when unedited and kept as a conflict when edited", () => {
  for (const edited of [false, true]) {
    const { src, paths, md, install } = setup();
    install();
    if (edited) writeFileSync(md, read(md).replace("Style text", "Style mine"));
    writeFileSync(md, `user\n\n${read(md)}`);
    put(src, "claude-md/20-style.md", "x");
    rmSync2(join(src, "claude-md/20-style.md"));
    const r = install();
    if (edited) {
      assert.deepEqual(r.conflicts, ["CLAUDE.md#style"]);
      assert.ok(read(md).includes("Style mine"));
      assert.ok(readManifest(paths.manifestPath)!.blocks!.style);
    } else {
      assert.deepEqual(r.removed, ["CLAUDE.md#style"]);
      assert.ok(!read(md).includes("odd-claude:style") && read(md).startsWith("user\n\n"));
      assert.equal(readManifest(paths.manifestPath)!.blocks!.style, undefined);
    }
  }
});

import { rmSync } from "node:fs";
const rmSync2 = (p: string) => rmSync(p);

test("malformed markers (duplicate, orphan, unclosed, nested) make every block a conflict and the file is not touched", () => {
  const cases = [
    `${blk("core", "a")}\n${blk("core", "b")}\n`,
    `${close("core")}\n`,
    `${open("other")}\nno close\n`,
    `${open("other")}\n${open("core")}\n${close("core")}\n${close("other")}\n`,
  ];
  for (const bad of cases) {
    const { paths, md, install } = setup();
    mkdirSync(paths.claudeDir, { recursive: true });
    writeFileSync(md, bad);
    const r = install();
    assert.deepEqual(r.conflicts.filter((c) => c.startsWith("CLAUDE.md")), ["CLAUDE.md#core", "CLAUDE.md#style"], bad);
    assert.equal(read(md), bad);
    assert.ok(parseBlocks(bad).malformed);
  }
});

test("uninstall removes owned unedited blocks, keeps edited ones and user text, keeps the ledger for them", () => {
  const { paths, md, install } = setup();
  mkdirSync(paths.claudeDir, { recursive: true });
  writeFileSync(md, "# Mine\n");
  install();
  writeFileSync(md, read(md).replace("Style text", "Style mine") + "tail\n");
  const plan = uninstallPlan({ paths });
  assert.ok(plan.actions.some((a) => a.action === "remove" && a.path === `${md}#core`));
  assert.ok(plan.actions.some((a) => a.action === "keep" && a.path === `${md}#style`));
  const r = runUninstall({ paths });
  assert.deepEqual(r.removed.filter((x) => x.startsWith("CLAUDE.md")), ["CLAUDE.md#core"]);
  assert.deepEqual(r.kept.filter((x) => x.startsWith("CLAUDE.md")), ["CLAUDE.md#style"]);
  const text = read(md);
  assert.ok(text.startsWith("# Mine\n") && text.endsWith("tail\n") && text.includes("Style mine") && !text.includes("Core text"));
  assert.deepEqual(readManifest(paths.manifestPath)!.blocks, { style: sha256("Style text") });
});

test("uninstall restores the user file and deletes CLAUDE.md only when nothing but whitespace remains", () => {
  const a = setup();
  a.install();
  runUninstall({ paths: a.paths });
  assert.equal(existsSync(a.md), false);
  assert.equal(existsSync(a.paths.manifestPath), false);
  const b = setup();
  mkdirSync(b.paths.claudeDir, { recursive: true });
  writeFileSync(b.md, "# Mine\n");
  b.install();
  runUninstall({ paths: b.paths });
  assert.equal(read(b.md), "# Mine\n");
});

test("old manifest without blocks still loads and installs blocks", () => {
  const { paths, md, install } = setup();
  install();
  const m = readManifest(paths.manifestPath)!;
  const { blocks: _b, ...old } = m;
  writeFileSync(paths.manifestPath, JSON.stringify(old));
  assert.equal(readManifest(paths.manifestPath)!.blocks, undefined);
  writeFileSync(md, "");
  const r = install();
  assert.ok(r.written.includes("CLAUDE.md#core"));
  assert.ok(readManifest(paths.manifestPath)!.blocks!.core);
  const dry = installPlan({ paths, sourceRoot: setup().src, version: "1.0.0", selection: sel });
  assert.ok(dry.actions.length > 0);
});

test("rules install as whole files with placeholders and obey the ledger: create, update, conflict, uninstall", () => {
  const { src, paths, install } = setup({});
  put(src, "rules/odd-a.md", "---\npaths:\n  - \"odd/**\"\n---\nsee ${CLAUDE_PLUGIN_ROOT}/support\n");
  put(src, "rules/sub/odd-b.md", "b\n");
  put(src, "rules/.gitkeep", "");
  const target = join(paths.claudeDir, "rules/odd-a.md");
  const r = install();
  assert.ok(r.written.includes("rules/odd-a.md") && r.written.includes("rules/sub/odd-b.md"));
  assert.ok(!existsSync(join(paths.claudeDir, "rules/.gitkeep")));
  assert.ok(read(target).includes(`see ${paths.currentLink}/support`));
  put(src, "rules/odd-a.md", "v2\n");
  put(src, "rules/sub/odd-b.md", "b2\n");
  writeFileSync(join(paths.claudeDir, "rules/sub/odd-b.md"), "mine\n");
  const r2 = install();
  assert.equal(read(target), "v2\n");
  assert.ok(r2.backupDir && read(join(r2.backupDir, "rules/odd-a.md")).includes("see "));
  assert.deepEqual(r2.conflicts, ["rules/sub/odd-b.md"]);
  assert.equal(read(join(paths.claudeDir, "rules/sub/odd-b.md")), "mine\n");
  const u = runUninstall({ paths });
  assert.ok(u.removed.includes("rules/odd-a.md"));
  assert.deepEqual(u.kept, ["rules/sub/odd-b.md"]);
  assert.equal(existsSync(target), false);
});

test("markers inside fenced code blocks are user text: example marker does not block installs", () => {
  for (const fence of ["```", "~~~", "````"]) {
    const { md, paths, install } = setup();
    mkdirSync(paths.claudeDir, { recursive: true });
    const user = `# Mine\n\n${fence}md\n${open("example")}\n${fence}\n`;
    writeFileSync(md, user);
    const r = install();
    assert.deepEqual(r.conflicts.filter((c) => c.startsWith("CLAUDE.md")), [], fence);
    assert.ok(r.written.includes("CLAUDE.md#core") && r.written.includes("CLAUDE.md#style"));
    assert.ok(read(md).startsWith(user));
  }
});

test("a closed pair for a real id inside a fence is not a block; an unclosed fence hides nothing", () => {
  const fenced = `\`\`\`\n${blk("identity", "x")}\n\`\`\`\n`;
  assert.equal(parseBlocks(fenced).blocks.size, 0);
  assert.equal(parseBlocks(fenced).malformed, null);
  const unclosed = `~~~\n${blk("identity", "x")}\n`;
  assert.equal(parseBlocks(unclosed).blocks.size, 1);
  const real = `${fenced}${blk("identity", "y")}\n`;
  assert.deepEqual([...parseBlocks(real).blocks.keys()], ["identity"]);
  // a shorter or different-char fence does not close
  assert.equal(parseBlocks(`\`\`\`\`\n\`\`\`\n${open("a")}\n\`\`\`\`\n`).malformed, null);
  assert.equal(parseBlocks(`\`\`\`\n~~~\n${open("a")}\n\`\`\`\n`).malformed, null);
});

test("malformed markers outside a fence report a malformed-markers warning and conflict reason", () => {
  const { paths, md, install } = setup();
  mkdirSync(paths.claudeDir, { recursive: true });
  writeFileSync(md, `\`\`\`\n${open("ex")}\n\`\`\`\n${close("core")}\n`);
  const r = install();
  assert.deepEqual(r.conflicts.filter((c) => c.startsWith("CLAUDE.md")), ["CLAUDE.md#core", "CLAUDE.md#style"]);
  assert.ok(r.warnings.some((w) => w.includes("CLAUDE.md has malformed odd-claude markers")), r.warnings.join("|"));
  assert.ok(summarizePlan(installPlan({ paths, sourceRoot: setup().src, version: "1.0.0", selection: sel })).includes("CLAUDE.md has malformed odd-claude markers"));
});

test("a user file without a final newline round-trips install -> uninstall byte for byte (LF and CRLF)", () => {
  for (const user of ["# Mine\nno newline", "# Mine\r\nno newline", "x"]) {
    const { paths, md, install } = setup();
    mkdirSync(paths.claudeDir, { recursive: true });
    writeFileSync(md, user);
    install();
    assert.ok(read(md).includes(open("core")));
    runUninstall({ paths });
    assert.equal(read(md), user, JSON.stringify(user));
  }
});

test("an unclosed fence does not hide installed blocks: reinstall is unchanged and the file does not grow", () => {
  const { paths, md, install } = setup();
  mkdirSync(paths.claudeDir, { recursive: true });
  writeFileSync(md, "# user\n");
  install();
  writeFileSync(md, "```\nunclosed\n" + read(md));
  const before = read(md);
  install();
  install();
  assert.equal(read(md), before);
});

test("a shipped id whose markers sit only inside a closed fence is a conflict, never created", () => {
  const { paths, md, install } = setup();
  mkdirSync(paths.claudeDir, { recursive: true });
  const user = `\`\`\`\n${blk("core", "x")}\n\`\`\`\n`;
  writeFileSync(md, user);
  const r = install();
  assert.ok(r.conflicts.includes("CLAUDE.md#core"));
  assert.equal(read(md).split(open("core")).length, 2);
});
