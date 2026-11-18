import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isTrustedProject, listTrustedProjects, trustProject, untrustProject } from "./codegraph-trust.js";
import { codegraphTrustCli } from "../cli/codegraph-trust.js";

function tmp(): { dir: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "odd-trust-"));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("trust: default untrusted; explicit trust is per project path; untrust reverts", () => {
  const t = tmp();
  try {
    const o = { dataDir: t.dir };
    assert.equal(isTrustedProject("/a/proj", {}, o), false);
    trustProject("/a/proj", o);
    assert.equal(isTrustedProject("/a/proj", {}, o), true);
    assert.equal(isTrustedProject("/a/proj/", {}, o), true);
    assert.equal(isTrustedProject("/a/other", {}, o), false);
    trustProject("/a/proj", o); // idempotent
    assert.deepEqual(listTrustedProjects(o), ["/a/proj"]);
    untrustProject("/a/proj", o);
    assert.equal(isTrustedProject("/a/proj", {}, o), false);
  } finally {
    t.done();
  }
});

test("trust: the env var ODD_CLAUDE_CODEGRAPH_WARMUP is ignored (repo settings can set env); no data dir means untrusted, never throws", () => {
  assert.equal(isTrustedProject("/x", { ODD_CLAUDE_CODEGRAPH_WARMUP: "1" }, { dataDir: "/nonexistent-odd-dir" }), false);
  assert.equal(isTrustedProject("/x", {}, { env: {} }), false);
});

test("trust cli: trust/untrust/list with exit codes", () => {
  const t = tmp();
  try {
    const env = { CLAUDE_PLUGIN_DATA: t.dir };
    assert.equal(codegraphTrustCli(["--action", "list"], env).stdout, "no trusted projects");
    const r = codegraphTrustCli(["--action", "trust", "--cwd", "/a/proj"], env);
    assert.equal(r.exitCode, 0);
    assert.match(r.stdout, /trusted: \/a\/proj/);
    assert.match(codegraphTrustCli(["--action", "list"], env).stdout, /\/a\/proj/);
    assert.match(codegraphTrustCli(["--action", "untrust", "--cwd", "/a/proj"], env).stdout, /untrusted: \/a\/proj/);
    assert.equal(codegraphTrustCli(["--action", "nope"], env).exitCode, 1);
    assert.equal(codegraphTrustCli(["--bogus"], env).exitCode, 2);
    assert.equal(codegraphTrustCli(["--action", "trust"], {}).exitCode, 2); // no data dir
  } finally {
    t.done();
  }
});
