// User decision (v0.5): the plugin has zero deny/ask/block hooks. Coordinator mode and admission
// rules exist only as prompt text. This pins that no shipped hook code or config can block a tool.
// Amended for v2 (S3, 2026-11-19) and narrowed for upstream v5 (S2): the ONLY exception is the RDD Stop settle
// reminder (src/hooks/stop.ts), and only while RDD is on (default off). The delivery check (a PreToolUse hook on Bash,
// src/hooks/pre-tool-use.ts + src/review/gate.ts) never denies: it shows one advisory notice. The last tests of this
// file pin that scope. Any other hook that emits a deny/decision fails.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runHook } from "../hooks/run.js";
import { setReviewMode } from "../review/mode.js";

// Pattern assembled from parts so a repo-wide grep for the literals only finds real decisions.
const q = String.fromCharCode(34);
const FORBIDDEN = new RegExp([`${q}de${"ny"}${q}`, `${q}as${"k"}${q}`, "permission" + "Decision", `${q}decision${q}\\s*:\\s*${q}blo${"ck"}${q}`].join("|"));

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function files(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) files(p, out);
    else out.push(p);
  }
  return out;
}

test("no source or hook config returns or declares a deny/ask/block decision", () => {
  const targets = [...files(join(root, "src")).filter((f) => f.endsWith(".ts") && !f.endsWith(".spec.ts")), join(root, "hooks", "hooks.json")];
  for (const f of targets) {
    const text = readFileSync(f, "utf8");
    assert.doesNotMatch(text, FORBIDDEN, f);
  }
});

test("hooks.json registers the advisory events plus the delivery notice (PreToolUse on Bash and the write tools only; never PermissionRequest)", () => {
  const cfg = JSON.parse(readFileSync(join(root, "hooks", "hooks.json"), "utf8")) as { hooks: Record<string, { matcher?: string }[]> };
  assert.deepEqual(Object.keys(cfg.hooks).sort(), ["PostToolUse", "PreToolUse", "SessionEnd", "SessionStart", "Stop", "StopFailure", "SubagentStart", "SubagentStop", "UserPromptSubmit"]);
  assert.deepEqual(cfg.hooks.PreToolUse!.map((g) => g.matcher), ["Bash|Edit|Write|NotebookEdit"]);
});

test("PostToolUse outputs are advisory: only hookSpecificOutput.additionalContext, exit 0, never a decision", () => {
  const dir = mkdtempSync(join(tmpdir(), "odd-nodeny-"));
  try {
    const tr = join(dir, "t.jsonl");
    writeFileSync(tr, JSON.stringify({ message: { usage: { input_tokens: 999_999 } } }) + "\n");
    for (let i = 0; i < 6; i++) {
      for (const input of [
        { session_id: "s", tool_name: "Read", tool_response: "x".repeat(50_000), transcript_path: tr },
        { session_id: "s", tool_name: "Grep", tool_response: "x" },
        { session_id: "s", tool_name: "Read", agent_id: "a" },
        { session_id: "s" },
      ]) {
        const r = runHook("PostToolUse", JSON.stringify(input), { dataDir: dir });
        assert.equal(r.exitCode, 0);
        if (r.stdout === "") continue;
        const out = JSON.parse(r.stdout) as Record<string, unknown>;
        assert.deepEqual(Object.keys(out), ["hookSpecificOutput"]);
        assert.deepEqual(Object.keys(out.hookSpecificOutput as object).sort(), ["additionalContext", "hookEventName"]);
        assert.doesNotMatch(r.stdout, FORBIDDEN);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lifecycle hook outputs (SessionStart, UserPromptSubmit, StopFailure, Stop, SessionEnd) never carry a decision, block or continue:false", () => {
  const dir = mkdtempSync(join(tmpdir(), "odd-nodeny-life-"));
  try {
    const forbiddenKeys = ["decision", "continue", "stopReason", "permissionDecision", "reason"];
    for (const event of ["SessionStart", "UserPromptSubmit", "StopFailure", "Stop", "SessionEnd"]) {
      for (const err of ["rate_limit", "billing_error", "invalid_request", "unknown"]) {
        for (const reason of ["clear", "prompt_input_exit", "other"]) {
          const r = runHook(event, JSON.stringify({ session_id: "s", cwd: "/w/p", prompt: "hola", error: err, reason, stop_hook_active: true }), { dataDir: dir });
          assert.equal(r.exitCode, 0, event);
          assert.doesNotMatch(r.stdout, FORBIDDEN, event);
          if (r.stdout === "") continue;
          const out = JSON.parse(r.stdout) as Record<string, unknown>;
          for (const k of forbiddenKeys) assert.equal(Object.hasOwn(out, k), false, `${event}: ${k}`);
          if (event === "Stop" || event === "StopFailure") assert.equal(r.stdout, "", `${event} output must be empty`);
        }
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the delegation rule carries coordinator mode, is listed in SOURCES and claims no enforcement", () => {
  const card = join(root, "rules", "odd-delegation.md");
  assert.ok(existsSync(card));
  const text = readFileSync(card, "utf8");
  assert.match(text, /COORDINATOR in full delegation mode/);
  assert.match(text, /no hook blocks edits/);
  assert.doesNotMatch(text, /harness denies|hook denies|PreToolUse/i);
  assert.match(readFileSync(join(root, "support", "SOURCES.md"), "utf8"), /rules\/odd-delegation\.md .*odd-check: allow/);
});

test("admission rules and the Judgment Day skill state their rules without claiming a hook enforces them", () => {
  for (const f of ["rules/odd-delegation.md", "rules/odd-verification.md", "skills/judgment-day/SKILL.md"]) {
    const text = readFileSync(join(root, f), "utf8");
    assert.match(text, /No hook enforces/, f);
    assert.doesNotMatch(text, /hook for this dispatch is planned|Phase 3 hook/i, f);
  }
});

test("SessionStart carries only the context and the title sequence: no systemMessage, decision, block or continue:false",  () => {
  const dir = mkdtempSync(join(tmpdir(), "odd-nodeny-start-"));
  try {
    const r = runHook("SessionStart", JSON.stringify({ session_id: "s", source: "startup", cwd: "/w/p" }), { dataDir: dir, env: {} });
    assert.equal(r.exitCode, 0);
    const out = JSON.parse(r.stdout) as Record<string, unknown>;
    assert.deepEqual(Object.keys(out).sort(), ["hookSpecificOutput", "terminalSequence"]);
    assert.doesNotMatch(r.stdout, FORBIDDEN);
    for (const k of ["decision", "continue", "stopReason", "permissionDecision", "reason"]) assert.equal(Object.hasOwn(out, k), false, k);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- v2 amendment (S3): the RDD-gated Stop block is the only decision the plugin may emit ----

/** A repo whose workspace holds a high-risk candidate (package.json dependency change): due for review. */
function dueRepo(): { dir: string; repo: string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "odd-nodeny-rdd-")));
  const repo = join(dir, "repo");
  mkdirSync(repo);
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.toUpperCase().startsWith("GIT_")) env[k] = v;
  const git = (...a: string[]): void => {
    const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.invalid", "-c", "commit.gpgsign=false", "-C", repo, ...a], { env });
    assert.equal(r.status, 0, a.join(" "));
  };
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "package.json"), '{"name":"x"}\n');
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  writeFileSync(join(repo, "package.json"), '{"name":"x","dependencies":{"a":"1.0.0"}}\n');
  return { dir, repo };
}

test("only src/hooks/stop.ts constructs a decision; it is a block gated by the RDD mode", () => {
  const owners: string[] = [];
  for (const f of files(join(root, "src")).filter((f) => f.endsWith(".ts") && !/\.(spec|testkit)\.ts$/.test(f))) {
    if (/\bdecision\s*:/.test(readFileSync(f, "utf8"))) owners.push(f.slice(root.length + 1));
  }
  assert.deepEqual(owners, [join("src", "hooks", "stop.ts")]);
  const text = readFileSync(join(root, "src", "hooks", "stop.ts"), "utf8");
  assert.equal(text.match(/\bdecision\s*:/g)?.length, 1);
  assert.match(text, /readReviewMode\([^)]*\)\.effective !== "on"\) return undefined/);
  assert.doesNotMatch(text, /continue\s*:\s*false|stopReason/);
});

test("Stop on a due candidate: empty with RDD off (default, or disabled), exactly one {decision, reason} block with it on; no other event ever blocks", () => {
  const { dir, repo } = dueRepo();
  const data = join(dir, "data");
  try {
    const stop = (session: string) => runHook("Stop", JSON.stringify({ session_id: session, cwd: repo, stop_hook_active: false }), { dataDir: data });
    assert.deepEqual(stop("s1"), { exitCode: 0, stdout: "" });
    setReviewMode("disable", "global", repo, { dataDir: data });
    assert.deepEqual(stop("s1"), { exitCode: 0, stdout: "" });
    setReviewMode("enable", "global", repo, { dataDir: data });
    // every other event stays advisory even with RDD on and a due candidate
    for (const event of ["SessionStart", "UserPromptSubmit", "StopFailure", "SessionEnd", "SubagentStart", "SubagentStop", "PostToolUse"]) {
      const r = runHook(event, JSON.stringify({ session_id: "s1", cwd: repo, prompt: "hola", error: "unknown", reason: "other", tool_name: "Read" }), { dataDir: data });
      assert.equal(r.exitCode, 0, event);
      if (r.stdout === "") continue;
      const out = JSON.parse(r.stdout) as Record<string, unknown>;
      for (const k of ["decision", "continue", "stopReason", "permissionDecision", "reason"]) assert.equal(Object.hasOwn(out, k), false, `${event}: ${k}`);
    }
    // stop_hook_active never forces another continuation
    assert.deepEqual(runHook("Stop", JSON.stringify({ session_id: "s1", cwd: repo, stop_hook_active: true }), { dataDir: data }), { exitCode: 0, stdout: "" });
    const r = stop("s1");
    assert.equal(r.exitCode, 0);
    const out = JSON.parse(r.stdout) as Record<string, unknown>;
    assert.deepEqual(Object.keys(out).sort(), ["decision", "reason"]);
    assert.equal(out.decision, "block");
    assert.deepEqual(stop("s1"), { exitCode: 0, stdout: "" }); // once per session and candidate
    setReviewMode("disable", "global", repo, { dataDir: data });
    assert.deepEqual(stop("s2"), { exitCode: 0, stdout: "" }); // the switch turns it off again
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- upstream v5 (S2): the PreToolUse delivery check never denies; it shows one advisory notice ----

/** A clone with a local bare origin and a feature branch whose committed range (package.json dependency) is high risk. */
function deliveryRepo(): { dir: string; repo: string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "odd-nodeny-gate-")));
  const repo = join(dir, "repo");
  const origin = join(dir, "origin.git");
  mkdirSync(repo);
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.toUpperCase().startsWith("GIT_")) env[k] = v;
  const git = (cwd: string, ...a: string[]): void => {
    const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.invalid", "-c", "commit.gpgsign=false", "-C", cwd, ...a], { env });
    assert.equal(r.status, 0, a.join(" "));
  };
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "package.json"), '{"name":"x"}\n');
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  git(dir, "init", "-q", "--bare", "-b", "main", origin);
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "-q", "-u", "origin", "main");
  git(repo, "remote", "set-head", "origin", "main");
  git(repo, "checkout", "-q", "-b", "feature");
  writeFileSync(join(repo, "package.json"), '{"name":"x","dependencies":{"a":"1.0.0"}}\n');
  git(repo, "commit", "-q", "-am", "deps");
  return { dir, repo };
}

test("no source constructs a permission decision: the delivery check cannot deny", () => {
  const owners: string[] = [];
  for (const f of files(join(root, "src")).filter((f) => f.endsWith(".ts") && !/\.(spec|testkit)\.ts$/.test(f))) {
    if (/permission[A-Z]\w*\s*:/.test(readFileSync(f, "utf8"))) owners.push(f.slice(root.length + 1));
  }
  assert.deepEqual(owners, []);
  const text = readFileSync(join(root, "src", "hooks", "pre-tool-use.ts"), "utf8");
  assert.match(text, /input\.tool_name !== "Bash"\) return undefined/);
  assert.match(text, /additionalContext: notice/);
  assert.doesNotMatch(text, /continue\s*:\s*false|stopReason|\bdecision\s*:/);
  const gate = readFileSync(join(root, "src", "review", "gate.ts"), "utf8");
  assert.match(gate, /readReviewMode\([^)]*\)\.effective !== "on"\) return undefined/);
  assert.doesNotMatch(gate, /permission[A-Z]|"decision"/);
  // every other event goes through the shared dispatcher with its own name
  const cfg = JSON.parse(readFileSync(join(root, "hooks", "hooks.json"), "utf8")) as { hooks: Record<string, { hooks: { command: string }[] }[]> };
  for (const [event, groups] of Object.entries(cfg.hooks)) for (const g of groups) for (const h of g.hooks) assert.match(h.command, new RegExp(`run\\.js" ${event}$`));
});

test("PreToolUse: silent with RDD off (default or disabled); with RDD on a delivery never gets a permission decision, only one additionalContext notice when unreviewed", () => {
  const { dir, repo } = deliveryRepo();
  const data = join(dir, "data");
  try {
    const pre = (command: string, tool = "Bash") => runHook("PreToolUse", JSON.stringify({ session_id: "s1", cwd: repo, tool_name: tool, tool_input: { command } }), { dataDir: data });
    const silent = { exitCode: 0, stdout: "" };
    for (const c of ["git push", "gh pr create --fill", "git commit -m x && git push", "ls"]) assert.deepEqual(pre(c), silent, c);
    setReviewMode("disable", "global", repo, { dataDir: data });
    assert.deepEqual(pre("git push"), silent);
    setReviewMode("enable", "global", repo, { dataDir: data });
    // RDD on: non-delivery commands, other tools and look-alikes stay silent
    for (const c of ["ls", "git status", "echo hi", "git pushx", "gh pr view 1", "git branch -D old", "git commit -m x && git push"]) assert.deepEqual(pre(c), silent, c);
    assert.deepEqual(pre("git push", "Read"), silent);
    // the other events stay advisory even with RDD on and a due range (Stop is covered above)
    for (const event of ["SessionStart", "UserPromptSubmit", "StopFailure", "SessionEnd", "SubagentStart", "SubagentStop", "PostToolUse"]) {
      const r = runHook(event, JSON.stringify({ session_id: "s1", cwd: repo, prompt: "hola", error: "unknown", reason: "other", tool_name: "Bash", tool_input: { command: "git push" } }), { dataDir: data });
      assert.equal(r.exitCode, 0, event);
      assert.doesNotMatch(r.stdout, /permissionDecision/, event);
      if (r.stdout === "") continue;
      const out = JSON.parse(r.stdout) as Record<string, unknown>;
      for (const k of ["decision", "continue", "stopReason", "permissionDecision", "reason"]) assert.equal(Object.hasOwn(out, k), false, `${event}: ${k}`);
    }
    for (const c of ["git push origin feature", "gh pr create --fill", "gh pr merge 1"]) {
      const r = pre(c);
      assert.equal(r.exitCode, 0, c);
      const out = JSON.parse(r.stdout) as { hookSpecificOutput: Record<string, unknown> };
      assert.deepEqual(Object.keys(out), ["hookSpecificOutput"], c);
      assert.deepEqual(Object.keys(out.hookSpecificOutput).sort(), ["additionalContext", "hookEventName"], c);
      assert.equal(out.hookSpecificOutput.hookEventName, "PreToolUse");
      assert.equal(typeof out.hookSpecificOutput.additionalContext, "string");
      assert.doesNotMatch(r.stdout, /permission|"continue"|stopReason|"decision"/i, c);
    }
    setReviewMode("disable", "global", repo, { dataDir: data });
    assert.deepEqual(pre("git push origin feature"), silent); // the switch turns it off again
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
