import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { defaultSelection } from "./models.js";
import { activeVersion, listVersions } from "./payload.js";
import { runInstall } from "./plan.js";
import { readOddState, writeOddState } from "./managed-settings.js";
import { BUNDLE_ASSET, CHECKSUMS_ASSET, RELEASE_REPO, payloadAsset, releaseRepo, releaseTag } from "./release.js";
import { checkLatest, compareVersions, downloadRelease, extractPayload, rollback, runUpdate } from "./update.js";
import { makeHome, makeSource } from "./installer.testkit.js";
import { fail, fakeRunner, ghRunner, makeRelease, ok } from "./update.testkit.js";

const tmp = (): string => mkdtempSync(join(tmpdir(), "odd-upd-"));
const selection = defaultSelection();

function installed(version: string): ReturnType<typeof makeHome> {
  const h = makeHome();
  runInstall({ paths: h.paths, sourceRoot: makeSource(), version, selection });
  return h;
}

describe("release contract", () => {
  it("exports the asset names, tag and repo", () => {
    assert.equal(RELEASE_REPO, "carsimax/odd-plugin");
    assert.equal(releaseRepo({}), "carsimax/odd-plugin");
    assert.equal(releaseRepo({ ODD_CLAUDE_REPO: "me/fork" }), "me/fork");
    assert.equal(releaseTag("1.2.3"), "v1.2.3");
    assert.equal(payloadAsset("1.2.3"), "odd-claude-payload-1.2.3.tar.gz");
    assert.equal(BUNDLE_ASSET, "odd-claude.mjs");
    assert.equal(CHECKSUMS_ASSET, "checksums.txt");
  });
});

describe("compareVersions", () => {
  it("compares numerically, not lexically", () => {
    assert.equal(compareVersions("1.10.0", "1.9.0"), 1);
    assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
    assert.equal(compareVersions("0.9.9", "1.0.0"), -1);
    assert.equal(compareVersions("v2.0.0", "1.99.99"), 1);
  });
  it("ranks a prerelease below its release", () => {
    assert.equal(compareVersions("1.0.0-rc.1", "1.0.0"), -1);
    assert.equal(compareVersions("1.0.0", "1.0.0-rc.1"), 1);
    assert.equal(compareVersions("1.0.0-rc.2", "1.0.0-rc.10"), -1);
  });
});

describe("checkLatest", () => {
  const view = JSON.stringify({ tagName: "v1.5.0", assets: [{ name: "odd-claude.mjs" }] });

  it("runs gh release view with the repo and parses the tag", async () => {
    const { runner, calls } = fakeRunner(() => ok(view));
    const r = await checkLatest(runner, {});
    assert.deepEqual(calls, [{ cmd: "gh", args: ["release", "view", "--repo", "carsimax/odd-plugin", "--json", "tagName,assets"] }]);
    assert.deepEqual(r, { ok: true, version: "1.5.0", assets: ["odd-claude.mjs"] });
  });

  it("honors ODD_CLAUDE_REPO", async () => {
    const { runner, calls } = fakeRunner(() => ok(view));
    await checkLatest(runner, { ODD_CLAUDE_REPO: "me/fork" });
    assert.deepEqual(calls[0]!.args.slice(0, 4), ["release", "view", "--repo", "me/fork"]);
  });

  it("explains a missing gh", async () => {
    const r = await checkLatest(() => { throw new Error("spawnSync gh ENOENT"); }, {});
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /gh/);
    assert.match((r as { error: string }).error, /gh auth login/);
  });

  it("explains an unauthenticated gh", async () => {
    const r = await checkLatest(fakeRunner(() => fail("To get started with GitHub CLI, please run:  gh auth login")).runner, {});
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /gh auth login/);
  });

  it("rejects an invalid tag", async () => {
    const r = await checkLatest(fakeRunner(() => ok(JSON.stringify({ tagName: "../x", assets: [] }))).runner, {});
    assert.equal(r.ok, false);
  });

  it("caches for 6h, expires after, and force bypasses; other state keys survive", async () => {
    const statePath = join(tmp(), "settings-state.json");
    writeOddState(statePath, { mcp: { added: ["x"] } });
    const { runner, calls } = fakeRunner(() => ok(view));
    const t0 = 1_000_000_000_000;
    const a = await checkLatest(runner, {}, { statePath, now: () => t0 });
    const b = await checkLatest(runner, {}, { statePath, now: () => t0 + 5 * 3600_000 });
    assert.equal(calls.length, 1);
    assert.deepEqual(b, a);
    await checkLatest(runner, {}, { statePath, now: () => t0 + 6 * 3600_000 + 1 });
    assert.equal(calls.length, 2);
    await checkLatest(runner, {}, { statePath, now: () => t0 + 6 * 3600_000 + 2, force: true });
    assert.equal(calls.length, 3);
    const st = readOddState(statePath);
    assert.deepEqual(st.mcp, { added: ["x"] });
    assert.equal((st.update as { version: string }).version, "1.5.0");
  });

  it("does not cache failures", async () => {
    const statePath = join(tmp(), "settings-state.json");
    const { runner, calls } = fakeRunner(() => fail("nope"));
    await checkLatest(runner, {}, { statePath });
    await checkLatest(runner, {}, { statePath });
    assert.equal(calls.length, 2);
    assert.equal(existsSync(statePath), false);
  });
});

describe("downloadRelease", () => {
  it("runs gh release download with the three assets and verifies checksums", async () => {
    const rel = makeRelease("2.0.0");
    const { runner, calls } = ghRunner(rel);
    const dest = join(tmp(), "dl");
    const r = await downloadRelease(runner, { repo: "carsimax/odd-plugin", version: "2.0.0", destDir: dest });
    assert.deepEqual(calls[0], {
      cmd: "gh",
      args: ["release", "download", "v2.0.0", "--repo", "carsimax/odd-plugin", "-p", "odd-claude-payload-2.0.0.tar.gz", "-p", "odd-claude.mjs", "-p", "checksums.txt", "-D", dest],
    });
    assert.equal(r.ok, true);
    assert.equal((r as { tarball: string }).tarball, join(dest, "odd-claude-payload-2.0.0.tar.gz"));
    assert.equal((r as { bundle: string }).bundle, join(dest, "odd-claude.mjs"));
  });

  it("fails on a checksum mismatch", async () => {
    const r = await downloadRelease(ghRunner(makeRelease("2.0.0", { tamper: true })).runner, { repo: "a/b", version: "2.0.0", destDir: join(tmp(), "dl") });
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /checksum mismatch.*odd-claude\.mjs/);
  });

  it("fails when checksums.txt has no entry for an asset", async () => {
    const r = await downloadRelease(ghRunner(makeRelease("2.0.0", { omitChecksumFor: "odd-claude.mjs" })).runner, { repo: "a/b", version: "2.0.0", destDir: join(tmp(), "dl") });
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /no checksum entry.*odd-claude\.mjs/);
  });

  it("fails when gh download fails", async () => {
    const r = await downloadRelease(fakeRunner(() => fail("HTTP 404")).runner, { repo: "a/b", version: "2.0.0", destDir: join(tmp(), "dl") });
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /HTTP 404/);
  });

  it("rejects an invalid version before running anything", async () => {
    const { runner, calls } = fakeRunner();
    const r = await downloadRelease(runner, { repo: "a/b", version: "../x", destDir: tmp() });
    assert.equal(r.ok, false);
    assert.equal(calls.length, 0);
  });
});

describe("extractPayload", () => {
  it("lists then extracts with tar and returns the top-level dir", async () => {
    const rel = makeRelease("2.0.0");
    const { runner, calls } = ghRunner(rel);
    const dest = join(tmp(), "x");
    const r = await extractPayload(runner, join(rel.dir, rel.tarball), dest);
    assert.deepEqual(calls.map((c) => c.args[0]), ["-tzf", "-tvzf", "-xzf"]);
    assert.deepEqual(calls[2]!.args, ["-xzf", join(rel.dir, rel.tarball), "-C", dest]);
    assert.equal(r.ok, true);
    const root = (r as { root: string }).root;
    assert.equal(root, join(dest, "odd-claude-2.0.0"));
    assert.equal(readFileSync(join(root, "cards", "version.md"), "utf8"), "release 2.0.0\n");
  });

  for (const bad of ["../evil.txt", "/etc/passwd", "odd-claude-1/../../x", "./odd-claude-1/../.."]) {
    it(`rejects ${bad} without extracting`, async () => {
      const { runner, calls } = fakeRunner((c) => (c.args[0] === "-tzf" ? ok(`odd-claude-1/ok.txt\n${bad}\n`) : undefined));
      const dest = join(tmp(), "x");
      const r = await extractPayload(runner, "/t.tar.gz", dest);
      assert.equal(r.ok, false);
      assert.match((r as { error: string }).error, /unsafe/);
      assert.equal(calls.some((c) => c.args[0] === "-xzf"), false);
    });
  }

  /** A tarball (system tar) whose payload dir holds a symlink. */
  function symlinkTarball(): string {
    const stage = tmp();
    mkdirSync(join(stage, "odd-claude-1"));
    writeFileSync(join(stage, "odd-claude-1", "ok.txt"), "ok\n");
    symlinkSync("/etc/passwd", join(stage, "odd-claude-1", "evil"));
    const tarball = join(tmp(), "link.tar.gz");
    assert.equal(spawnSync("tar", ["-czf", tarball, "-C", stage, "odd-claude-1"]).status, 0);
    return tarball;
  }

  it("rejects a real archive containing a symlink before extracting", async () => {
    const { runner, calls } = ghRunner(makeRelease("2.0.0"));
    const dest = join(tmp(), "x");
    const r = await extractPayload(runner, symlinkTarball(), dest);
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /link/);
    assert.equal(calls.some((c) => c.args[0] === "-xzf"), false);
    assert.equal(existsSync(dest), false);
  });

  const verbose: [string, string][] = [
    ["BSD symlink", "lrwxr-xr-x  0 u  staff       0 Jan  1 00:00 odd-claude-1/evil -> /etc/passwd"],
    ["GNU symlink", "lrwxrwxrwx u/staff 0 2026-01-01 00:00 odd-claude-1/evil -> /etc/passwd"],
    ["BSD hardlink", "hrwxr-xr-x  0 u  staff       0 Jan  1 00:00 odd-claude-1/h link to odd-claude-1/ok.txt"],
    ["GNU hardlink", "hrw-r--r-- u/staff 0 2026-01-01 00:00 odd-claude-1/h link to odd-claude-1/ok.txt"],
    ["arrow only", "-rw-r--r--  0 u staff 0 Jan  1 00:00 odd-claude-1/a -> b"],
  ];
  for (const [label, line] of verbose) {
    it(`rejects a ${label} in the verbose listing`, async () => {
      const { runner, calls } = fakeRunner((c) => (c.args[0] === "-tzf" ? ok("odd-claude-1/ok.txt\n") : c.args[0] === "-tvzf" ? ok(`-rw-r--r--  0 u staff 3 Jan  1 00:00 odd-claude-1/ok.txt\n${line}\n`) : undefined));
      const r = await extractPayload(runner, "/t.tar.gz", join(tmp(), "x"));
      assert.equal(r.ok, false);
      assert.match((r as { error: string }).error, /link/);
      assert.equal(calls.some((c) => c.args[0] === "-xzf"), false);
    });
  }

  it("fails after extraction if a symlink is on disk even when the listing looked clean", async () => {
    const { runner } = ghRunner(makeRelease("2.0.0"), (c) => (c.args[0] === "-tvzf" ? ok("") : undefined));
    const r = await extractPayload(runner, symlinkTarball(), join(tmp(), "x"));
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /symlink/);
  });

  it("rejects an archive with more than one top-level dir", async () => {
    const { runner } = fakeRunner((c) => (c.args[0] === "-tzf" ? ok("a/x\nb/y\n") : undefined));
    const r = await extractPayload(runner, "/t.tar.gz", join(tmp(), "x"));
    assert.equal(r.ok, false);
  });

  it("reports a tar failure", async () => {
    const r = await extractPayload(fakeRunner(() => fail("not gzip")).runner, "/t.tar.gz", join(tmp(), "x"));
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /not gzip/);
  });
});

describe("runUpdate", () => {
  it("downloads, verifies, extracts and installs the newer version", async () => {
    const h = installed("1.0.0");
    const rel = makeRelease("2.0.0");
    const { runner, calls } = ghRunner(rel);
    const r = await runUpdate({ runner, env: {}, paths: h.paths, selection });
    assert.equal(r.status, "updated");
    assert.equal(r.from, "1.0.0");
    assert.equal(r.to, "2.0.0");
    assert.equal(activeVersion(h.paths), "2.0.0");
    assert.deepEqual(listVersions(h.paths), ["1.0.0", "2.0.0"]);
    assert.equal(readFileSync(join(h.paths.currentLink, "cards", "version.md"), "utf8"), "release 2.0.0\n");
    assert.equal(readFileSync(join(h.paths.oddHome, "bin", "odd-claude.mjs"), "utf8"), "// bundle 2.0.0\n");
    assert.ok(existsSync(join(h.paths.claudeDir, "output-styles", "odd.md")));
    assert.deepEqual(calls.map((c) => `${c.cmd} ${c.args[0]}`), ["gh release", "gh release", "tar -tzf", "tar -tvzf", "tar -xzf"]);
    assert.equal(readdirSync(h.paths.oddHome).some((n) => n.startsWith(".update")), false, "temp download dir removed");
  });

  it("reports up to date and downloads nothing", async () => {
    const h = installed("2.0.0");
    const { runner, calls } = ghRunner(makeRelease("2.0.0"));
    const r = await runUpdate({ runner, env: {}, paths: h.paths, selection });
    assert.equal(r.status, "up-to-date");
    assert.equal(calls.length, 1);
  });

  it("does not downgrade when the release is older", async () => {
    const h = installed("3.0.0");
    const r = await runUpdate({ runner: ghRunner(makeRelease("2.0.0")).runner, env: {}, paths: h.paths, selection });
    assert.equal(r.status, "up-to-date");
    assert.equal(activeVersion(h.paths), "3.0.0");
  });

  it("force reinstalls the same version", async () => {
    const h = installed("2.0.0");
    const { runner, calls } = ghRunner(makeRelease("2.0.0"));
    const r = await runUpdate({ runner, env: {}, paths: h.paths, selection, force: true });
    assert.equal(r.status, "updated");
    assert.ok(calls.some((c) => c.args[1] === "download"));
    assert.equal(readFileSync(join(h.paths.currentLink, "cards", "version.md"), "utf8"), "release 2.0.0\n");
  });

  it("dry run reports the plan and changes nothing", async () => {
    const h = installed("1.0.0");
    const { runner, calls } = ghRunner(makeRelease("2.0.0"));
    const r = await runUpdate({ runner, env: {}, paths: h.paths, selection, dryRun: true });
    assert.equal(r.status, "dry-run");
    assert.equal(r.to, "2.0.0");
    assert.ok((r.steps ?? []).length > 0);
    assert.deepEqual(calls.map((c) => c.args[1]), ["view"]);
    assert.equal(activeVersion(h.paths), "1.0.0");
    assert.equal(existsSync(join(h.paths.oddHome, "bin")), false);
  });

  it("reports a failed check without touching the install", async () => {
    const h = installed("1.0.0");
    const r = await runUpdate({ runner: fakeRunner(() => fail("gh auth login")).runner, env: {}, paths: h.paths, selection });
    assert.equal(r.status, "check-failed");
    assert.match(r.error ?? "", /gh auth login/);
    assert.equal(activeVersion(h.paths), "1.0.0");
  });

  it("aborts on a checksum mismatch before staging anything", async () => {
    const h = installed("1.0.0");
    const r = await runUpdate({ runner: ghRunner(makeRelease("2.0.0", { tamper: true })).runner, env: {}, paths: h.paths, selection });
    assert.equal(r.status, "failed");
    assert.match(r.error ?? "", /checksum mismatch/);
    assert.equal(activeVersion(h.paths), "1.0.0");
    assert.deepEqual(listVersions(h.paths), ["1.0.0"]);
  });

  it("rolls back to the previous version when a step after staging fails", async () => {
    const h = installed("1.0.0");
    const before = readFileSync(join(h.paths.claudeDir, "output-styles", "odd.md"), "utf8");
    // A file where bin/ must be makes saving the bundle fail after the payload is staged and the files installed.
    writeFileSync(join(h.paths.oddHome, "bin"), "not a dir");
    const r = await runUpdate({ runner: ghRunner(makeRelease("2.0.0")).runner, env: {}, paths: h.paths, selection });
    assert.equal(r.status, "failed");
    assert.equal(r.rolledBack, true);
    assert.equal(activeVersion(h.paths), "1.0.0");
    assert.equal(readFileSync(join(h.paths.currentLink, "cards", "memory.md"), "utf8"), "memory card\n");
    assert.equal(readFileSync(join(h.paths.claudeDir, "output-styles", "odd.md"), "utf8"), before);
    assert.equal(readdirSync(h.paths.oddHome).some((n) => n.startsWith(".update")), false);
  });
});

describe("rollback", () => {
  it("switches back to the previous version and reinstalls its files", () => {
    const h = installed("1.0.0");
    runInstall({ paths: h.paths, sourceRoot: (() => { const s = makeSource(); writeFileSync(join(s, "cards", "memory.md"), "newer card\n"); return s; })(), version: "2.0.0", selection });
    assert.equal(activeVersion(h.paths), "2.0.0");
    const r = rollback({ paths: h.paths, selection });
    assert.deepEqual({ ok: r.ok, from: r.from, to: r.to }, { ok: true, from: "2.0.0", to: "1.0.0" });
    assert.equal(activeVersion(h.paths), "1.0.0");
    assert.equal(readFileSync(join(h.paths.currentLink, "cards", "memory.md"), "utf8"), "memory card\n");
  });

  it("targets an explicit version", () => {
    const h = installed("1.0.0");
    runInstall({ paths: h.paths, sourceRoot: makeSource(), version: "2.0.0", selection });
    runInstall({ paths: h.paths, sourceRoot: makeSource(), version: "3.0.0", selection });
    const r = rollback({ paths: h.paths, selection, to: "1.0.0" });
    assert.equal(r.ok, true);
    assert.equal(activeVersion(h.paths), "1.0.0");
  });

  it("fails when there is no previous version or the target is unknown", () => {
    const h = installed("1.0.0");
    const a = rollback({ paths: h.paths, selection });
    assert.equal(a.ok, false);
    assert.match(a.error ?? "", /no previous version/);
    const b = rollback({ paths: h.paths, selection, to: "9.9.9" });
    assert.equal(b.ok, false);
    assert.match(b.error ?? "", /not installed/);
    assert.equal(activeVersion(h.paths), "1.0.0");
  });
});

