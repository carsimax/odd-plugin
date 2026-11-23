// RDD delivery notice (S2): a delivery command (`git push`, `gh pr create|merge`) with RDD on and an unreviewed
// candidate shows ONE advisory notice and always runs. It never denies, and any failure is silent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runHook } from "../hooks/run.js";
import { preToolUse } from "../hooks/pre-tool-use.js";
import { recordDecline } from "./consent.js";
import { UNREVIEWED_DELIVERY_NOTICE, deliveryNotice } from "./gate.js";
import { committedRangeBase } from "./due.js";
import { setReviewMode } from "./mode.js";
import { resolveRepository } from "./snapshot.js";
import { assessCandidate } from "./risk.js";

const ENV = (() => {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.toUpperCase().startsWith("GIT_")) env[k] = v;
  env.GIT_CONFIG_NOSYSTEM = "1";
  return env;
})();

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.invalid", "-c", "commit.gpgsign=false", "-C", cwd, ...args], { env: ENV, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
}

interface Fixture {
  dir: string;
  repo: string;
  data: string;
  cleanup: () => void;
}

/** A clone with a local bare origin and a feature branch whose committed range (package.json dependency) is high risk. */
function fixture(file = "package.json", change = '{"name":"x","dependencies":{"a":"1.0.0"}}\n'): Fixture {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "odd-notice-")));
  const repo = join(dir, "repo");
  const origin = join(dir, "origin.git");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, file), file === "package.json" ? '{"name":"x"}\n' : "one\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  git(dir, "init", "-q", "--bare", "-b", "main", origin);
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "-q", "-u", "origin", "main");
  git(repo, "remote", "set-head", "origin", "main");
  git(repo, "checkout", "-q", "-b", "feature");
  writeFileSync(join(repo, file), change);
  git(repo, "commit", "-q", "-am", "change");
  const data = join(dir, "data");
  return { dir, repo, data, cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) };
}

const hook = (f: Fixture, command: string, cwd = f.repo, tool = "Bash") =>
  runHook("PreToolUse", JSON.stringify({ session_id: "s1", cwd, tool_name: tool, tool_input: { command } }), { dataDir: f.data });
const SILENT = { exitCode: 0, stdout: "" };
const on = (f: Fixture): void => void setReviewMode("enable", "global", f.repo, { dataDir: f.data });
const off = (f: Fixture): void => void setReviewMode("disable", "global", f.repo, { dataDir: f.data });

function assertNotice(r: { exitCode: number; stdout: string }, why: string): void {
  assert.equal(r.exitCode, 0, why);
  const out = JSON.parse(r.stdout) as unknown;
  assert.deepEqual(out, { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: UNREVIEWED_DELIVERY_NOTICE } }, why);
  assert.doesNotMatch(r.stdout, /permission|"decision"|"continue"|stopReason|"reason"/i, `${why}: never a decision`);
  assert.equal(r.stdout.split(UNREVIEWED_DELIVERY_NOTICE).length - 1, 1, `${why}: exactly one notice`);
}

test("RDD on with an unreviewed high-risk candidate: each delivery command shows exactly one advisory notice and never a decision", () => {
  const f = fixture();
  try {
    on(f);
    for (const c of ["git push", "git push origin feature", "git -C . push -u origin feature", "gh pr create --fill", "gh pr merge 1 --squash", "FOO=1 git push"]) assertNotice(hook(f, c), c);
    assert.equal(UNREVIEWED_DELIVERY_NOTICE, "RDD: this repository has an unreviewed candidate; review it before delivery.");
    assert.equal(deliveryNotice({ cwd: f.repo, command: "git push" }, { dataDir: f.data }), UNREVIEWED_DELIVERY_NOTICE);
  } finally {
    f.cleanup();
  }
});

test("deliveryNotice pins its word match: env prefixes, git -C and chains notice; a chain that commits first is a documented deviation and shows nothing", () => {
  const f = fixture();
  try {
    on(f);
    const notice = (command: string) => deliveryNotice({ cwd: f.repo, command }, { dataDir: f.data });
    for (const c of ["FOO=1 git push", "git -C . push", "git add -A; git push"]) assert.equal(notice(c), UNREVIEWED_DELIVERY_NOTICE, c);
    // deviation: the candidate does not exist yet when such a command starts, so no notice (the command still runs)
    assert.equal(notice("git commit -am x && git push"), undefined);
  } finally {
    f.cleanup();
  }
});

test("RDD off (default or disabled), non-delivery commands, other tools and a chain that changes the candidate stay silent", () => {
  const f = fixture();
  try {
    for (const c of ["git push", "gh pr create --fill"]) assert.deepEqual(hook(f, c), SILENT, `default off: ${c}`);
    off(f);
    assert.deepEqual(hook(f, "git push"), SILENT);
    on(f);
    for (const c of ["ls", "git status", "gh pr view 1", "git pushx", "git commit -m x && git push", "git -C . merge main && git push", "git pull && git push"]) assert.deepEqual(hook(f, c), SILENT, c);
    assert.deepEqual(hook(f, "git push", f.repo, "Read"), SILENT);
    assertNotice(hook(f, "git push"), "control: the same repository does notice");
  } finally {
    f.cleanup();
  }
});

test("a reviewed (declined), low-risk or empty candidate shows nothing", () => {
  const f = fixture();
  const low = fixture("a.txt", "two\n");
  try {
    on(f);
    assertNotice(hook(f, "git push"), "before the decline");
    const base = committedRangeBase(f.repo)!;
    const a = assessCandidate(f.repo, { kind: "base-diff", baseRef: base });
    if (a.status !== "assessed") throw new Error("unreachable");
    recordDecline(resolveRepository(f.repo).commonDir, { target_identity: a.targetIdentity, projection: "committed", risk_level: "high", declined_at: new Date().toISOString() } as never);
    assert.deepEqual(hook(f, "git push"), SILENT, "declined");
    on(low);
    assert.deepEqual(hook(low, "git push"), SILENT, "low risk is not due");
    git(f.repo, "push", "-q", "origin", "feature");
    git(f.repo, "fetch", "-q", "origin");
    git(f.repo, "checkout", "-q", "main");
    assert.deepEqual(hook(f, "git push"), SILENT, "nothing to deliver");
  } finally {
    f.cleanup();
    low.cleanup();
  }
});

test("every failure is silent and never blocks: not a repository, missing directory, broken repository, bad input", () => {
  const f = fixture();
  const plain = join(f.dir, "plain");
  mkdirSync(plain);
  try {
    on(f);
    assert.deepEqual(hook(f, "git push", plain), SILENT, "not a repository");
    assert.deepEqual(hook(f, "git push", join(f.dir, "missing")), SILENT, "missing directory");
    assert.deepEqual(hook(f, "git push origin feature && cd /nope && git push", join(f.dir, "missing")), SILENT);
    for (const input of [{}, { tool_name: "Bash" }, { tool_name: "Bash", cwd: f.repo }, { tool_name: "Bash", cwd: "", tool_input: { command: "git push" } }, { tool_name: "Bash", cwd: f.repo, tool_input: { command: 5 } }, { tool_name: "Bash", cwd: f.repo, tool_input: null }]) {
      assert.equal(preToolUse(input as never, { dataDir: f.data }), undefined, JSON.stringify(input));
    }
    writeFileSync(join(f.repo, ".git", "HEAD"), "garbage\n");
    assert.doesNotThrow(() => hook(f, "git push"));
    assert.deepEqual(hook(f, "git push"), SILENT, "broken repository");
    assert.equal(deliveryNotice({ cwd: f.repo, command: "git push" }, { dataDir: join(f.dir, "no", "such") }), undefined);
  } finally {
    f.cleanup();
  }
});

test("the notice module can never deny: no permission or decision shape in the gate or the PreToolUse hook", () => {
  const root = join(fileURLToPath(import.meta.url), "..", "..", "..");
  for (const file of ["src/review/gate.ts", "src/hooks/pre-tool-use.ts"]) {
    const text = readFileSync(join(root, file), "utf8");
    assert.doesNotMatch(text, /permission[A-Z]|"deny"|"ask"|\bdecision\s*:|"decision"|continue\s*:\s*false|stopReason/, file);
  }
});
