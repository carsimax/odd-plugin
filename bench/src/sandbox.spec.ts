import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createSandbox } from "./sandbox.js";
import { runProcess } from "./process.js";

test("sandbox has its own HOME, a git repo with one commit and cleans up", async () => {
  const sb = await createSandbox();
  try {
    assert.ok(existsSync(sb.home) && existsSync(sb.repo));
    assert.notEqual(sb.home, process.env.HOME);
    assert.match(sb.git(["log", "--oneline"]).trim(), /bench: initial/);
    assert.equal(sb.env.HOME, sb.home);
  } finally {
    sb.cleanup();
  }
  assert.equal(existsSync(sb.root), false);
});

test("optional bare origin is wired as the repo's origin", async () => {
  const sb = await createSandbox({ origin: true });
  try {
    assert.ok(sb.origin && existsSync(sb.origin));
    assert.equal(sb.git(["remote", "get-url", "origin"]).trim(), sb.origin);
  } finally {
    sb.cleanup();
  }
});

test("git shim counts every forwarded invocation and keeps real git behaviour", async () => {
  const sb = await createSandbox();
  try {
    assert.equal(sb.countGit(), 0, "setup git calls are not counted");
    const a = await runProcess("git", ["rev-parse", "--is-inside-work-tree"], { cwd: sb.repo, env: sb.env, deadlineMs: 10_000 });
    const b = await runProcess("git", ["status", "--short"], { cwd: sb.repo, env: sb.env, deadlineMs: 10_000 });
    assert.equal(a.stdout.trim(), "true");
    assert.equal(a.code, 0);
    assert.equal(b.code, 0);
    assert.equal(sb.countGit(), 2);
    const bad = await runProcess("git", ["no-such-subcommand"], { cwd: sb.repo, env: sb.env, deadlineMs: 10_000 });
    assert.notEqual(bad.code, 0, "exit code is forwarded");
    assert.equal(sb.countGit(), 3, "failed invocations count too");
  } finally {
    sb.cleanup();
  }
});

test("fake claude shim counts model runs, prints canned output and never runs a model", async () => {
  const sb = await createSandbox();
  try {
    const r = await runProcess("claude", ["-p", "hi"], { cwd: sb.repo, env: sb.env, deadlineMs: 10_000 });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /odd-bench fake claude/);
    assert.equal(sb.countModelRuns(), 1);
  } finally {
    sb.cleanup();
  }
});

test("runProcess enforces the deadline", async () => {
  const r = await runProcess(process.execPath, ["-e", "setTimeout(()=>{},60000)"], { deadlineMs: 300 });
  assert.equal(r.timedOut, true);
});

test("sandbox env is built from scratch: every config, data and cache location is inside the sandbox and no parent credential leaks", async () => {
  const leaked = { ANTHROPIC_API_KEY: "dummy-not-a-secret", CLAUDE_CODE_OAUTH_TOKEN: "dummy", AWS_PROFILE: "dummy", CLAUDE_PLUGIN_DATA: "/nonexistent/real-data", XDG_CONFIG_HOME: "/nonexistent/xdg" };
  const saved = Object.fromEntries(Object.keys(leaked).map((k) => [k, process.env[k]]));
  Object.assign(process.env, leaked);
  const sb = await createSandbox();
  try {
    for (const k of ["HOME", "CLAUDE_PLUGIN_DATA", "CLAUDE_CONFIG_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "GIT_CONFIG_GLOBAL"]) {
      const v = sb.env[k];
      assert.ok(typeof v === "string" && v.startsWith(`${sb.root}/`), `${k}=${String(v)} is inside the sandbox`);
    }
    assert.equal(sb.dataDir, sb.env.CLAUDE_PLUGIN_DATA);
    for (const d of ["CLAUDE_PLUGIN_DATA", "CLAUDE_CONFIG_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"]) assert.ok(existsSync(sb.env[d]!), `${d} exists`);
    assert.deepEqual(Object.keys(sb.env).filter((k) => /^(ANTHROPIC_|AWS_|CLAUDE_CODE)/.test(k)), []);
    const child = await runProcess(process.execPath, ["-e", "process.stdout.write(JSON.stringify(process.env))"], { cwd: sb.repo, env: sb.env, deadlineMs: 10_000 });
    const seen = JSON.parse(child.stdout) as Record<string, string>;
    assert.equal(seen.ANTHROPIC_API_KEY, undefined);
    assert.equal(seen.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    assert.equal(seen.AWS_PROFILE, undefined);
    assert.equal(seen.CLAUDE_PLUGIN_DATA, sb.dataDir, "the parent's real plugin data dir is replaced, not inherited");
    assert.ok(seen.PATH!.startsWith(`${sb.root}/bin:`), "the fake claude and the git shim come first on PATH");
  } finally {
    sb.cleanup();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

const reviewerPrompt = (role: string, lens: string | undefined, binding: Record<string, string>): string =>
  [
    `ODD reviewer task. Role: ${role}${lens !== undefined ? `, lens: ${lens}` : ""}.`,
    `Echo these fields verbatim in the result: ${JSON.stringify(binding)}`,
    "<<<ODD-DATA-abc changed-path-manifest>>>\nsrc/a.ts\nsrc/b.ts\n<<<END-ODD-DATA-abc changed-path-manifest>>>",
    '<<<ODD-DATA-abc findings>>>\n[{"id":"F-1"}]\n<<<END-ODD-DATA-abc findings>>>',
  ].join("\n\n") + "\n";

async function ask(sb: Awaited<ReturnType<typeof createSandbox>>, prompt: string): Promise<Record<string, any>> {
  const r = await runProcess("claude", ["--print"], { cwd: sb.repo, env: sb.env, stdin: prompt, deadlineMs: 10_000 });
  assert.equal(r.code, 0);
  const m = /```json\n(.*)\n```/s.exec(r.stdout);
  assert.ok(m, r.stdout);
  return JSON.parse(m[1]!) as Record<string, any>;
}

test("fake reviewer synthesizes a schema-shaped verdict from the prompt's own echo line and the sandbox verdict plan, and counts each run", async () => {
  const sb = await createSandbox();
  try {
    const binding = { subject_hash: "sha256:" + "a".repeat(64), lens: "risk" };
    const clean = await ask(sb, reviewerPrompt("lens", "risk", binding));
    assert.equal(clean.subject_hash, binding.subject_hash, "the binding is echoed verbatim");
    assert.deepEqual(clean.findings, []);
    assert.deepEqual(clean.inspection, { status: "completed", paths: ["src/a.ts", "src/b.ts"] });
    const finding = { location: "src/a.ts:1", severity: "CRITICAL" };
    sb.setVerdicts({ findings: { risk: [finding] } });
    assert.deepEqual((await ask(sb, reviewerPrompt("lens", "risk", binding))).findings, [finding]);
    assert.deepEqual((await ask(sb, reviewerPrompt("lens", "resilience", binding))).findings, [], "a lens that is not in the plan reports none");
    const refuted = await ask(sb, reviewerPrompt("refuter", undefined, { refuter_request_hash: "sha256:" + "b".repeat(64) }));
    assert.deepEqual(refuted.results.map((x: any) => [x.finding_id, x.outcome]), [["F-1", "corroborated"]]);
    const ok = await ask(sb, reviewerPrompt("validator", undefined, { targeted_validation_request_hash: "sha256:" + "c".repeat(64) }));
    assert.equal(ok.original_criteria.passed, true);
    sb.setVerdicts({ validatorPasses: false });
    assert.equal((await ask(sb, reviewerPrompt("validator", undefined, { targeted_validation_request_hash: "sha256:" + "c".repeat(64) }))).original_criteria.passed, false);
    assert.equal(sb.countModelRuns(), 6);
  } finally {
    sb.cleanup();
  }
});
