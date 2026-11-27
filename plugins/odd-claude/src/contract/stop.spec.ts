// Black-box tests of the Stop hook through the hook runner entry, moved from hooks/stop.spec.ts (the in-process tests stay there).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLEAN_ENV, git, setReviewMode } from "./harness.testkit.js";
import { entry, run } from "./impl.testkit.js";

interface Fx {
  dir: string;
  data: string;
  repo: string;
  cleanup: () => void;
}

/** A repo with one commit and a high-risk workspace change (package.json). */
function fx(): Fx {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "odd-stop-")));
  const repo = join(dir, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "package.json"), '{"name":"x"}\n');
  writeFileSync(join(repo, "README.md"), "# t\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  writeFileSync(join(repo, "package.json"), '{"name":"x","dependencies":{"left-pad":"1.0.0"}}\n');
  return { dir, data: join(dir, "data"), repo, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const on = (f: Fx): void => setReviewMode("enable", f);

test("10 concurrent Stop processes for one session and candidate: exactly one block, every exit 0", async () => {
  const f = fx();
  try {
    on(f);
    const e = entry("hook-runner");
    const one = (): Promise<{ code: number | null; out: string }> =>
      new Promise((resolve) => {
        const c = spawn(e.command, [...e.args, "Stop"], { env: { ...CLEAN_ENV, CLAUDE_PLUGIN_DATA: f.data }, stdio: ["pipe", "pipe", "ignore"] });
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
    // the shipped entry point, a fresh process per call
    const stop = (session: string): { status: number | null; stdout: string } => {
      const r = run("hook-runner", ["Stop"], { env: { ...CLEAN_ENV, PATH: process.env.PATH, CLAUDE_PLUGIN_DATA: f.data }, input: JSON.stringify({ session_id: session, cwd: f.repo, stop_hook_active: false }) });
      return { status: r.status, stdout: r.stdout };
    };
    assert.deepEqual(stop("fast-unset"), { status: 0, stdout: "" });
    assert.equal(count(), 0, `unset: ${readFileSync(log, "utf8")}`);
    setReviewMode("disable", f); // reads the mode back through git: not under test
    writeFileSync(log, "");
    assert.deepEqual(stop("fast-off"), { status: 0, stdout: "" });
    assert.equal(count(), 0, `off: ${readFileSync(log, "utf8")}`);
    // control: global on still uses git and reminds
    on(f);
    const reminded = stop("fast-on");
    assert.equal((JSON.parse(reminded.stdout) as { decision: string }).decision, "block");
    assert.ok(count() > 0);
  } finally {
    process.env.PATH = prevPath;
    f.cleanup();
  }
});
