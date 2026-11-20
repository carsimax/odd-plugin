import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runHook } from "../hooks/run.js";
import { acknowledgeApproved, isTargetConsumed } from "./ack.js";
import { recordDecline, REVIEW_TOOL_NAMES } from "./consent.js";
import { checkDelivery, DEFAULT_BUDGET_MS, recognizeDeliveryActions } from "./gate.js";
import { readReviewMode, setReviewMode } from "./mode.js";
import { runReview, type ReviewRunInput, type ReviewRunOutcome, type RunDeps } from "./run.js";
import { startReview, type RiskAssessment, type RiskAssessor } from "./start.js";
import { resolveRepository, runGit, SnapshotError } from "./snapshot.js";
import { assessCandidate } from "./risk.js";
import { listLineages, readState, storeRootFor } from "./store.js";

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

// ---------------------------------------------------------------------------------------------
// 1. detection table (no repository involved)
// ---------------------------------------------------------------------------------------------

const deliveries = (command: string) => recognizeDeliveryActions(command).filter((a) => a.kind === "delivery");

const POSITIVE: string[] = [
  "git push",
  "git push origin main",
  "git push -u origin feature",
  "git push --force-with-lease origin main",
  "git push --force origin HEAD:refs/heads/x",
  "git -C /tmp/x push",
  "git -C/tmp/x push origin main",
  "git -c user.name=x push",
  "git --no-pager push",
  "/usr/bin/git push",
  "FOO=1 git push",
  "FOO=1 BAR='a b' git push origin main",
  "env FOO=1 git push",
  "env -i PATH=/usr/bin git push",
  "sudo git push",
  "command git push",
  "exec git push",
  "nohup git push",
  "time git push",
  "timeout 30 git push",
  "xargs git push",
  "git add . && git push",
  "git add .; git push",
  "git add . ;git push",
  "true || git push",
  "echo hi | git push",
  "(git push)",
  "( cd sub && git push )",
  "{ git push; }",
  "if true; then git push; fi",
  "for r in a b; do git push $r; done",
  "while false; do :; done; git push",
  "! git push",
  "bash -c 'git push'",
  'sh -lc "git push origin main"',
  "zsh -c 'cd x && git push'",
  'eval "git push"',
  "eval git push",
  "echo $(git push)",
  'echo "$(git push)"',
  "echo `git push`",
  "git push &",
  "echo a\ngit push",
  "echo a\r\ngit push",
  "git push 2>&1",
  "git push >out.log",
  "git push > out.log 2>&1 && echo done",
  "git push --no-verify -o ci.skip origin main",
  "git push \\\n  origin main",
  "cat <<EOF\nfoo\nEOF\ngit push",
  "cat <<EOF\n$(git push)\nEOF",
  "bash -c \"bash -c 'git push'\"",
  "gh pr create",
  "gh pr create --title x --body 'y'",
  'gh pr create --title "git push" --fill',
  "gh pr merge 12 --squash",
  "gh pr merge --auto",
  "gh -R o/r pr create",
  "gh --repo o/r pr merge 3",
  "GH_TOKEN=x gh pr merge",
  "git commit -m x && git push",
  "git diff | cat; gh pr create",
];

const NEGATIVE: string[] = [
  "",
  "   ",
  "git pushx",
  "git push-all",
  "git-push",
  "mygit push",
  "gitpush",
  "git push --dry-run",
  "git push -n origin main",
  "git push --dry-run origin main",
  "git push --delete origin b",
  "git push -d origin b",
  "git push origin :b -d",
  'echo "git push"',
  "echo 'gh pr create'",
  "echo git push",
  "printf 'git push\\n'",
  'grep -r "git push" .',
  "grep push file",
  'git commit -m "git push now"',
  "git commit -m 'gh pr create'",
  "git status",
  "git log --grep=push",
  "git remote add push url",
  "git remote show origin",
  "git branch push",
  "git checkout push",
  "gh pr view 1",
  "gh pr list",
  "gh pr checks",
  "gh pr status",
  "gh pr diff 3",
  "gh pr comment 3 --body x",
  "gh pr ready",
  "gh issue create",
  "gh run list",
  "gh api repos/o/r/pulls",
  "cd push",
  "ls push",
  "# git push",
  "echo hi # git push",
  "echo hi # gh pr create",
  "cat <<'EOF'\ngit push\nEOF",
  'cat <<"EOF"\n$(git push)\nEOF',
  "cat <<EOF\ngit push\nEOF",
  "cat <<-EOF\n\tgit push\n\tEOF",
  'git commit -m "$(cat <<\'EOF\'\ngit push\nEOF\n)"',
  '"git push"',
  "'gh pr create'",
  "npm run push",
  "bash script.sh",
  "bash -c 'echo git push'",
  "sh -c 'git status'",
  "echo 'a'; echo \"b\" && ls",
  "git push_helper",
  "man git-push",
];

test("detection table: every positive is a delivery, every negative is not", () => {
  for (const c of POSITIVE) assert.ok(deliveries(c).length >= 1, `should detect: ${JSON.stringify(c)}`);
  for (const c of NEGATIVE) assert.equal(deliveries(c).length, 0, `should not detect: ${JSON.stringify(c)}`);
});

test("detection reports directories, unresolved routing and candidate-changing commands", () => {
  const one = (c: string) => {
    const d = deliveries(c);
    assert.equal(d.length, 1, c);
    return d[0]!;
  };
  assert.deepEqual(one("git push").directories, []);
  assert.deepEqual(one("git -C sub push").directories, ["sub"]);
  assert.deepEqual(one("git -Csub push").directories, ["sub"]);
  assert.deepEqual(one("cd a && git push").directories, ["a"]);
  assert.deepEqual(one("cd a && cd b && git push origin main").directories, ["a", "b"]);
  assert.deepEqual(one("cd a && git -C b push").directories, ["a", "b"]);
  assert.deepEqual(one("bash -c 'git -C z push'").directories, ["z"]);
  assert.equal(one("git push").unresolved, false);
  assert.equal(one("cd a && git push").unresolved, false);
  for (const c of [
    "cd $X && git push",
    'cd "$(pwd)" && git push',
    "cd ~ && git push",
    "cd a; git push",
    "pushd a && git push",
    "true || cd a && git push",
    "git -C \"$d\" push",
    "git -C $(pwd) push",
    "git --git-dir=x push",
    "git --git-dir x push",
    "git --work-tree=x push",
    "GIT_DIR=x git push",
    "GIT_WORK_TREE=x git push",
    "env -C d git push",
    "sudo -D d git push",
    "export GIT_DIR=x; git push",
    "cd a && (cd b && git push)",
  ]) assert.equal(one(c).unresolved, true, c);
  // a change command is reported next to the delivery
  const kinds = recognizeDeliveryActions("git commit -m x && git push").map((a) => a.kind).sort();
  assert.deepEqual(kinds, ["change", "delivery"]);
  for (const c of ["git merge x", "git rebase main", "git reset --hard HEAD~1", "git cherry-pick a", "git pull", "git checkout -b x", "git switch x", "git revert a", "git am p.patch", "git update-ref refs/x y"]) {
    assert.deepEqual(recognizeDeliveryActions(c).map((a) => a.kind), ["change"], c);
  }
  assert.deepEqual(recognizeDeliveryActions("git status && git log"), []);
});

test("detection is total: hostile and malformed text never throws", () => {
  const hostile = ["$(", "`", "'", '"', "((((", "))))", "<<EOF", "<<", ">", "&&&&", "\\", "$((1+", "echo `git push", "bash -c", "eval", "git -C", "git", "gh", "gh pr", "x".repeat(200_000), "(".repeat(5000) + "git push" + ")".repeat(5000)];
  for (const c of hostile) assert.doesNotThrow(() => recognizeDeliveryActions(c), c.slice(0, 40));
  // unterminated constructs still find a literal delivery
  assert.ok(deliveries("echo `git push").length >= 1);
  assert.ok(deliveries("echo $(git push").length >= 1);
  // nesting past the bound is treated as a delivery when the text names one (stricter than the reference, which drops it)
  let deep = "git push";
  for (let i = 0; i < 12; i++) deep = `bash -c ${JSON.stringify(deep)}`;
  assert.ok(deliveries(deep).length >= 1);
  let deepQuiet = "git status";
  for (let i = 0; i < 12; i++) deepQuiet = `bash -c ${JSON.stringify(deepQuiet)}`;
  assert.equal(deliveries(deepQuiet).length, 0);
});

// ---------------------------------------------------------------------------------------------
// fixtures: a local bare origin, a clone with a feature branch
// ---------------------------------------------------------------------------------------------

interface Fx {
  dir: string;
  data: string;
  origin: string;
  repo: string;
  commonDir: string;
  cleanup: () => void;
}

function fx(opts: { remote?: boolean } = {}): Fx {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "odd-gate-")));
  const origin = join(dir, "origin.git");
  const repo = join(dir, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "package.json"), '{"name":"x"}\n');
  writeFileSync(join(repo, "README.md"), "# t\n");
  writeFileSync(join(repo, "a.txt"), "one\ntwo\nthree\n");
  writeFileSync(join(repo, "b.txt"), "bee\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  if (opts.remote !== false) {
    git(dir, "init", "-q", "--bare", "-b", "main", origin);
    git(repo, "remote", "add", "origin", origin);
    git(repo, "push", "-q", "-u", "origin", "main");
    git(repo, "remote", "set-head", "origin", "main");
  }
  git(repo, "checkout", "-q", "-b", "feature");
  return { dir, data: join(dir, "data"), origin, repo, commonDir: realpathSync(join(repo, ".git")), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const commitHigh = (f: Fx, v = "1.0.0"): void => {
  writeFileSync(join(f.repo, "package.json"), `{"name":"x","dependencies":{"left-pad":"${v}"}}\n`);
  git(f.repo, "commit", "-q", "-am", `deps ${v}`);
};
const commitLow = (f: Fx): void => {
  writeFileSync(join(f.repo, "README.md"), "# t\n\nmore docs\n");
  git(f.repo, "commit", "-q", "-am", "docs");
};
const commitMedium = (f: Fx): void => {
  git(f.repo, "rm", "-q", "b.txt");
  git(f.repo, "commit", "-q", "-m", "drop b");
};

const on = (f: Fx): void => void setReviewMode("enable", "global", f.repo, { dataDir: f.data });

const rangeTarget = { kind: "base-diff" as const, baseRef: "origin/main", committedOnly: true };

function hook(f: Fx, command: string, extra: Record<string, unknown> = {}, env?: Record<string, string>): { exitCode: number; stdout: string } {
  return runHook("PreToolUse", JSON.stringify({ session_id: "s1", cwd: f.repo, tool_name: "Bash", tool_input: { command }, ...extra }), { dataDir: f.data, ...(env ? { env } : {}) });
}
const SILENT = { exitCode: 0, stdout: "" };

interface Denial {
  hookSpecificOutput: { hookEventName: string; permissionDecision: string; permissionDecisionReason: string };
}
function denial(r: { exitCode: number; stdout: string }): Denial["hookSpecificOutput"] {
  assert.equal(r.exitCode, 0);
  assert.notEqual(r.stdout, "", "expected a denial");
  const out = JSON.parse(r.stdout) as Denial;
  assert.deepEqual(Object.keys(out), ["hookSpecificOutput"]);
  assert.deepEqual(Object.keys(out.hookSpecificOutput).sort(), ["hookEventName", "permissionDecision", "permissionDecisionReason"]);
  assert.equal(out.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
  return out.hookSpecificOutput;
}

const lowAssessor: RiskAssessor = () => ({ level: "low", reasons: [{ code: "non_executable_only" }], evidence: [] });
const assess = (level: RiskAssessment["level"]): RiskAssessor => () => ({
  level,
  reasons: [{ code: level === "low" ? "non_executable_only" : "shell_source", ...(level === "low" ? {} : { signal: "shell_process", path: "a.txt" }) }],
  evidence: level === "low" ? [] : ["shell scripting in a.txt"],
});

function storeSnapshot(f: Fx): string {
  const p = join(f.commonDir, "odd-plugin");
  return JSON.stringify([existsSync(p) ? readdirSync(p).sort() : null, git(f.repo, "rev-parse", "HEAD", "refs/heads/feature", "refs/remotes/origin/main").trim(), git(f.repo, "status", "--porcelain")]);
}

// ---------------------------------------------------------------------------------------------
// 2. the gate
// ---------------------------------------------------------------------------------------------

test("RDD off (the default, or disabled): a high-risk unreviewed range is never blocked", () => {
  const f = fx();
  try {
    commitHigh(f);
    for (const c of ["git push", "git push origin feature", "gh pr create --fill", "git -C . push", "cd . && git push"]) assert.deepEqual(hook(f, c), SILENT, c);
    setReviewMode("disable", "global", f.repo, { dataDir: f.data });
    assert.deepEqual(hook(f, "git push"), SILENT);
    // a clone-local disable wins over a global enable
    on(f);
    setReviewMode("disable", "clone", f.repo, { dataDir: f.data });
    assert.deepEqual(hook(f, "git push"), SILENT);
    assert.deepEqual(hook(f, "git commit -m x && git push"), SILENT, "RDD off: even a mixed chain is allowed");
    setReviewMode("enable", "clone", f.repo, { dataDir: f.data });
    denial(hook(f, "git push"));
  } finally {
    f.cleanup();
  }
});

test("RDD on, high-risk committed range, no review: deny with the exact PreToolUse shape and a routed reason", () => {
  const f = fx();
  try {
    on(f);
    commitHigh(f);
    const identity = assessCandidate(f.repo, { kind: "base-diff", baseRef: "origin/main" });
    assert.equal(identity.status, "assessed");
    if (identity.status !== "assessed") throw new Error("unreachable");
    assert.equal(identity.risk, "high");
    const base = git(f.repo, "rev-parse", "origin/main").trim();

    const r = hook(f, "git push origin feature");
    const d = denial(r);
    const reason = d.permissionDecisionReason;
    assert.ok(reason.startsWith("RDD pre-delivery:"), reason);
    assert.ok(reason.includes(identity.targetIdentity), "names the candidate identity");
    assert.ok(reason.includes(base), "names the base of the range");
    assert.match(reason, /high risk/);
    assert.match(reason, /committed range/);
    assert.match(reason, /This delivery command was not run/);
    assert.match(reason, /not been reviewed|no approved review/i);
    assert.match(reason, /review tools/);
    assert.equal(/provisional/i.test(reason), false, "no placeholder wording");
    assert.match(reason, /review_status/);
    assert.match(reason, /review_start/);
    for (const t of reason.match(/\breview_[a-z_]+\b/g) ?? []) assert.ok((REVIEW_TOOL_NAMES as readonly string[]).includes(t), `${t} is a registered review tool`);
    assert.match(reason, /never answers/i);
    assert.match(reason, /review-mode\.js disable/);
    assert.equal(reason.includes("<plugin>"), false);
    assert.ok(reason.includes(`node ${join(PLUGIN_ROOT, "dist", "cli", "review-mode.js")} disable`), "real plugin root from the module");
    assert.match(reason, /--scope clone --cwd/);
    const named = [...reason.matchAll(/dist\/cli\/([\w-]+\.js)/g)].map((m) => m[1]!);
    assert.ok(named.length > 0);
    for (const n of named) assert.ok(existsSync(join(PLUGIN_ROOT, "dist", "cli", n)), `${n} exists`);

    // every delivery form is gated
    for (const c of [
      "git push",
      "git push -u origin feature",
      "gh pr create --fill",
      "gh pr merge 3 --squash",
      "git add -A && git push",
      "FOO=1 git push; echo done",
      "(git push)",
      "bash -c 'git push'",
      "git -C . push",
      `git -C ${f.repo} push`,
      `cd ${f.repo} && git push`,
    ]) denial(hook(f, c));
    // from another directory, -C / cd reach the repository
    denial(hook(f, `git -C ${f.repo} push`, { cwd: f.dir }));
    denial(hook(f, `cd ${f.repo} && git push`, { cwd: f.dir }));
    // a subagent's call is gated the same way
    denial(hook(f, "git push", { agent_id: "a1", agent_type: "odd-claude:odd-worker" }));
    // non-delivery commands, other tools and a non-repository cwd stay silent
    for (const c of ["git status", "git log --oneline", "echo git push", "git push --dry-run", "git push -d origin x", "gh pr view 1", "git pushx"]) assert.deepEqual(hook(f, c), SILENT, c);
    assert.deepEqual(hook(f, "git push", { tool_name: "Read" }), SILENT);
    assert.deepEqual(hook(f, "git push", { tool_name: "Edit", tool_input: { command: "git push" } }), SILENT);
    assert.deepEqual(hook(f, "git push", { tool_input: {} }), SILENT);
    assert.deepEqual(hook(f, "git push", { tool_input: { command: 7 } }), SILENT);
    assert.deepEqual(hook(f, "git push", { cwd: undefined }), SILENT);
    assert.deepEqual(hook(f, "git push", { cwd: join(f.dir, "nowhere") }), SILENT);
    assert.deepEqual(runHook("PreToolUse", "not json", { dataDir: f.data }), SILENT);
    assert.deepEqual(runHook("PreToolUse", "", { dataDir: f.data }), SILENT);
  } finally {
    f.cleanup();
  }
});

test("allow: low and medium risk ranges, an empty range, and a dirty workspace over a clean range", () => {
  const f = fx();
  try {
    on(f);
    // empty range: HEAD is the upstream, even with a high-risk change in the workspace (committed-only)
    writeFileSync(join(f.repo, "package.json"), '{"name":"x","dependencies":{"w":"1"}}\n');
    assert.deepEqual(hook(f, "git push"), SILENT);
    git(f.repo, "checkout", "-q", "package.json");
    commitLow(f);
    const low = assessCandidate(f.repo, { kind: "base-diff", baseRef: "origin/main" });
    assert.equal(low.status === "assessed" && low.risk, "low");
    assert.deepEqual(hook(f, "git push"), SILENT);
    assert.deepEqual(hook(f, "gh pr create --fill"), SILENT);
    commitMedium(f);
    const med = assessCandidate(f.repo, { kind: "base-diff", baseRef: "origin/main" });
    assert.equal(med.status === "assessed" && med.risk, "medium");
    assert.deepEqual(hook(f, "git push"), SILENT);
    // a commit and its revert leave an identical tree: nothing to review
    commitHigh(f);
    denial(hook(f, "git push"));
    git(f.repo, "revert", "--no-edit", "HEAD");
    git(f.repo, "reset", "-q", "--hard", "HEAD");
    const net = assessCandidate(f.repo, { kind: "base-diff", baseRef: "origin/main" });
    assert.equal(net.status === "assessed" && net.risk !== "high", true);
    assert.deepEqual(hook(f, "git push"), SILENT);
    // an untracked file (a PR body) never changes a committed-only range
    commitHigh(f, "2.0.0");
    writeFileSync(join(f.repo, "pr-body.md"), "body\n");
    denial(hook(f, "gh pr create --body-file pr-body.md"));
    git(f.repo, "reset", "-q", "--hard", "origin/main");
    writeFileSync(join(f.repo, "pr-body.md"), "body\n");
    assert.deepEqual(hook(f, "gh pr create --body-file pr-body.md"), SILENT);
  } finally {
    f.cleanup();
  }
});

test("allow: HEAD already contained in the push target (an ancestor of origin) is an empty range", () => {
  const f = fx();
  try {
    on(f);
    commitHigh(f);
    git(f.repo, "push", "-q", "origin", "feature");
    git(f.repo, "branch", "-q", "--set-upstream-to=origin/feature");
    assert.deepEqual(hook(f, "git push"), SILENT);
    commitHigh(f, "3.0.0");
    denial(hook(f, "git push"));
  } finally {
    f.cleanup();
  }
});

test("a consumed candidate (valid receipt) is allowed; a new commit is a new candidate and is denied again", async () => {
  const f = fx();
  try {
    on(f);
    commitHigh(f);
    const started = await startReview({ cwd: f.repo, target: rangeTarget, consent: "granted", riskAssessor: lowAssessor });
    assert.equal(started.status, "started");
    if (started.status !== "started") throw new Error("unreachable");
    // a started but unacknowledged review is not consumed
    denial(hook(f, "git push"));
    const ack = started.result.acknowledgement!;
    await acknowledgeApproved(f.commonDir, { lineage: ack.lineage_id, target: ack.target_identity, expectedRevision: ack.expected_revision, token: ack.token });
    assert.equal(isTargetConsumed(f.commonDir, ack.target_identity).status, "consumed");
    assert.deepEqual(hook(f, "git push"), SILENT);
    assert.deepEqual(hook(f, "gh pr create --fill"), SILENT);
    commitHigh(f, "9.9.9");
    denial(hook(f, "git push"));
  } finally {
    f.cleanup();
  }
});

test("a burned lineage whose receipt is missing is NOT consumed: deny and say the authority is unreadable", async () => {
  const f = fx();
  try {
    on(f);
    commitHigh(f);
    const started = await startReview({ cwd: f.repo, target: rangeTarget, consent: "granted", riskAssessor: lowAssessor });
    if (started.status !== "started") throw new Error("unreachable");
    const ack = started.result.acknowledgement!;
    await acknowledgeApproved(f.commonDir, { lineage: ack.lineage_id, target: ack.target_identity, expectedRevision: ack.expected_revision, token: ack.token });
    assert.deepEqual(hook(f, "git push"), SILENT);
    rmSync(join(storeRootFor(f.commonDir), ack.lineage_id, "review-receipt.json"));
    const d = denial(hook(f, "git push"));
    assert.match(d.permissionDecisionReason, /could not be verified|unknown|unreadable/i);
  } finally {
    f.cleanup();
  }
});

test("a declined candidate is allowed (explicit decline of that exact candidate); the next commit is not", () => {
  const f = fx();
  try {
    on(f);
    commitHigh(f);
    const a = assessCandidate(f.repo, { kind: "base-diff", baseRef: "origin/main" });
    if (a.status !== "assessed") throw new Error("unreachable");
    denial(hook(f, "git push"));
    recordDecline(f.commonDir, { target_identity: a.targetIdentity, projection: "workspace", risk_level: "high", declined_at: new Date().toISOString() });
    assert.deepEqual(hook(f, "git push"), SILENT);
    assert.deepEqual(hook(f, "gh pr create --fill"), SILENT);
    commitHigh(f, "4.0.0");
    denial(hook(f, "git push"));
  } finally {
    f.cleanup();
  }
});

// ---- the corrected-and-approved lineage ----

const SEVERE = {
  location: "a.txt:1",
  severity: "CRITICAL",
  claim: "a.txt breaks on empty input",
  proof_refs: ["a.txt:1 reads the first line unchecked"],
  evidence_class: "deterministic",
  causal_disposition: "introduced",
};

function section(prompt: string, name: string): string {
  const m = new RegExp(`<<<ODD-DATA-\\w+ ${name}>>>\\n([\\s\\S]*?)\\n<<<END-ODD-DATA-\\w+ ${name}>>>`).exec(prompt);
  assert.ok(m, `prompt has a ${name} section`);
  return m[1]!;
}

/** A reviewer that answers from the prompt's own echo line; the risk lens reports one severe finding. */
const fakeRunner: NonNullable<RunDeps["runner"]> = async (prompt) => {
  const head = /Role: (\w+)(?:, lens: (\w+))?\./.exec(prompt)!;
  const role = head[1]!;
  const echo = JSON.parse(/Echo these fields verbatim in the result: (\{.*\})/.exec(prompt)![1]!) as Record<string, unknown>;
  let result: Record<string, unknown>;
  if (role === "lens") {
    result = { ...echo, inspection: { status: "completed", paths: section(prompt, "changed-path-manifest").split("\n") }, findings: head[2] === "risk" ? [SEVERE] : [], evidence: ["reviewed the complete candidate scope"] };
  } else if (role === "refuter") {
    const ids = (JSON.parse(section(prompt, "findings")) as Array<{ id: string }>).map((x) => x.id);
    result = { ...echo, results: ids.map((id) => ({ finding_id: id, outcome: "refuted", proof_refs: ["a.txt:1 handles the empty input"] })) };
  } else {
    result = { ...echo, original_criteria: { passed: true, evidence: ["a.txt:1 now guards the empty input"] }, correction_regression: { passed: true, evidence: ["the regression test passes"] }, follow_ups: [] };
  }
  return { ok: true, stdout: `\`\`\`json\n${JSON.stringify(result)}\n\`\`\`\n`, elapsedMs: 1 };
};

function is<K extends ReviewRunOutcome["outcome"]>(o: ReviewRunOutcome, kind: K): Extract<ReviewRunOutcome, { outcome: K }> {
  assert.equal(o.outcome, kind, JSON.stringify(o).slice(0, 800));
  return o as Extract<ReviewRunOutcome, { outcome: K }>;
}

test("corrected-and-approved lineage: the corrected range is consumed (allow); the pre-correction range is not (deny)", async () => {
  const f = fx();
  try {
    on(f);
    writeFileSync(join(f.repo, "package.json"), '{"name":"x","dependencies":{"left-pad":"1.0.0"}}\n');
    writeFileSync(join(f.repo, "a.txt"), "one\ntwo\nthree\nfour\n");
    git(f.repo, "commit", "-q", "-am", "feature work");
    const deps: RunDeps = { riskAssessor: assess("medium"), runner: fakeRunner };
    const started = await startReview({ cwd: f.repo, target: rangeTarget, consent: "granted", riskAssessor: assess("medium") });
    assert.equal(started.status, "started");
    if (started.status !== "started") throw new Error("unreachable");
    const lineageId = started.result.lineage_id;
    const input = (over: Partial<ReviewRunInput> = {}): ReviewRunInput => ({ cwd: f.repo, lineageId, target: rangeTarget, ...over });
    const run = async (): Promise<ReviewRunOutcome> => {
      const forecast = is(await runReview(input(), deps), "forecast");
      return runReview(input({ reviewerRunAcknowledged: true, reviewerRunBinding: forecast.reviewer_run_binding }), deps);
    };
    is(await run(), "input-required");
    const original = readState(f.commonDir, lineageId).target_identity;
    denial(hook(f, "git push")); // the reviewed range found a severe issue: not consumed

    writeFileSync(join(f.repo, "a.txt"), "ONE\ntwo\nthree\nfour\n");
    git(f.repo, "commit", "-q", "-am", "fix the finding");
    denial(hook(f, "git push")); // corrected but not yet validated and approved
    const closed = is(await run(), "closed");
    assert.notEqual(closed.target_identity, original);
    assert.equal(isTargetConsumed(f.commonDir, closed.target_identity!).status, "consumed");
    assert.equal(isTargetConsumed(f.commonDir, original).status, "not_consumed");
    assert.deepEqual(hook(f, "git push"), SILENT, "the corrected range is the approved identity");
    assert.deepEqual(hook(f, "gh pr create --fill"), SILENT);
    // another change is a new candidate
    commitHigh(f, "7.7.7");
    denial(hook(f, "git push"));
    git(f.repo, "reset", "-q", "--hard", "HEAD~1");
    assert.deepEqual(hook(f, "git push"), SILENT);
    assert.equal(listLineages(f.commonDir).lineages.length, 1);
  } finally {
    f.cleanup();
  }
});

test("a live review that is not approved does not allow delivery", async () => {
  const f = fx();
  try {
    on(f);
    commitHigh(f);
    const started = await startReview({ cwd: f.repo, target: rangeTarget, consent: "granted", riskAssessor: assess("high") });
    assert.equal(started.status, "started");
    denial(hook(f, "git push"));
  } finally {
    f.cleanup();
  }
});

// ---- ambiguity and the error policy (follows the reference: fail closed once RDD is on) ----

test("RDD on: a chain that changes the candidate before delivering is denied, whatever the risk; RDD off allows it", () => {
  const f = fx();
  try {
    commitLow(f);
    assert.deepEqual(hook(f, "git commit -am x && git push"), SILENT);
    on(f);
    for (const c of ["git commit --allow-empty -m x && git push", "git rebase origin/main; git push", "git merge main && gh pr create --fill", "git pull && git push", "git reset --hard HEAD~1; git push", "bash -c 'git commit -am x; git push'"]) {
      const d = denial(hook(f, c));
      assert.match(d.permissionDecisionReason, /candidate-changing/i, c);
      assert.match(d.permissionDecisionReason, /separately/i, c);
    }
    // the same delivery alone is assessed (low risk: allowed)
    assert.deepEqual(hook(f, "git push"), SILENT);
    // a candidate-changing command without a delivery is not the gate's business
    assert.deepEqual(hook(f, "git commit -am x"), SILENT);
  } finally {
    f.cleanup();
  }
});

test("RDD on: a delivery whose repository cannot be resolved is denied; with RDD off it is allowed", () => {
  const f = fx();
  try {
    commitLow(f);
    for (const c of ['cd "$X" && git push', "GIT_DIR=/elsewhere git push", "git --git-dir=/elsewhere push", "cd a; git push"]) assert.deepEqual(hook(f, c), SILENT, c);
    on(f);
    for (const c of ['cd "$X" && git push', "GIT_DIR=/elsewhere git push", "git --git-dir=/elsewhere push", "cd a; git push", "export GIT_DIR=/x; git push"]) {
      const d = denial(hook(f, c));
      assert.match(d.permissionDecisionReason, /cannot be resolved/, c);
      assert.match(d.permissionDecisionReason, /literal cd or git -C/, c);
    }
  } finally {
    f.cleanup();
  }
});

test("RDD on: no base to compare with (no remote refs) is denied with the base named; RDD off allows it", () => {
  const f = fx({ remote: false });
  try {
    commitLow(f);
    assert.deepEqual(hook(f, "git push origin feature"), SILENT);
    on(f);
    const d = denial(hook(f, "git push origin feature"));
    assert.match(d.permissionDecisionReason, /no base|cannot derive|committed range/i);
    assert.match(d.permissionDecisionReason, /origin\/HEAD|upstream/);
  } finally {
    f.cleanup();
  }
});

test("push targets: an explicit remote branch, @{upstream} and origin/HEAD choose the base; a refspec that is not HEAD is unassessable", () => {
  const f = fx();
  try {
    on(f);
    // another remote branch already holds the high-risk commit: pushing it to that remote branch is an empty range
    commitHigh(f);
    git(f.repo, "push", "-q", "origin", "feature:other");
    git(f.repo, "fetch", "-q", "origin");
    assert.deepEqual(hook(f, "git push origin feature:other"), SILENT, "target origin/other already has HEAD");
    denial(hook(f, "git push origin feature:fresh")); // not on the remote: the range is against origin/HEAD
    denial(hook(f, "git push origin HEAD"));
    // upstream wins over origin/HEAD when no remote branch is named
    git(f.repo, "branch", "-q", "--set-upstream-to=origin/other");
    assert.deepEqual(hook(f, "git push"), SILENT);
    // a ref other than HEAD cannot be assessed against HEAD
    git(f.repo, "branch", "-q", "elsewhere", "main");
    const d = denial(hook(f, "git push origin elsewhere"));
    assert.match(d.permissionDecisionReason, /other than HEAD|not HEAD/i);
    denial(hook(f, "git push --all origin"));
    denial(hook(f, "git push --mirror origin"));
    // refspecs that do name HEAD, and --tags, are assessed as the HEAD range
    assert.deepEqual(hook(f, "git push origin feature:other"), SILENT);
    // gh pr create --base picks that remote branch as the base
    assert.deepEqual(hook(f, "gh pr create --base other --fill"), SILENT);
    assert.deepEqual(hook(f, "gh pr create -B other --fill"), SILENT);
    denial(hook(f, "gh pr create --base main --fill"));
  } finally {
    f.cleanup();
  }
});

test("internal errors with RDD on fail closed; with RDD off the checker is never reached", () => {
  const f = fx();
  try {
    commitHigh(f);
    const boom = (): never => {
      throw new Error("kaboom");
    };
    const off = checkDelivery({ cwd: f.repo, command: "git push" }, { dataDir: f.data, assess: boom });
    assert.deepEqual(off, { allowed: true, reason: "rdd_off" });
    on(f);
    const r = checkDelivery({ cwd: f.repo, command: "git push" }, { dataDir: f.data, assess: boom });
    assert.equal(r.allowed, false);
    if (r.allowed) throw new Error("unreachable");
    assert.equal(r.code, "check_failed");
    assert.match(r.reason, /fail(s|ed)? closed|unavailable/i);
    assert.match(r.reason, /review-mode\.js disable/);
    assert.match(r.reason, /kaboom/);
    // through the hook runner: still a denial with the PreToolUse shape
    const viaHook = checkDelivery({ cwd: f.repo, command: "git push" }, { dataDir: f.data, assess: boom });
    assert.equal(viaHook.allowed, false);
    // not a delivery: the checker is never consulted
    assert.deepEqual(checkDelivery({ cwd: f.repo, command: "git status" }, { dataDir: f.data, assess: boom }), { allowed: true, reason: "no_delivery" });
    // a non-repository directory cannot be RDD-on: allowed
    assert.deepEqual(checkDelivery({ cwd: f.dir, command: "git push" }, { dataDir: f.data, assess: boom }), { allowed: true, reason: "not_a_repository" });
  } finally {
    f.cleanup();
  }
});

test("a blown time budget fails closed (deadline seam)", () => {
  const f = fx();
  try {
    on(f);
    commitHigh(f);
    const r = checkDelivery({ cwd: f.repo, command: "git push" }, { dataDir: f.data, deadlineMs: -1 });
    assert.equal(r.allowed, false);
    if (r.allowed) throw new Error("unreachable");
    assert.equal(r.code, "check_failed");
    assert.match(r.reason, /time budget|timed out/i);
  } finally {
    f.cleanup();
  }
});

test("the gate only reads: no review authority, decline, lock or ref is created, a refusal or an allow", () => {
  const f = fx();
  try {
    on(f);
    commitHigh(f);
    const before = storeSnapshot(f);
    denial(hook(f, "git push"));
    denial(hook(f, "gh pr create --fill"));
    assert.equal(storeSnapshot(f), before);
    assert.equal(existsSync(storeRootFor(f.commonDir)), false);
    assert.equal(existsSync(join(f.commonDir, "odd-plugin")), false);
    git(f.repo, "reset", "-q", "--hard", "origin/main");
    commitLow(f);
    const before2 = storeSnapshot(f);
    assert.deepEqual(hook(f, "git push"), SILENT);
    assert.equal(storeSnapshot(f), before2);
    assert.equal(existsSync(join(f.commonDir, "odd-plugin")), false);
  } finally {
    f.cleanup();
  }
});

test("CLAUDE_PLUGIN_ROOT names the root in the reason (quoted when it has a space)", () => {
  const f = fx();
  try {
    on(f);
    commitHigh(f);
    const d = denial(hook(f, "git push", {}, { CLAUDE_PLUGIN_ROOT: "/opt/odd root" }));
    assert.ok(d.permissionDecisionReason.includes("node '/opt/odd root/dist/cli/review-mode.js' disable"), d.permissionDecisionReason);
  } finally {
    f.cleanup();
  }
});

test("performance: a large repository (many files and commits) is checked well inside the hook timeout", () => {
  const f = fx();
  try {
    on(f);
    const big = join(f.repo, "big");
    mkdirSync(big);
    for (let d = 0; d < 30; d++) {
      mkdirSync(join(big, `d${d}`));
      for (let i = 0; i < 100; i++) writeFileSync(join(big, `d${d}`, `f${i}.txt`), `file ${d} ${i}\n`.repeat(5));
    }
    git(f.repo, "add", "-A");
    git(f.repo, "commit", "-q", "-m", "bulk");
    git(f.repo, "push", "-q", "origin", "feature:main");
    git(f.repo, "fetch", "-q", "origin");
    for (let i = 0; i < 120; i++) git(f.repo, "commit", "-q", "--allow-empty", "-m", `c${i}`);
    commitHigh(f);
    const t0 = Date.now();
    const r = hook(f, "git push");
    const ms = Date.now() - t0;
    denial(r);
    assert.ok(ms < 15_000, `check took ${ms} ms`);
    const t1 = Date.now();
    assert.deepEqual(hook(f, "git status"), SILENT);
    assert.ok(Date.now() - t1 < 1000, "a non-delivery Bash call is cheap");
  } finally {
    f.cleanup();
  }
});

test("the shipped dist/hooks/run.js PreToolUse prints the denial on stdout and exits 0", async () => {
  const f = fx();
  try {
    on(f);
    commitHigh(f);
    const run = join(PLUGIN_ROOT, "dist", "hooks", "run.js");
    assert.ok(existsSync(run));
    const one = (command: string): Promise<{ code: number | null; out: string; err: string }> =>
      new Promise((resolve) => {
        const c = spawn(process.execPath, [run, "PreToolUse"], { env: { ...ENV, CLAUDE_PLUGIN_DATA: f.data }, stdio: ["pipe", "pipe", "pipe"] });
        let out = "";
        let err = "";
        c.stdout.on("data", (d: Buffer) => (out += d.toString()));
        c.stderr.on("data", (d: Buffer) => (err += d.toString()));
        c.on("close", (code) => resolve({ code, out, err }));
        c.stdin.end(JSON.stringify({ session_id: "p", cwd: f.repo, tool_name: "Bash", tool_input: { command } }));
      });
    const denied = await one("git push origin feature");
    assert.equal(denied.code, 0);
    assert.equal(denied.err, "");
    assert.equal(JSON.parse(denied.out).hookSpecificOutput.permissionDecision, "deny");
    const quiet = await one("ls");
    assert.deepEqual({ code: quiet.code, out: quiet.out }, { code: 0, out: "" });
  } finally {
    f.cleanup();
  }
});

test("hooks.json wires PreToolUse on Bash only, through the shared run.js dispatcher", () => {
  const cfg = JSON.parse(readFileSync(join(PLUGIN_ROOT, "hooks", "hooks.json"), "utf8")) as { hooks: Record<string, { matcher?: string; hooks: { type: string; command: string; timeout?: number }[] }[]> };
  const groups = cfg.hooks.PreToolUse;
  assert.equal(groups?.length, 1);
  assert.equal(groups![0]!.matcher, "Bash");
  assert.deepEqual(groups![0]!.hooks.map((h) => h.command), [`node "\${CLAUDE_PLUGIN_ROOT}/dist/hooks/run.js" PreToolUse`]);
  const t = groups![0]!.hooks[0]!.timeout!;
  assert.ok(t >= 20 && t <= 60, `timeout ${t}`);
});

// ---------------------------------------------------------------------------------------------
// 3. verification follow-ups of 8834d76 (F1, F2, F3, A1)
// ---------------------------------------------------------------------------------------------

test("a tag pointing at an older commit is assessed as the HEAD range (never refused as another ref)", () => {
  const f = fx();
  try {
    on(f);
    git(f.repo, "tag", "v1", "main");
    commitHigh(f);
    const d = denial(hook(f, "git push origin v1"));
    assert.match(d.permissionDecisionReason, /high risk/);
    git(f.repo, "reset", "-q", "--hard", "origin/main");
    commitLow(f);
    assert.deepEqual(hook(f, "git push origin v1"), SILENT);
  } finally {
    f.cleanup();
  }
});

test("A1: values of -o/--push-option/--receive-pack/--exec/--repo are values, never exemption flags", () => {
  for (const c of ["git push -o -d origin main", "git push -o -n origin main", "git push --push-option -d origin main", "git push --push-option=-n origin", "git push --receive-pack -d origin", "git push --exec -n origin", "git push --repo -d main", "git push origin -- -d"]) {
    assert.equal(deliveries(c).length, 1, c);
  }
  // the real exemptions still hold, also next to a value option
  for (const c of ["git push -o x -n origin", "git push -d -o x origin", "git push --dry-run -o -d origin", "git push -o ci.skip --delete origin b"]) assert.equal(deliveries(c).length, 0, c);
});

test("F1: a workspace (current-changes) review does not authorize delivery of the committed range (the identity includes the kind)", async () => {
  const f = fx();
  try {
    on(f);
    writeFileSync(join(f.repo, "package.json"), '{"name":"x","dependencies":{"left-pad":"1.0.0"}}\n');
    const started = await startReview({ cwd: f.repo, target: { kind: "current-changes" }, consent: "granted", riskAssessor: lowAssessor });
    if (started.status !== "started") throw new Error("unreachable");
    const ack = started.result.acknowledgement!;
    await acknowledgeApproved(f.commonDir, { lineage: ack.lineage_id, target: ack.target_identity, expectedRevision: ack.expected_revision, token: ack.token });
    assert.equal(isTargetConsumed(f.commonDir, ack.target_identity).status, "consumed");
    git(f.repo, "commit", "-q", "-am", "the reviewed workspace change");
    denial(hook(f, "git push"));
    // the committed range is delivered by reviewing it (committed-only)
    const range = await startReview({ cwd: f.repo, target: rangeTarget, consent: "granted", riskAssessor: lowAssessor });
    if (range.status !== "started") throw new Error("unreachable");
    const r = range.result.acknowledgement!;
    await acknowledgeApproved(f.commonDir, { lineage: r.lineage_id, target: r.target_identity, expectedRevision: r.expected_revision, token: r.token });
    assert.deepEqual(hook(f, "git push"), SILENT);
  } finally {
    f.cleanup();
  }
});

test("F2: an unresolved delivery from a non-repository directory follows the GLOBAL mode", () => {
  const f = fx();
  try {
    const cmds = [`cd ${f.repo}; git push`, `GIT_DIR=${f.repo}/.git git push`, `git --git-dir ${f.repo}/.git push`, 'cd "$X" && git push'];
    for (const c of cmds) assert.deepEqual(checkDelivery({ cwd: f.dir, command: c }, { dataDir: f.data }), { allowed: true, reason: "not_a_repository" }, c);
    on(f);
    for (const c of cmds) {
      const r = checkDelivery({ cwd: f.dir, command: c }, { dataDir: f.data });
      assert.equal(r.allowed, false, c);
      if (!r.allowed) {
        assert.equal(r.code, "unresolved_directory", c);
        assert.match(r.reason, /cannot be resolved/);
        assert.match(r.reason, /review-mode\.js disable/);
      }
      denial(runHook("PreToolUse", JSON.stringify({ session_id: "s", cwd: f.dir, tool_name: "Bash", tool_input: { command: c } }), { dataDir: f.data }));
    }
    // a RESOLVED delivery to a directory that is not a repository still passes (git itself fails there)
    assert.deepEqual(checkDelivery({ cwd: f.dir, command: "git push" }, { dataDir: f.data }), { allowed: true, reason: "not_a_repository" });
    assert.deepEqual(checkDelivery({ cwd: f.dir, command: `git -C ${join(f.dir, "nowhere")} push` }, { dataDir: f.data }), { allowed: true, reason: "not_a_repository" });
    setReviewMode("disable", "global", f.repo, { dataDir: f.data });
    for (const c of cmds) assert.equal(checkDelivery({ cwd: f.dir, command: c }, { dataDir: f.data }).allowed, true, c);
    // from a repository the session repository's mode still decides (clone-local off wins over global on)
    on(f);
    setReviewMode("disable", "clone", f.repo, { dataDir: f.data });
    assert.equal(checkDelivery({ cwd: f.repo, command: 'cd "$X" && git push' }, { dataDir: f.data }).allowed, true);
  } finally {
    f.cleanup();
  }
});

test("F3: a git failure with RDD on fails closed (rev-list, the HEAD probe, repository resolution); a real unborn HEAD and a plain non-repository stay allowed", () => {
  const f = fx();
  const prevPath = process.env.PATH;
  try {
    commitHigh(f);
    const failing = (what: (args: string[]) => boolean) => (call: Parameters<typeof runGit>[0]): ReturnType<typeof runGit> => {
      if (what(call.args)) throw new SnapshotError("git_failed", `git ${call.args[0]} failed with exit code 128`, { exitCode: 128 });
      return runGit(call);
    };
    const seams: [string, (a: string[]) => boolean][] = [
      ["rev-list", (a) => a[0] === "rev-list"],
      ["HEAD probe", (a) => a[0] === "rev-parse" && a.some((x) => x === "HEAD^{commit}")],
      ["merge-base", (a) => a[0] === "merge-base"],
    ];
    // RDD off: the seam is never reached
    for (const [, w] of seams) assert.deepEqual(checkDelivery({ cwd: f.repo, command: "git push" }, { dataDir: f.data, git: failing(w) }), { allowed: true, reason: "rdd_off" });
    on(f);
    for (const [name, w] of seams) {
      const r = checkDelivery({ cwd: f.repo, command: "git push" }, { dataDir: f.data, git: failing(w) });
      assert.equal(r.allowed, false, name);
      if (!r.allowed) {
        assert.equal(r.code, "check_failed", name);
        assert.match(r.reason, /fails? closed/i, name);
      }
    }
    // a rev-list that answers nothing parseable is a failure too, never an empty range
    const garbage = (call: Parameters<typeof runGit>[0]): ReturnType<typeof runGit> => (call.args[0] === "rev-list" ? { stdout: Buffer.from(""), exitCode: 0 } : runGit(call));
    const g = checkDelivery({ cwd: f.repo, command: "git push" }, { dataDir: f.data, git: garbage });
    assert.equal(g.allowed === false && g.code, "check_failed");
    // the unmodified checker still denies for the real reason
    const real = checkDelivery({ cwd: f.repo, command: "git push" }, { dataDir: f.data });
    assert.equal(real.allowed === false && real.code, "review_due");

    // a repository that cannot be resolved because git misbehaves (not "not a repository"): fail closed while the mode is on
    const bin = join(f.dir, "bin");
    mkdirSync(bin);
    const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
    writeFileSync(join(bin, "git"), `#!/bin/sh\ncase "$*" in *--show-toplevel*) exit 0;; esac\nexec ${realGit} "$@"\n`, { mode: 0o755 });
    process.env.PATH = `${bin}:${prevPath ?? ""}`;
    const broken = checkDelivery({ cwd: f.repo, command: "git push" }, { dataDir: f.data });
    assert.equal(broken.allowed === false && broken.code, "check_failed");
    setReviewMode("disable", "global", f.repo, { dataDir: f.data });
    assert.equal(checkDelivery({ cwd: f.repo, command: "git push" }, { dataDir: f.data }).allowed, true);
    process.env.PATH = prevPath;
    on(f);

    // an unborn HEAD has nothing to deliver; a plain directory is not a repository
    const unborn = join(f.dir, "unborn");
    mkdirSync(unborn);
    git(unborn, "init", "-q", "-b", "main");
    assert.deepEqual(checkDelivery({ cwd: unborn, command: "git push" }, { dataDir: f.data }), { allowed: true, reason: "empty_range" });
    assert.deepEqual(checkDelivery({ cwd: f.dir, command: "git push" }, { dataDir: f.data }), { allowed: true, reason: "not_a_repository" });
  } finally {
    process.env.PATH = prevPath;
    f.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// 4. verification follow-ups of cb1bb26 (F-A, T1, untrusted repository, F3 symbolic-ref/config)
// ---------------------------------------------------------------------------------------------

function fakeGit(f: Fx, body: string): void {
  const bin = join(f.dir, "bin");
  mkdirSync(bin, { recursive: true });
  const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  writeFileSync(join(bin, "git"), `#!/bin/sh\n${body}\nexec ${realGit} "$@"\n`, { mode: 0o755 });
  process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
}

test("clone-local off wins when git fails resolving the repository: never a denial (timeout on --show-toplevel, exit 128 on --git-common-dir)", () => {
  const f = fx();
  const prevPath = process.env.PATH;
  try {
    commitHigh(f);
    on(f);
    const cmds = ["git push", "gh pr create --fill", `cd ${f.repo}; git push`, `cd ${f.repo} && git push`];
    const opts = { dataDir: f.data, gitTimeoutMs: 800 };
    const variants: [string, string][] = [
      ["timeout on --show-toplevel", 'case "$*" in *--show-toplevel*) exec sleep 3;; esac'],
      ["exit 128 on --git-common-dir", 'case "$*" in *--git-common-dir*) echo "fatal: boom" >&2; exit 128;; esac'],
    ];
    for (const [name, body] of variants) {
      // control: with no clone override the global on stands and the unresolvable repository fails closed
      setReviewMode("enable", "clone", f.repo, { dataDir: f.data });
      fakeGit(f, body);
      for (const c of cmds.slice(0, 2)) {
        const r = checkDelivery({ cwd: f.repo, command: c }, opts);
        assert.equal(r.allowed === false && r.code, "check_failed", `${name}: ${c}`);
      }
      process.env.PATH = prevPath;
      // the clone-local off (read from the repository directory itself) wins: never a denial
      setReviewMode("disable", "clone", f.repo, { dataDir: f.data });
      fakeGit(f, body);
      for (const c of cmds) {
        assert.equal(checkDelivery({ cwd: f.repo, command: c }, opts).allowed, true, `${name}: ${c}`);
        assert.deepEqual(hook(f, c), SILENT, `${name}: hook ${c}`);
      }
      process.env.PATH = prevPath;
    }
    // A1: a .git FILE (linked worktree) is followed (gitdir:, then commondir) to the real override: an off wins, and
    // with no override (or a .git file that leads nowhere) the global switch decides, never an assumed off
    const wt = join(f.dir, "wt");
    git(f.repo, "worktree", "add", "-q", "-b", "wtb", wt);
    const slow = 'case "$*" in *--show-toplevel*) exec sleep 3;; esac';
    setReviewMode("enable", "clone", f.repo, { dataDir: f.data });
    fakeGit(f, slow);
    const noOverride = checkDelivery({ cwd: wt, command: "git push" }, opts);
    assert.equal(noOverride.allowed === false && noOverride.code, "check_failed", "worktree, global on, no override");
    process.env.PATH = prevPath;
    setReviewMode("disable", "clone", f.repo, { dataDir: f.data });
    fakeGit(f, slow);
    assert.equal(checkDelivery({ cwd: wt, command: "git push" }, opts).allowed, true, "worktree with the clone off");
    process.env.PATH = prevPath;
    const lost = join(f.dir, "lost");
    mkdirSync(lost);
    writeFileSync(join(lost, ".git"), "gitdir: /nonexistent-odd-gitdir\n");
    fakeGit(f, slow);
    const lostR = checkDelivery({ cwd: lost, command: "git push" }, opts);
    assert.equal(lostR.allowed === false && lostR.code, "check_failed", "an unlocatable .git file: the global switch decides");
  } finally {
    process.env.PATH = prevPath;
    f.cleanup();
  }
});

test("a pushed tag that is not HEAD or an ancestor of HEAD is unassessable", () => {
  const f = fx();
  try {
    on(f);
    git(f.repo, "checkout", "-q", "-b", "risky");
    commitHigh(f);
    git(f.repo, "tag", "vrisky");
    git(f.repo, "tag", "-a", "-m", "annotated", "arisky");
    git(f.repo, "checkout", "-q", "feature");
    commitLow(f);
    git(f.repo, "tag", "vold", "main");
    git(f.repo, "tag", "vhead");
    for (const c of ["git push origin vrisky", "git push origin tag vrisky", "git push origin refs/tags/vrisky", "git push origin arisky", "git push origin refs/tags/arisky:refs/tags/arisky", "git push origin +vrisky", "git push --tags", "git push origin --tags"]) {
      const r = checkDelivery({ cwd: f.repo, command: c }, { dataDir: f.data });
      assert.equal(r.allowed === false && r.code, "unassessable_ref", c);
      denial(hook(f, c));
    }
    // HEAD itself, an ancestor, and --follow-tags (only tags reachable from the pushed history) are assessed as the HEAD range
    for (const c of ["git push origin vold", "git push origin tag vold", "git push origin refs/tags/vold", "git push origin vhead", "git push --follow-tags"]) {
      assert.equal(checkDelivery({ cwd: f.repo, command: c }, { dataDir: f.data }).allowed, true, c);
    }
    // with the risky tags gone, --tags only carries tags inside HEAD's history
    git(f.repo, "tag", "-d", "vrisky", "arisky");
    assert.equal(checkDelivery({ cwd: f.repo, command: "git push --tags" }, { dataDir: f.data }).allowed, true);
    // RDD off: never reached
    git(f.repo, "tag", "vother", "risky");
    setReviewMode("disable", "global", f.repo, { dataDir: f.data });
    assert.deepEqual(hook(f, "git push origin vother"), SILENT);
  } finally {
    f.cleanup();
  }
});

const DUBIOUS = (repo: string): string =>
  `case "$*" in *--show-toplevel*) printf '%s\\n' "fatal: detected dubious ownership in repository at '${repo}'" "To add an exception for this directory, call:" "" "	git config --global --add safe.directory ${repo}" >&2; exit 128;; esac`;

test("an untrusted repository (dubious ownership): the clone override is read directly (off wins), otherwise the GLOBAL mode decides, also against safe.directory overrides in the command (A2, A3)", () => {
  const f = fx();
  const prevPath = process.env.PATH;
  try {
    commitHigh(f);
    on(f);
    const opts = { dataDir: f.data, gitTimeoutMs: 800 };
    const sd = "git -c safe.directory='*' push";
    const sdEnv = "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0='*' git push";
    const resolved = ["git push", "gh pr create --fill", sd, sdEnv];
    const unresolved = ['cd "$D" && git push', `cd ${f.repo}; git push`];
    // no override: the global on stands (git cannot be asked, the command may even override safe.directory): deny
    fakeGit(f, DUBIOUS(f.repo));
    for (const c of resolved) {
      const r = checkDelivery({ cwd: f.repo, command: c }, opts);
      assert.equal(r.allowed === false && r.code, "check_failed", c);
      if (!r.allowed) assert.match(r.reason, /review-mode\.js disable/);
    }
    for (const c of unresolved) {
      const r = checkDelivery({ cwd: f.repo, command: c }, opts);
      assert.equal(r.allowed === false && r.code, "unresolved_directory", c);
    }
    denial(hook(f, sd));
    // the clone-local off, read directly from the repository's common dir, wins for every form
    process.env.PATH = prevPath;
    setReviewMode("disable", "clone", f.repo, { dataDir: f.data });
    fakeGit(f, DUBIOUS(f.repo));
    for (const c of [...resolved, ...unresolved]) {
      assert.equal(checkDelivery({ cwd: f.repo, command: c }, opts).allowed, true, c);
      assert.deepEqual(hook(f, c), SILENT, c);
    }
    // global off: silent as always
    process.env.PATH = prevPath;
    setReviewMode("enable", "clone", f.repo, { dataDir: f.data });
    setReviewMode("disable", "global", f.repo, { dataDir: f.data });
    fakeGit(f, DUBIOUS(f.repo));
    for (const c of [...resolved, ...unresolved]) assert.equal(checkDelivery({ cwd: f.repo, command: c }, opts).allowed, true, c);
  } finally {
    process.env.PATH = prevPath;
    f.cleanup();
  }
});

test("A4: in an untrusted nested repository only ITS OWN .git decides; a parent's clone off is never borrowed", () => {
  const f = fx();
  const prevPath = process.env.PATH;
  try {
    commitHigh(f);
    on(f);
    setReviewMode("disable", "clone", f.repo, { dataDir: f.data }); // the parent says off
    const nested = join(f.repo, "nested");
    mkdirSync(nested);
    git(nested, "init", "-q", "-b", "main");
    const opts = { dataDir: f.data, gitTimeoutMs: 800 };
    fakeGit(f, DUBIOUS(nested));
    const r = checkDelivery({ cwd: nested, command: "git push" }, opts);
    assert.equal(r.allowed === false && r.code, "check_failed", "nested has no override of its own: global on decides");
    const u = checkDelivery({ cwd: nested, command: 'cd "$D" && git push' }, opts);
    assert.equal(u.allowed === false && u.code, "unresolved_directory");
    process.env.PATH = prevPath;
    setReviewMode("disable", "clone", nested, { dataDir: f.data });
    fakeGit(f, DUBIOUS(nested));
    assert.equal(checkDelivery({ cwd: nested, command: "git push" }, opts).allowed, true, "its own off wins");
  } finally {
    process.env.PATH = prevPath;
    f.cleanup();
  }
});

test("walk-up: a nested repository never borrows a parent's clone off (S3)", () => {
  const f = fx();
  const prevPath = process.env.PATH;
  try {
    commitHigh(f);
    on(f);
    setReviewMode("disable", "clone", f.repo, { dataDir: f.data });
    const nested = join(f.repo, "nested");
    mkdirSync(nested);
    git(nested, "init", "-q", "-b", "main");
    // git works: the nested repository has its own (absent) override, so the global on decides
    const s = readReviewMode(nested, { dataDir: f.data });
    assert.deepEqual([s.effective, s.cloneLocal], ["on", "unset"]);
    // git fails: the nearest .git (the nested one) is still the one read
    fakeGit(f, 'case "$*" in *--git-common-dir*) echo "fatal: boom" >&2; exit 128;; esac');
    const t = readReviewMode(nested, { dataDir: f.data });
    assert.deepEqual([t.effective, t.cloneLocal], ["on", "unset"]);
    const sub = join(f.repo, "plain-subdir");
    mkdirSync(sub);
    assert.deepEqual([readReviewMode(sub, { dataDir: f.data }).effective, readReviewMode(sub, { dataDir: f.data }).cloneLocal], ["off", "off"], "a plain subdirectory belongs to the parent");
  } finally {
    process.env.PATH = prevPath;
    f.cleanup();
  }
});

test("the dubious-ownership classifier needs the fatal line AND the safe.directory hint", () => {
  const f = fx();
  const prevPath = process.env.PATH;
  try {
    const classify = (body: string): string | undefined => {
      process.env.PATH = prevPath;
      fakeGit(f, body);
      try {
        resolveRepository(f.repo, { gitTimeoutMs: 800 });
        return undefined;
      } catch (err) {
        return err instanceof SnapshotError ? err.code : String(err);
      }
    };
    const guard = 'case "$*" in *--show-toplevel*)';
    assert.equal(classify(`${guard} printf '%s\\n' "fatal: detected dubious ownership in repository at 'x'" "	git config --global --add safe.directory x" >&2; exit 128;; esac`), "untrusted_repository");
    assert.equal(classify(`${guard} printf '%s\\n' "fatal: unsafe repository ('x' is owned by someone else)" "	git config --global --add safe.directory x" >&2; exit 128;; esac`), "untrusted_repository");
    assert.equal(classify(`${guard} echo "fatal: detected dubious ownership in repository at 'x'" >&2; exit 128;; esac`), "not_a_repository");
    assert.equal(classify(`${guard} echo "hint: see safe.directory in the docs" >&2; exit 128;; esac`), "not_a_repository");
    assert.equal(classify(`${guard} echo "fatal: not a git repository" >&2; exit 128;; esac`), "not_a_repository");
    assert.equal(classify(`${guard} printf '%s\\n' "fatal: detected dubious ownership in repository at 'x'" "	git config --global --add safe.directory x" >&2; exit 1;; esac`), "not_a_repository");
  } finally {
    process.env.PATH = prevPath;
    f.cleanup();
  }
});

test("A3: with global on and the clone off, an unresolved delivery is allowed when git fails (not only a timeout) on --show-toplevel", () => {
  const f = fx();
  const prevPath = process.env.PATH;
  try {
    commitHigh(f);
    on(f);
    setReviewMode("disable", "clone", f.repo, { dataDir: f.data });
    const opts = { dataDir: f.data, gitTimeoutMs: 800 };
    fakeGit(f, 'case "$*" in *--show-toplevel*) echo "fatal: not a git repository" >&2; exit 128;; esac');
    for (const c of ['cd "$D" && git push', `cd ${f.repo}; git push`, "git push"]) assert.equal(checkDelivery({ cwd: f.repo, command: c }, opts).allowed, true, c);
    process.env.PATH = prevPath;
    setReviewMode("enable", "clone", f.repo, { dataDir: f.data });
    fakeGit(f, 'case "$*" in *--show-toplevel*) echo "fatal: not a git repository" >&2; exit 128;; esac');
    const r = checkDelivery({ cwd: f.repo, command: 'cd "$D" && git push' }, opts);
    assert.equal(r.allowed === false && r.code, "unresolved_directory", "no override: the global on decides");
  } finally {
    process.env.PATH = prevPath;
    f.cleanup();
  }
});

test("T1: non-commit and descendant tags are unassessable; HEAD and ancestor tags are still assessed (S2)", () => {
  const f = fx();
  try {
    on(f);
    const blob = git(f.repo, "hash-object", "-w", "a.txt").trim();
    const tree = git(f.repo, "rev-parse", "HEAD^{tree}").trim();
    git(f.repo, "tag", "vold", "main");
    commitHigh(f);
    git(f.repo, "tag", "vh");
    git(f.repo, "update-ref", "refs/tags/vblob", blob);
    git(f.repo, "update-ref", "refs/tags/atree", tree);
    git(f.repo, "checkout", "-q", "-b", "later");
    commitLow(f);
    git(f.repo, "tag", "vfut");
    git(f.repo, "checkout", "-q", "feature");
    for (const t of ["vblob", "atree", "vfut"]) {
      for (const c of [`git push origin ${t}`, `git push origin tag ${t}`, `git push origin refs/tags/${t}`]) {
        const r = checkDelivery({ cwd: f.repo, command: c }, { dataDir: f.data });
        assert.equal(r.allowed === false && r.code, "unassessable_ref", c);
      }
    }
    for (const c of ["git push origin vh", "git push origin vold", "git push origin tag vold", "git push --follow-tags"]) {
      const r = checkDelivery({ cwd: f.repo, command: c }, { dataDir: f.data });
      assert.equal(r.allowed === false && r.code, "review_due", c);
    }
    git(f.repo, "tag", "-d", "vfut", "vblob", "atree");
    const r = checkDelivery({ cwd: f.repo, command: "git push --tags" }, { dataDir: f.data });
    assert.equal(r.allowed === false && r.code, "review_due", "--tags with only HEAD/ancestor tags is assessed");
  } finally {
    f.cleanup();
  }
});


test("F3: symbolic-ref and config failures fail closed with RDD on", () => {
  const f = fx();
  try {
    commitHigh(f);
    const failing = (sub: string) => (call: Parameters<typeof runGit>[0]): ReturnType<typeof runGit> => {
      if (call.args[0] === sub) throw new SnapshotError("git_failed", `git ${sub} failed with exit code 128`, { exitCode: 128 });
      return runGit(call);
    };
    for (const sub of ["symbolic-ref", "config"]) {
      assert.deepEqual(checkDelivery({ cwd: f.repo, command: "git push" }, { dataDir: f.data, git: failing(sub) }), { allowed: true, reason: "rdd_off" }, sub);
    }
    on(f);
    git(f.repo, "config", "branch.feature.remote", "origin");
    for (const sub of ["symbolic-ref", "config"]) {
      const r = checkDelivery({ cwd: f.repo, command: "git push" }, { dataDir: f.data, git: failing(sub) });
      assert.equal(r.allowed, false, sub);
      if (!r.allowed) {
        assert.equal(r.code, "check_failed", sub);
        assert.match(r.reason, /fails? closed/i, sub);
      }
    }
  } finally {
    f.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// 5. the whole-check budget is a HARD deadline (S2/S3: with RDD on the gate fails closed; a hook that outlives its
//    timeout is treated by Claude Code as non-blocking, i.e. fail-open exactly when git is slow)
// ---------------------------------------------------------------------------------------------

/** A fake git whose matching calls sleep (stdio detached, so killing the shell returns at once). `*` matches every call. */
const slowOn = (pattern: string, seconds: number): string => `case "$*" in ${pattern}) sleep ${seconds} >/dev/null 2>&1 </dev/null;; esac`;

test("budget: many sequential slow git calls with RDD on end in check_failed within the deadline, never allowed", () => {
  const f = fx();
  const prevPath = process.env.PATH;
  try {
    commitHigh(f);
    on(f);
    fakeGit(f, slowOn("*", 1.5));
    const t0 = Date.now();
    const r = checkDelivery({ cwd: f.repo, command: "git push origin feature" }, { dataDir: f.data, deadlineMs: 3000, gitTimeoutMs: 2000 });
    const elapsed = Date.now() - t0;
    assert.equal(r.allowed, false);
    if (r.allowed) throw new Error("unreachable");
    assert.equal(r.code, "check_failed");
    assert.match(r.reason, /time budget|fails? closed/i);
    assert.match(r.reason, /This delivery command was not run\./);
    assert.ok(elapsed < 3000 + 1000, `took ${elapsed} ms for a 3000 ms budget`);
  } finally {
    process.env.PATH = prevPath;
    f.cleanup();
  }
});

test("budget: with RDD off (or a clone-local off) slow git never denies, and it also ends within the deadline", () => {
  const f = fx();
  const prevPath = process.env.PATH;
  try {
    commitHigh(f);
    fakeGit(f, slowOn("*", 1.5));
    const opts = { dataDir: f.data, deadlineMs: 3000, gitTimeoutMs: 2000 };
    const timed = (command: string): { allowed: boolean; elapsed: number } => {
      const t0 = Date.now();
      const r = checkDelivery({ cwd: f.repo, command }, opts);
      return { allowed: r.allowed, elapsed: Date.now() - t0 };
    };
    // default: off
    for (const c of ["git push origin feature", "gh pr create --fill"]) {
      const r = timed(c);
      assert.equal(r.allowed, true, `off: ${c}`);
      assert.ok(r.elapsed < 4000, `off: ${c} took ${r.elapsed} ms`);
    }
    process.env.PATH = prevPath;
    // global on, clone-local off: the override is read straight from .git when the budget runs out
    on(f);
    setReviewMode("disable", "clone", f.repo, { dataDir: f.data });
    fakeGit(f, slowOn("*", 1.5));
    const r = timed("git push origin feature");
    assert.equal(r.allowed, true, "clone off");
    assert.ok(r.elapsed < 4000, `clone off took ${r.elapsed} ms`);
  } finally {
    process.env.PATH = prevPath;
    f.cleanup();
  }
});

// One git call of each layer of the check is the slow one while the budget is short: the call must be cut at the
// deadline (not at its own, longer per-call bound). Removing the deadline from any one layer fails its row.
const LAYERS: [string, string][] = [
  ["resolveRepository: show-toplevel", "*--show-toplevel*"],
  ["resolveRepository: absolute-git-dir", "*--absolute-git-dir*"],
  ["evaluateRoot: merge-base", "*merge-base*"],
  ["evaluateRoot: rev-list", "*rev-list*"],
  ["snapshot: tree resolution (freezeSnapshot)", "*?tree?*"],
  ["risk: collectStats diff", "*diff*--raw*"],
  ["risk: numstat diff", "*diff*--numstat*"],
];
for (const [name, pattern] of LAYERS) {
  test(`budget: a slow ${name} is cut at the deadline (RDD on: check_failed; RDD off: allowed)`, () => {
    const f = fx();
    const prevPath = process.env.PATH;
    try {
      commitHigh(f);
      on(f); // before the fake git: setReviewMode itself runs git
      fakeGit(f, slowOn(pattern, 5));
      const opts = { dataDir: f.data, deadlineMs: 2000, gitTimeoutMs: 8000 };
      const off = Date.now();
      // a data dir that never had the mode switched on: RDD is off
      assert.equal(checkDelivery({ cwd: f.repo, command: "git push origin feature" }, { ...opts, dataDir: join(f.dir, "mode-never-set") }).allowed, true, "off");
      assert.ok(Date.now() - off < 3500, `off took ${Date.now() - off} ms`);
      const t0 = Date.now();
      const r = checkDelivery({ cwd: f.repo, command: "git push origin feature" }, opts);
      const elapsed = Date.now() - t0;
      assert.equal(r.allowed === false && r.code, "check_failed", name);
      assert.ok(elapsed < 3500, `${name}: took ${elapsed} ms for a 2000 ms budget (per-call bound 8000 ms)`);
    } finally {
      process.env.PATH = prevPath;
      f.cleanup();
    }
  });
}

test("budget: a spent budget starts no git at all (a fake git that records its calls is never run)", () => {
  const f = fx();
  const prevPath = process.env.PATH;
  try {
    commitHigh(f);
    on(f);
    const log = join(f.dir, "calls.log");
    fakeGit(f, `echo "$*" >> ${log}`);
    const r = checkDelivery({ cwd: f.repo, command: "git push origin feature" }, { dataDir: f.data, deadlineMs: -1 });
    assert.equal(r.allowed === false && r.code, "check_failed");
    assert.equal(existsSync(log), false, "git was started after the budget was spent");
  } finally {
    process.env.PATH = prevPath;
    f.cleanup();
  }
});

test("budget: no deadline given keeps the previous behavior for resolveRepository, the mode read and the assessment; a spent one starts no git", () => {
  const f = fx();
  try {
    commitHigh(f);
    on(f);
    assert.equal(resolveRepository(f.repo).root, f.repo);
    assert.equal(readReviewMode(f.repo, { dataDir: f.data }).effective, "on");
    assert.equal(assessCandidate(f.repo, { kind: "base-diff", baseRef: "origin/main" }).status, "assessed");
    assert.throws(() => resolveRepository(f.repo, { deadlineAt: Date.now() - 1 }), (e: unknown) => e instanceof SnapshotError && e.code === "git_timeout");
    assert.throws(() => assessCandidate(f.repo, { kind: "base-diff", baseRef: "origin/main" }, { deadlineAt: Date.now() - 1 }), (e: unknown) => e instanceof SnapshotError && e.code === "git_timeout");
    assert.equal(checkDelivery({ cwd: f.repo, command: "git push origin feature" }, { dataDir: f.data }).allowed, false);
  } finally {
    f.cleanup();
  }
});

test("budget: the default budget leaves at least 5 s under the hook timeout in hooks.json (Node startup, kill latency, output)", () => {
  const hooks = JSON.parse(readFileSync(join(PLUGIN_ROOT, "hooks", "hooks.json"), "utf8")) as { hooks: { PreToolUse: { matcher: string; hooks: { timeout?: number }[] }[] } };
  const timeoutS = hooks.hooks.PreToolUse.find((h) => h.matcher === "Bash")?.hooks[0]?.timeout;
  assert.equal(typeof timeoutS, "number");
  assert.ok(DEFAULT_BUDGET_MS + 5000 <= (timeoutS as number) * 1000, `budget ${DEFAULT_BUDGET_MS} ms vs hook timeout ${timeoutS} s`);
});

test("budget, end to end: dist/hooks/run.js PreToolUse denies before the budget plus a margin when git is slow (RDD on), and stays silent with RDD off", async () => {
  const f = fx();
  try {
    commitHigh(f);
    const bin = join(f.dir, "bin");
    mkdirSync(bin, { recursive: true });
    const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
    writeFileSync(join(bin, "git"), `#!/bin/sh\n${slowOn("*", 1.5)}\nexec ${realGit} "$@"\n`, { mode: 0o755 });
    const run = join(PLUGIN_ROOT, "dist", "hooks", "run.js");
    const one = (budget: string | undefined, slow: boolean): Promise<{ code: number | null; out: string; ms: number }> =>
      new Promise((resolve) => {
        const t0 = Date.now();
        const env: NodeJS.ProcessEnv = { ...ENV, CLAUDE_PLUGIN_DATA: f.data };
        if (slow) env.PATH = `${bin}:${ENV.PATH ?? ""}`;
        if (budget !== undefined) env.ODD_CLAUDE_GATE_BUDGET_MS = budget;
        const c = spawn(process.execPath, [run, "PreToolUse"], { env, stdio: ["pipe", "pipe", "pipe"] });
        let out = "";
        c.stdout.on("data", (d: Buffer) => (out += d.toString()));
        c.on("close", (code) => resolve({ code, out, ms: Date.now() - t0 }));
        c.stdin.end(JSON.stringify({ session_id: "b", cwd: f.repo, tool_name: "Bash", tool_input: { command: "git push origin feature" } }));
      });
    const off = await one("2000", true);
    assert.deepEqual({ code: off.code, out: off.out }, { code: 0, out: "" }, "RDD off is silent");
    assert.ok(off.ms < 2000 + 2500, `off took ${off.ms} ms`);
    on(f);
    const r = await one("2000", true);
    assert.equal(r.code, 0);
    const reason = JSON.parse(r.out).hookSpecificOutput;
    assert.equal(reason.permissionDecision, "deny");
    assert.match(reason.permissionDecisionReason, /fails? closed|time budget/i);
    assert.ok(r.ms < 2000 + 2500, `took ${r.ms} ms for a 2000 ms budget`);
    // the variable only SHORTENS the budget: garbage, zero and huge values are ignored/clamped (fast git: the normal denial)
    for (const bad of ["0", "-5", "abc", "1e9", "99999999999"]) {
      const q = await one(bad, false);
      assert.equal(JSON.parse(q.out).hookSpecificOutput.permissionDecision, "deny", `budget ${JSON.stringify(bad)} with a fast git`);
      assert.ok(q.ms < 10_000);
    }
  } finally {
    f.cleanup();
  }
});
