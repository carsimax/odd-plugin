// S2 (py-contract-extraction): every persisted format has a frozen fixture under test-fixtures/contracts/<format>/, captured from the TS
// implementation by test-fixtures/contracts/capture.mjs (see docs/contracts/persisted-formats.md). Each JSON fixture is fed to the
// implementation through an entry command and must be read without a schema error; Scratch, Logs, Agent status, Output schemas and
// Data dir env are checked against a fresh run in a sandbox. Nothing here imports a product module.
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { REPO_ROOT, run } from "./impl.testkit.js";
import { git, makeFakeReviewer, makeWorld, RANGE, withClient } from "./harness.testkit.js";
import { readState, storeRootFor, validateReceipt } from "./store.testkit.js";

const FIX = join(REPO_ROOT, "test-fixtures", "contracts");
const FORMATS = ["session-state", "plugin-state", "agent-status", "scratch", "logs", "output-schemas", "review-store", "installer", "data-dir-env"];
const SID = "sess-contract-0001";
const STAMP = "2026-11-19T10:00:00.000Z";

const fx = (fmt: string, name: string): string => readFileSync(join(FIX, fmt, name), "utf8");
/** A fixture as planted: placeholders replaced by sandbox values. */
const fill = (text: string, sandbox: string): string => text.split("<SANDBOX>").join(sandbox).split("<TIMESTAMP>").join(STAMP);
/** Fresh output as captured: sandbox path and timestamps replaced by placeholders (the capture script's normalization). */
const norm = (text: string, sandbox: string): string => text.split(sandbox).join("<SANDBOX>").replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, "<TIMESTAMP>");

interface Box {
  root: string;
  home: string;
  data: string;
  work: string;
  env: (extra?: Record<string, string>) => Record<string, string>;
}

function sandboxed(fn: (b: Box) => void | Promise<void>): () => Promise<void> {
  return async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "odd-fixtures-")));
    const b: Box = {
      root,
      home: join(root, "home"),
      data: join(root, "data"),
      work: join(root, "work"),
      env: (extra = {}) => ({ PATH: process.env.PATH ?? "", HOME: join(root, "home"), GIT_CONFIG_NOSYSTEM: "1", ...extra }),
    };
    for (const d of [b.home, b.data, b.work]) mkdirSync(d);
    try {
      await fn(b);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

const plant = (path: string, text: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};
const hook = (b: Box, event: string, input: string) => run("hook-runner", [event], { input, env: b.env({ ODD_CLAUDE_DATA: b.data }) });

test("the 9 persisted formats each have a fixture directory with a captured file", () => {
  assert.deepEqual(readdirSync(FIX).filter((n) => statSync(join(FIX, n)).isDirectory()).sort(), [...FORMATS].sort());
  for (const f of FORMATS) assert.ok(readdirSync(join(FIX, f)).length > 0, `${f} has no captured file`);
});

test("Session state: the captured envelope is read back by the status CLI", sandboxed((b) => {
  const doc = JSON.parse(fx("session-state", "session.json"));
  assert.equal(doc.version, 1);
  plant(join(b.data, "sessions", `${SID}.json`), fill(fx("session-state", "session.json"), b.root));
  const r = run("status", ["--json", "--session", SID], { env: b.env({ ODD_CLAUDE_DATA: b.data }) });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).session.state, JSON.parse(fill(JSON.stringify(doc.data), b.root)));
  // control: another schema version is ignored, so the assertion above really proves a read
  plant(join(b.data, "sessions", `${SID}.json`), JSON.stringify({ ...doc, version: 2 }));
  assert.deepEqual(JSON.parse(run("status", ["--json", "--session", SID], { env: b.env({ ODD_CLAUDE_DATA: b.data }) }).stdout).session.state, {});
}));

test("Plugin-wide state: delegation.json and review-mode.json are read back by their CLIs", sandboxed((b) => {
  for (const f of readdirSync(join(FIX, "plugin-state"))) plant(join(b.data, f), fx("plugin-state", f));
  const c = run("coordinator", [], { env: b.env({ ODD_CLAUDE_DATA: b.data }) });
  assert.equal(c.status, 0, c.stderr);
  assert.match(c.stdout, /^coordinator mode: on \(stored\)/);
  const m = run("review-mode", ["status", "--json", "--cwd", b.work], { env: b.env({ ODD_CLAUDE_DATA: b.data }) });
  assert.equal(m.status, 0, m.stderr);
  assert.deepEqual(JSON.parse(m.stdout).status, { global: "on", cloneLocal: "n/a", problems: [], effective: "on", source: "global" });
}));

test("Agent status, Scratch and Logs: a fresh sandbox run reproduces the fixtures", sandboxed((b) => {
  assert.equal(hook(b, "SessionStart", JSON.stringify({ session_id: SID, cwd: b.work, source: "startup" })).status, 0);
  assert.equal(hook(b, "UserPromptSubmit", JSON.stringify({ session_id: SID, cwd: b.work, prompt: "hello" })).status, 0);
  const fresh = norm(readFileSync(join(b.data, "status", `${SID}.json`), "utf8"), b.root);
  assert.equal(fresh, fx("agent-status", "agent-status.json"));
  assert.equal(JSON.parse(fresh).schema, "odd-claude.agent-status/v1");
  assert.equal((statSync(join(b.data, "status", `${SID}.json`)).mode & 0o777), 0o600);
  const mode = (p: string): string => (statSync(p).mode & 0o777).toString(8).padStart(4, "0");
  const listing = [`${mode(join(b.data, "scratch"))} d scratch/`, `${mode(join(b.data, "scratch", SID))} d scratch/${SID}/`, ""].join("\n");
  assert.equal(listing, fx("scratch", "listing.txt"));
  const bad = hook(b, "SessionStart", "null");
  assert.equal(bad.status, 0);
  assert.equal(bad.stdout, "");
  assert.equal(norm(readFileSync(join(b.data, "logs", "hooks.log"), "utf8"), b.root), fx("logs", "hooks.log"));
}));

test("Output schemas: stats, retro and tasks-lint outputs reproduce the fixtures", sandboxed((b) => {
  const transcript = join(b.root, "transcript.jsonl");
  copyFileSync(join(FIX, "output-schemas", "transcript.jsonl"), transcript);
  hook(b, "UserPromptSubmit", JSON.stringify({ session_id: SID, cwd: b.work, prompt: "again", transcript_path: transcript }));
  const stats = run("stats", ["--json", "--session", SID, "--data-dir", b.data], { env: b.env() });
  assert.equal(norm(stats.stdout, b.root), fx("output-schemas", "stats.json"));
  const retro = run("retro", ["--json", "--transcript", transcript], { env: b.env() });
  assert.equal(norm(retro.stdout, b.root), fx("output-schemas", "retro.json"));
  const repo = join(b.root, "tasksrepo");
  mkdirSync(join(repo, "odd", "tasks"), { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  copyFileSync(join(FIX, "output-schemas", "feature.md"), join(repo, "odd", "tasks", "feature.md"));
  const lint = run("tasks", ["--json", "--cwd", repo], { env: b.env() });
  assert.equal(norm(lint.stdout, b.root), fx("output-schemas", "tasks-lint.json"));
  for (const [name, schema] of [["stats.json", "odd-claude.stats/v1"], ["retro.json", "odd-claude.retro/v1"], ["tasks-lint.json", "odd-claude.tasks-lint/v1"]]) assert.equal(JSON.parse(fx("output-schemas", name!)).schema, schema);
}));

test("Review store: the captured lineage is read by the review server without a store error and stays byte-identical", async () => {
  const w = makeWorld();
  const fake = makeFakeReviewer();
  try {
    const state = JSON.parse(fx("review-store", "review-state.json"));
    const dir = join(storeRootFor(w.commonDir), state.lineage_id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const f of ["review-state.json", "review-receipt.json"]) writeFileSync(join(dir, f), fx("review-store", f), { mode: 0o600 });
    // the fixture verifies on its own: revision hash, receipt hash, state <-> receipt binding
    assert.equal(readState(w.commonDir, state.lineage_id).state, "approved");
    const receipt = validateReceipt(JSON.parse(fx("review-store", "review-receipt.json")));
    assert.equal(receipt.ok, true, JSON.stringify(receipt));
    await withClient({ fake, world: w }, async (c) => {
      const r = await c.call("review_status", { ...RANGE });
      assert.equal(r.isError, false, JSON.stringify(r.body).slice(0, 400));
    });
    for (const f of ["review-state.json", "review-receipt.json"]) assert.equal(readFileSync(join(dir, f), "utf8"), fx("review-store", f));
  } finally {
    w.cleanup();
    fake.cleanup();
  }
});

test("Installer: the captured manifest.json and settings-state.json are read by uninstall --dry-run; a wrong version is rejected", sandboxed((b) => {
  const odd = join(b.home, ".odd-claude");
  mkdirSync(join(b.home, ".claude"));
  for (const f of ["manifest.json", "settings-state.json"]) plant(join(odd, f), fill(fx("installer", f), b.root));
  const ok = run("installer", ["uninstall", "--dry-run", "--json"], { env: b.env() });
  const doc = JSON.parse(ok.stdout);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(doc.ok, true);
  assert.deepEqual(doc.steps.filter((s: { status: string }) => s.status === "failed"), []);
  // control: the same command refuses a manifest of another version
  plant(join(odd, "manifest.json"), JSON.stringify({ ...JSON.parse(fx("installer", "manifest.json")), version: 2 }));
  const bad = run("installer", ["uninstall", "--dry-run", "--json"], { env: b.env() });
  assert.equal(bad.status, 1);
  assert.equal(JSON.parse(bad.stdout).ok, false);
  assert.ok(existsSync(join(odd, "manifest.json")));
}));

test("Data dir env: every row of the table resolves to its data dir", sandboxed((b) => {
  const table = JSON.parse(fill(fx("data-dir-env", "table.json"), b.root)) as { env: Record<string, string>; dataDir: string }[];
  assert.ok(table.length >= 7);
  for (const row of table) {
    const r = run("status", ["--json"], { env: b.env(row.env) });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).dataDir, row.dataDir, JSON.stringify(row.env));
  }
}));
