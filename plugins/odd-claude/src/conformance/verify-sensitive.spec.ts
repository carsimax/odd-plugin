// T3 (S4): the verifier's scratch copy skips sensitive paths and reports them (upstream v5.0.0 verifier preparer policy).
// The copy and listing commands are taken from agents/odd-verify.md and executed against a fixture, so the prose cannot drift from behavior.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const agentFile = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "agents", "odd-verify.md");
const doc = readFileSync(agentFile, "utf8");

/** The inline code span that contains `needle`. */
function span(needle: string): string {
  const m = [...doc.matchAll(/`([^`\n]+)`/g)].map((x) => x[1]!).find((c) => c.includes(needle));
  assert.ok(m, `no code span with ${needle}`);
  return m;
}

// Dummy fixture names only; every file holds CONTENT-MARKER.
const SENSITIVE = [".env", ".env.local", ".envrc", ".netrc", "id.key", "cert.pem", "a.p12", "a.pfx", "auth.json", "sub/.env", "sub/deep/id.key", ".ssh/id_rsa", "secrets/token", "sub/secrets/token", ".aws/credentials", ".credentials/x", ".config/gh/hosts.yml", "UP1/.ENV", "UP2/ID.KEY", "UP3/CERT.PEM"];
const KEPT = ["src/a.ts", "auth.json.example", "oauth.json", "README.md"];

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "odd-vs-"));
  for (const rel of [...SENSITIVE, ...KEPT, ".git/config"]) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), "CONTENT-MARKER\n");
  }
  return root;
}

const run = (cwd: string, s: string, script: string) => spawnSync("bash", ["-c", script], { cwd, env: { ...process.env, s }, encoding: "utf8" });
const listCmd = () => span("-iname"), showCmd = () => span('cat "$s/'), copyCmd = () => span("tar --exclude=./.git");

test("odd-verify copy skips sensitive paths case-insensitively and keeps ordinary files (S4)", () => {
  const root = fixture(), s = mkdtempSync(join(tmpdir(), "odd-vs-s-"));
  try {
    const r = run(root, s, `${listCmd()} && ${copyCmd()}`);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, "");
    for (const rel of SENSITIVE) assert.equal(existsSync(join(s, "work", rel)), false, `${rel} must be skipped`);
    for (const rel of KEPT) assert.equal(existsSync(join(s, "work", rel)), true, `${rel} must be copied`);
    assert.equal(existsSync(join(s, "work", ".git")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(s, { recursive: true, force: true });
  }
});

test("odd-verify lists skipped sensitive paths, case-insensitively, without printing contents (S4)", () => {
  const root = fixture(), s = mkdtempSync(join(tmpdir(), "odd-vs-s-"));
  try {
    const r = run(root, s, `${listCmd()} && ${showCmd()}`);
    assert.equal(r.status, 0, r.stderr);
    const listed = r.stdout.split("\n").filter(Boolean).map((p) => p.replace(/^\.\//, ""));
    for (const rel of SENSITIVE) {
      assert.ok(listed.some((p) => p === rel || rel.startsWith(`${p}/`)), `${rel} not listed: ${listed.join(",")}`);
    }
    for (const rel of KEPT) assert.equal(listed.includes(rel), false, rel);
    assert.ok(!listed.some((p) => p.startsWith(".git")));
    assert.ok(!r.stdout.includes("CONTENT-MARKER"), "contents are never printed");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(s, { recursive: true, force: true });
  }
});

test("odd-verify documents the skipped sensitive report, the skip-not-refuse rule and the unverified rule (S4)", () => {
  assert.match(doc, /skipped sensitive/i);
  assert.match(doc, /never refuse/i);
  assert.match(doc, /unverified/);
});
