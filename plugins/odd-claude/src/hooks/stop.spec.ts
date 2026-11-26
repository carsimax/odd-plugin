import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runHook } from "./run.js";
import { acquireLock } from "../lib/lock.js";
import { sessionStatePath } from "../lib/state.js";
import { setReviewMode } from "../review/mode.js";
import { recordDecline, REVIEW_TOOL_NAMES } from "../review/consent.js";
import { acknowledgeApproved } from "../review/ack.js";
import { reviewStatus } from "../review/status.js";
import { startReview } from "../review/start.js";
import { storeRootFor } from "../review/store.js";

const PLUGIN_ROOT = join(fileURLToPath(import.meta.url), "..", "..", "..");

const ENV = (() => {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.toUpperCase().startsWith("GIT_")) env[k] = v;
  env.GIT_CONFIG_NOSYSTEM = "1";
  return env;
})();

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.invalid", "-c", "commit.gpgsign=false", "-C", cwd, ...args], { env: ENV, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

interface Fx {
  dir: string;
  data: string;
  repo: string;
  commonDir: string;
  cleanup: () => void;
}

/** A repo with one commit; `dirty` leaves a workspace change: package.json (high risk) or README (low risk). */
function fx(dirty: "high" | "low" | "none" = "high"): Fx {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "odd-stop-")));
  const repo = join(dir, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "package.json"), '{"name":"x"}\n');
  writeFileSync(join(repo, "README.md"), "# t\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  if (dirty === "high") writeFileSync(join(repo, "package.json"), '{"name":"x","dependencies":{"left-pad":"1.0.0"}}\n');
  if (dirty === "low") writeFileSync(join(repo, "README.md"), "# t\n\nmore docs\n");
  return { dir, data: join(dir, "data"), repo, commonDir: realpathSync(join(repo, ".git")), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const stop = (f: Fx, session = "s1", extra: Record<string, unknown> = {}): { exitCode: number; stdout: string } =>
  runHook("Stop", JSON.stringify({ session_id: session, cwd: f.repo, stop_hook_active: false, ...extra }), { dataDir: f.data });

const on = (f: Fx): void => void setReviewMode("enable", "global", f.repo, { dataDir: f.data });

function storeDirs(f: Fx): string[] {
  const p = join(f.commonDir, "odd-plugin");
  return existsSync(p) ? readdirSync(p).sort() : [];
}

test("RDD off (the default): a due candidate never blocks and the output is empty", () => {
  const f = fx();
  try {
    assert.deepEqual(stop(f), { exitCode: 0, stdout: "" });
    setReviewMode("disable", "global", f.repo, { dataDir: f.data });
    assert.deepEqual(stop(f), { exitCode: 0, stdout: "" });
  } finally {
    f.cleanup();
  }
});

test("RDD on and a high-risk candidate is due: one block with a reminder, once per session and candidate", () => {
  const f = fx();
  try {
    on(f);
    const identity = reviewStatus(f.repo).target_identity;
    const r = stop(f);
    assert.equal(r.exitCode, 0);
    const out = JSON.parse(r.stdout) as Record<string, unknown>;
    assert.deepEqual(Object.keys(out).sort(), ["decision", "reason"]);
    assert.equal(out.decision, "block");
    const reason = out.reason as string;
    assert.ok(reason.includes(identity), "names the candidate");
    assert.match(reason, /status/i);
    assert.match(reason, /review_status/);
    assert.match(reason, /review_start/);
    assert.equal(reason.includes("--consent=relay"), false, "no CLI flag form");
    assert.match(reason, /review-mode\.js disable/);
    assert.equal(reason.includes("<plugin>"), false, "no placeholder");
    assert.ok(reason.includes(`node ${join(PLUGIN_ROOT, "dist", "cli", "review-mode.js")} disable`), "real plugin root from the hook module");
    assert.match(reason, /--scope clone --cwd/);
    assert.equal(/provisional/i.test(reason), false, "no placeholder wording");
    for (const t of reason.replaceAll("mcp__odd-review__", "").match(/\breview_[a-z_]+\b/g) ?? []) assert.ok((REVIEW_TOOL_NAMES as readonly string[]).includes(t), `${t} is a registered review tool`);
    // every plugin CLI the reminder names exists (no dangling review.js)
    const named = [...reason.matchAll(/dist\/cli\/([\w-]+\.js)/g)].map((m) => m[1]!);
    assert.ok(named.length > 0);
    for (const n of named) assert.ok(existsSync(join(PLUGIN_ROOT, "dist", "cli", n)), n);
    assert.match(reason, /relay it to the human losslessly and never answer it on the human's behalf/);
    assert.match(reason, /never runs review start itself/);
    assert.match(reason, /once per session and candidate/);
    // same session, same candidate: silent
    assert.deepEqual(stop(f), { exitCode: 0, stdout: "" });
    // another session reminds again
    assert.equal(JSON.parse(stop(f, "s2").stdout).decision, "block");
    // a different candidate in the first session reminds again, then stays silent
    writeFileSync(join(f.repo, "package.json"), '{"name":"x","dependencies":{"left-pad":"2.0.0"}}\n');
    assert.equal(JSON.parse(stop(f).stdout).decision, "block");
    assert.deepEqual(stop(f), { exitCode: 0, stdout: "" });
  } finally {
    f.cleanup();
  }
});

test("the hook only reads: it creates no review authority and never starts a review", () => {
  const f = fx();
  try {
    on(f);
    const before = storeDirs(f);
    assert.equal(JSON.parse(stop(f).stdout).decision, "block");
    assert.deepEqual(storeDirs(f), before);
    assert.equal(existsSync(storeRootFor(f.commonDir)), false);
  } finally {
    f.cleanup();
  }
});

test("silent when the candidate is not due (low risk), absent, or stop_hook_active", () => {
  const low = fx("low");
  const none = fx("none");
  const active = fx();
  try {
    on(low);
    on(none);
    on(active);
    assert.deepEqual(stop(low), { exitCode: 0, stdout: "" });
    assert.deepEqual(stop(none), { exitCode: 0, stdout: "" });
    assert.deepEqual(stop(active, "s1", { stop_hook_active: true }), { exitCode: 0, stdout: "" });
    assert.deepEqual(runHook("Stop", JSON.stringify({ session_id: "s1", cwd: join(active.dir, "elsewhere") }), { dataDir: active.data }), { exitCode: 0, stdout: "" });
    assert.deepEqual(runHook("Stop", JSON.stringify({ session_id: "s1" }), { dataDir: active.data }), { exitCode: 0, stdout: "" });
    assert.deepEqual(runHook("Stop", JSON.stringify({ cwd: active.repo }), { dataDir: active.data }), { exitCode: 0, stdout: "" });
  } finally {
    low.cleanup();
    none.cleanup();
    active.cleanup();
  }
});

test("silent when this clone disabled RDD, even with the global switch on", () => {
  const f = fx();
  try {
    on(f);
    setReviewMode("disable", "clone", f.repo, { dataDir: f.data });
    assert.deepEqual(stop(f), { exitCode: 0, stdout: "" });
    setReviewMode("enable", "clone", f.repo, { dataDir: f.data });
    assert.equal(JSON.parse(stop(f).stdout).decision, "block");
  } finally {
    f.cleanup();
  }
});

test("silent when the exact candidate was declined", () => {
  const f = fx();
  try {
    on(f);
    const identity = reviewStatus(f.repo).target_identity;
    recordDecline(f.commonDir, { target_identity: identity, projection: "workspace", risk_level: "high", declined_at: new Date().toISOString() });
    assert.deepEqual(stop(f), { exitCode: 0, stdout: "" });
  } finally {
    f.cleanup();
  }
});

test("silent when the candidate was consumed (reviewed and acknowledged) or is already under review", async () => {
  const f = fx();
  const g = fx();
  try {
    on(f);
    on(g);
    const lowAssessor = () => ({ level: "low" as const, reasons: [{ code: "non_executable_only" }], evidence: [] });
    const started = await startReview({ cwd: f.repo, target: { kind: "current-changes" }, consent: "granted", riskAssessor: lowAssessor });
    assert.equal(started.status, "started");
    if (started.status !== "started") throw new Error("unreachable");
    const ack = started.result.acknowledgement!;
    await acknowledgeApproved(f.commonDir, { lineage: ack.lineage_id, target: ack.target_identity, expectedRevision: ack.expected_revision, token: ack.token });
    assert.deepEqual(stop(f), { exitCode: 0, stdout: "" });
    const high = () => ({ level: "high" as const, reasons: [{ code: "shell_source", signal: "shell_process", path: "package.json" }], evidence: ["x"] });
    const live = await startReview({ cwd: g.repo, target: { kind: "current-changes" }, consent: "granted", riskAssessor: high });
    assert.equal(live.status, "started");
    assert.deepEqual(stop(g), { exitCode: 0, stdout: "" });
  } finally {
    f.cleanup();
    g.cleanup();
  }
});

test("a committed candidate (clean workspace, commits ahead of upstream) is due and blocks once", () => {
  const f = fx("none");
  try {
    const origin = join(f.dir, "origin.git");
    git(f.dir, "init", "-q", "--bare", "-b", "main", origin);
    git(f.repo, "remote", "add", "origin", origin);
    git(f.repo, "push", "-q", "-u", "origin", "main");
    git(f.repo, "remote", "set-head", "origin", "main");
    on(f);
    assert.deepEqual(stop(f), { exitCode: 0, stdout: "" }); // level with upstream: nothing to review
    writeFileSync(join(f.repo, "package.json"), '{"name":"x","dependencies":{"left-pad":"1.0.0"}}\n');
    git(f.repo, "commit", "-q", "-am", "deps");
    const r = stop(f);
    assert.equal(JSON.parse(r.stdout).decision, "block");
    assert.match(JSON.parse(r.stdout).reason, /base-ref [0-9a-f]{40}/);
    assert.deepEqual(stop(f), { exitCode: 0, stdout: "" });
    // a committed low-risk change is not due
    git(f.repo, "reset", "-q", "--hard", "HEAD~1");
    writeFileSync(join(f.repo, "README.md"), "# t\n\ndocs\n");
    git(f.repo, "commit", "-q", "-am", "docs");
    assert.deepEqual(stop(f, "s9"), { exitCode: 0, stdout: "" });
  } finally {
    f.cleanup();
  }
});

test("Stop keeps recording the idle status (v0.5 behavior) with RDD on or off", () => {
  const f = fx();
  try {
    stop(f, "sess-idle");
    on(f);
    stop(f, "sess-idle2");
    for (const id of ["sess-idle", "sess-idle2"]) {
      const body = JSON.parse(readFileSync(join(f.data, "status", `${id}.json`), "utf8")) as { state?: string };
      assert.equal(body.state, "idle");
    }
  } finally {
    f.cleanup();
  }
});

test("10 concurrent Stop processes for one session and candidate: exactly one block, every exit 0", async () => {
  const f = fx();
  try {
    on(f);
    const run = join(PLUGIN_ROOT, "dist", "hooks", "run.js");
    assert.ok(existsSync(run));
    const one = (): Promise<{ code: number | null; out: string }> =>
      new Promise((resolve) => {
        const c = spawn(process.execPath, [run, "Stop"], { env: { ...ENV, CLAUDE_PLUGIN_DATA: f.data }, stdio: ["pipe", "pipe", "ignore"] });
        let out = "";
        c.stdout.on("data", (d: Buffer) => (out += d.toString()));
        c.on("close", (code) => resolve({ code, out }));
        c.stdin.end(JSON.stringify({ session_id: "race", cwd: f.repo, stop_hook_active: false }));
      });
    const results = await Promise.all(Array.from({ length: 10 }, one));
    assert.deepEqual(results.map((r) => r.code), Array(10).fill(0));
    const blocks = results.filter((r) => r.out.trim() !== "");
    assert.equal(blocks.length, 1);
    assert.equal(JSON.parse(blocks[0]!.out).decision, "block");
  } finally {
    f.cleanup();
  }
});

test("session lock held by a live pid: Stop is silent, exits 0 and returns in under 5 s", () => {
  const f = fx();
  const holder = spawn("sleep", ["30"], { stdio: "ignore" });
  try {
    on(f);
    const lock = `${sessionStatePath("held", { dataDir: f.data })}.lock`;
    mkdirSync(join(f.data, "sessions"), { recursive: true });
    assert.equal(acquireLock(lock, holder.pid!, { staleMs: 600_000, proofOfDeathOnly: true }), true);
    const t0 = Date.now();
    assert.deepEqual(stop(f, "held"), { exitCode: 0, stdout: "" });
    assert.ok(Date.now() - t0 < 5000);
  } finally {
    holder.kill("SIGKILL");
    f.cleanup();
  }
});

test("the reminder names the global mcp__odd-review__review_status tool, never the plugin-namespaced one", () => {
  const f = fx();
  try {
    on(f);
    const r = runHook("Stop", JSON.stringify({ session_id: "s-name", cwd: f.repo, stop_hook_active: false }), { dataDir: f.data, env: { CLAUDE_PLUGIN_ROOT: "/opt/odd" } });
    const reason = (JSON.parse(r.stdout) as { reason: string }).reason;
    assert.ok(reason.includes("mcp__odd-review__review_status"), reason);
    assert.equal(reason.includes("plugin_odd-claude"), false);
    assert.equal(reason.includes("this plugin's"), false);
  } finally {
    f.cleanup();
  }
});

test("the reminder resolves the root without CLAUDE_PLUGIN_ROOT from the module location", () => {
  const f = fx();
  try {
    on(f);
    const r = runHook("Stop", JSON.stringify({ session_id: "s-mod", cwd: f.repo, stop_hook_active: false }), { dataDir: f.data, env: {} });
    const reason = (JSON.parse(r.stdout) as { reason: string }).reason;
    assert.match(reason, /review-mode\.js disable/);
  } finally {
    f.cleanup();
  }
});

test("the reminder names CLAUDE_PLUGIN_ROOT when the hook environment sets it", () => {
  const f = fx();
  try {
    on(f);
    const r = runHook("Stop", JSON.stringify({ session_id: "s-root", cwd: f.repo, stop_hook_active: false }), { dataDir: f.data, env: { CLAUDE_PLUGIN_ROOT: "/opt/odd root" } });
    const reason = (JSON.parse(r.stdout) as { reason: string }).reason;
    assert.ok(reason.includes("node '/opt/odd root/dist/cli/review-mode.js' disable"), reason);
    assert.equal(reason.includes("<plugin>"), false);
  } finally {
    f.cleanup();
  }
});

test("T6 fast path: with the global switch unset or off a due high-risk candidate stays silent and the Stop hook starts zero git processes", () => {
  const f = fx();
  const prevPath = process.env.PATH;
  try {
    const bin = join(f.dir, "rec-bin");
    mkdirSync(bin);
    const log = join(f.dir, "git-calls.log");
    writeFileSync(log, "");
    const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
    writeFileSync(join(bin, "git"), `#!/bin/sh\necho "$*" >> '${log}'\nexec ${realGit} "$@"\n`, { mode: 0o755 });
    const count = (): number => readFileSync(log, "utf8").split("\n").filter((l) => l !== "").length;
    process.env.PATH = `${bin}:${prevPath ?? ""}`;
    assert.deepEqual(stop(f, "fast-unset"), { exitCode: 0, stdout: "" });
    assert.equal(count(), 0, `unset: ${readFileSync(log, "utf8")}`);
    setReviewMode("disable", "global", f.repo, { dataDir: f.data }); // reads the mode back through git: not under test
    writeFileSync(log, "");
    assert.deepEqual(stop(f, "fast-off"), { exitCode: 0, stdout: "" });
    assert.equal(count(), 0, `off: ${readFileSync(log, "utf8")}`);
    // the shipped entry point too
    const r = spawnSync(process.execPath, [join(PLUGIN_ROOT, "dist", "hooks", "run.js"), "Stop"], { env: { ...ENV, PATH: process.env.PATH, CLAUDE_PLUGIN_DATA: f.data }, input: JSON.stringify({ session_id: "fast-run", cwd: f.repo, stop_hook_active: false }), encoding: "utf8" });
    assert.deepEqual({ status: r.status, stdout: r.stdout }, { status: 0, stdout: "" });
    assert.equal(count(), 0, `run.js: ${readFileSync(log, "utf8")}`);
    // control: global on still uses git and reminds
    on(f);
    const reminded = stop(f, "fast-on");
    assert.equal((JSON.parse(reminded.stdout) as { decision: string }).decision, "block");
    assert.ok(count() > 0);
  } finally {
    process.env.PATH = prevPath;
    f.cleanup();
  }
});
