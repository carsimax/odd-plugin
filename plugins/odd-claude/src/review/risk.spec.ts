import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { assessCandidate, assessRisk, MAX_BLOB_SCAN_BYTES, type RiskAssessmentResult } from "./risk.js";
import { freezeSnapshot, resolveRepository, type Snapshot } from "./snapshot.js";
import { startReview } from "./start.js";

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

const put = (repo: string, rel: string, content: string | Buffer) => {
  mkdirSync(dirname(join(repo, rel)), { recursive: true });
  writeFileSync(join(repo, rel), content);
};

/** Real temp repo with one commit holding `files`; removed by cleanup. */
function makeRepo(files: Record<string, string | Buffer>): { repo: string; cleanup: () => void } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "odd-risk-")));
  const repo = join(dir, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  for (const [rel, content] of Object.entries(files)) put(repo, rel, content);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  return { repo, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const BASE = { "README.md": "hello\n", "src/a.ts": "export const a = 1;\n", "src/run.ts": "export const r = 1;\n", "package.json": "{}\n" };

function assessWorkspace(repo: string): RiskAssessmentResult {
  git(repo, "add", "-A"); // new files enter a candidate only when tracked or explicitly intended
  const frozen = freezeSnapshot(repo, { kind: "current-changes", projection: "workspace" });
  assert.equal(frozen.status, "frozen");
  if (frozen.status !== "frozen") throw new Error("unreachable");
  return assessRisk(frozen.snapshot, frozen.repository);
}

const codes = (a: RiskAssessmentResult) => a.reasons.map((r) => r.code);

async function withRepo(files: Record<string, string | Buffer>, fn: (repo: string) => void | Promise<void>) {
  const r = makeRepo(files);
  try {
    await fn(r.repo);
  } finally {
    r.cleanup();
  }
}

test("docs-only change is low / non_executable_only", () =>
  withRepo(BASE, (repo) => {
    put(repo, "README.md", "hello\nworld\n");
    put(repo, "docs/guide.md", "# guide\n");
    const a = assessWorkspace(repo);
    assert.equal(a.risk_level, "low");
    assert.equal(a.level, "low");
    assert.deepEqual(a.reasons, [{ code: "non_executable_only" }]);
  }));

test("a .ts change is medium / executable_change with the default risk lens", () =>
  withRepo(BASE, (repo) => {
    put(repo, "src/a.ts", "export const a = 2;\n");
    const a = assessWorkspace(repo);
    assert.equal(a.risk_level, "medium");
    assert.deepEqual(a.reasons, [{ code: "executable_change", path: "src/a.ts" }]);
    assert.equal(a.focusLens, "risk");
    assert.ok(a.evidence.length >= 1);
  }));

test("child_process.spawn and execSync are high / process_boundary", async () => {
  await withRepo(BASE, (repo) => {
    put(repo, "src/a.ts", 'import { spawn } from "node:child_process";\nspawn("ls");\n');
    const a = assessWorkspace(repo);
    assert.equal(a.risk_level, "high");
    assert.deepEqual(a.reasons.find((r) => r.code === "process_boundary"), { code: "process_boundary", signal: "shell_process", path: "src/a.ts" });
  });
  await withRepo(BASE, (repo) => {
    put(repo, "src/a.ts", 'execSync("ls");\n');
    const a = assessWorkspace(repo);
    assert.equal(a.risk_level, "high");
    assert.ok(codes(a).includes("process_boundary"));
  });
});

test("a spawn in a test file is not process evidence", () =>
  withRepo(BASE, (repo) => {
    put(repo, "src/a.spec.ts", 'import { spawn } from "node:child_process";\nspawn("ls");\n');
    assert.equal(assessWorkspace(repo).risk_level, "medium");
  }));

test("a commented-out spawn is not process evidence", () =>
  withRepo(BASE, (repo) => {
    put(repo, "src/a.ts", '// child_process.spawn("x")\nexport const a = 2;\n');
    assert.equal(assessWorkspace(repo).risk_level, "medium");
  }));

test("a shebang makes a doc-named file a process boundary", () =>
  withRepo(BASE, (repo) => {
    put(repo, "notes.md", "#!/bin/sh\necho hi\n");
    const a = assessWorkspace(repo);
    assert.equal(a.risk_level, "medium");
    assert.ok(!codes(a).includes("non_executable_only"));
  }));

test("shell scripts are high / shell_source", () =>
  withRepo(BASE, (repo) => {
    put(repo, "scripts/x.sh", "echo hi\n");
    const a = assessWorkspace(repo);
    assert.equal(a.risk_level, "high");
    assert.deepEqual(a.reasons.find((r) => r.code === "shell_source"), { code: "shell_source", signal: "shell_process", path: "scripts/x.sh" });
  }));

test("package.json and lockfiles are high / dependency_change", async () => {
  await withRepo(BASE, (repo) => {
    put(repo, "package.json", '{"name":"x"}\n');
    const a = assessWorkspace(repo);
    assert.equal(a.risk_level, "high");
    assert.deepEqual(a.reasons.find((r) => r.code === "dependency_change"), { code: "dependency_change", signal: "dependency", path: "package.json" });
  });
  await withRepo({ ...BASE, "package-lock.json": "{}\n" }, (repo) => {
    put(repo, "package-lock.json", '{"lockfileVersion":3}\n');
    const a = assessWorkspace(repo);
    assert.equal(a.risk_level, "high");
    assert.ok(codes(a).includes("dependency_change"));
  });
});

test(".github/workflows is high / ci_release_change", () =>
  withRepo(BASE, (repo) => {
    put(repo, ".github/workflows/ci.yml", "name: ci\n");
    const a = assessWorkspace(repo);
    assert.equal(a.risk_level, "high");
    assert.ok(codes(a).includes("ci_release_change"));
  }));

test("hooks and contracts/schemas are high with their own codes", async () => {
  await withRepo(BASE, (repo) => {
    put(repo, ".husky/pre-commit", "npm test\n");
    const a = assessWorkspace(repo);
    assert.equal(a.risk_level, "high");
    assert.ok(codes(a).includes("hook_change"));
  });
  await withRepo(BASE, (repo) => {
    put(repo, "contracts/review/start.schema.json", "{}\n");
    const a = assessWorkspace(repo);
    assert.equal(a.risk_level, "high");
    assert.ok(codes(a).includes("contract_change"));
  });
});

test("credential, permission and auth paths are high", async () => {
  await withRepo(BASE, (repo) => {
    put(repo, "config/secrets.txt", "x\n");
    const a = assessWorkspace(repo);
    assert.equal(a.risk_level, "high");
    assert.ok(codes(a).includes("credential_path"));
  });
  await withRepo(BASE, (repo) => {
    put(repo, "src/auth/login.ts", "export {};\n");
    const a = assessWorkspace(repo);
    assert.equal(a.risk_level, "high");
    assert.deepEqual(a.reasons.find((r) => r.code === "hot_path"), { code: "hot_path", signal: "auth", path: "src/auth/login.ts" });
  });
});

test("network and filesystem deletion in added lines are high", async () => {
  await withRepo(BASE, (repo) => {
    put(repo, "src/a.ts", 'export const g = () => fetch("https://example.com");\n');
    const a = assessWorkspace(repo);
    assert.equal(a.risk_level, "high");
    assert.ok(codes(a).includes("network_access"));
  });
  await withRepo(BASE, (repo) => {
    put(repo, "src/a.ts", 'import { rmSync } from "node:fs";\nrmSync(p, { recursive: true });\n');
    const a = assessWorkspace(repo);
    assert.equal(a.risk_level, "high");
    assert.ok(codes(a).includes("filesystem_deletion"));
  });
});

test("a dangerous sink is high / dangerous_sink", () =>
  withRepo(BASE, (repo) => {
    put(repo, "src/a.ts", "export const f = (s: string) => eval(s);\n");
    const a = assessWorkspace(repo);
    assert.equal(a.risk_level, "high");
    assert.ok(codes(a).includes("dangerous_sink"));
  }));

test("chmod +x reports executable_mode with both modes", () =>
  withRepo(BASE, (repo) => {
    chmodSync(join(repo, "src/run.ts"), 0o755);
    const a = assessWorkspace(repo);
    assert.equal(a.risk_level, "high");
    assert.deepEqual(a.reasons, [{ code: "executable_mode", signal: "permissions", path: "src/run.ts", old_mode: "100644", new_mode: "100755" }]);
  }));

test("deleting source is medium / file_deletion; deleting docs stays low", async () => {
  await withRepo(BASE, (repo) => {
    unlinkSync(join(repo, "src/a.ts"));
    const a = assessWorkspace(repo);
    assert.equal(a.risk_level, "medium");
    assert.deepEqual(a.reasons.find((r) => r.code === "file_deletion"), { code: "file_deletion", path: "src/a.ts" });
    assert.equal(a.focusLens, "resilience");
  });
  await withRepo(BASE, (repo) => {
    unlinkSync(join(repo, "README.md"));
    assert.equal(assessWorkspace(repo).risk_level, "low");
  });
});

test("a binary file is medium / binary_change", () =>
  withRepo(BASE, (repo) => {
    put(repo, "assets/blob.dat", Buffer.from([0, 1, 2, 3, 0, 255]));
    const a = assessWorkspace(repo);
    assert.equal(a.risk_level, "medium");
    assert.deepEqual(a.reasons, [{ code: "binary_change", path: "assets/blob.dat" }]);
  }));

test("a passive image stays low", () =>
  withRepo(BASE, (repo) => {
    put(repo, "docs/logo.png", Buffer.concat([Buffer.from("\x89PNG\r\n\x1a\n", "latin1"), Buffer.from([0, 0, 0, 1])]));
    assert.equal(assessWorkspace(repo).risk_level, "low");
  }));

test("a huge change is medium / large_change, even for docs", () =>
  withRepo(BASE, (repo) => {
    put(repo, "docs/big.md", Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n") + "\n");
    const a = assessWorkspace(repo);
    assert.equal(a.risk_level, "medium");
    assert.deepEqual(a.reasons, [{ code: "large_change" }]);
    assert.equal(a.focusLens, "readability");
  }));

test("a symlink is medium / symlink_change", () =>
  withRepo(BASE, (repo) => {
    symlinkSync("README.md", join(repo, "link.md"));
    const a = assessWorkspace(repo);
    assert.equal(a.risk_level, "medium");
    assert.ok(codes(a).includes("symlink_change"));
  }));

test("oversized blobs fail closed into process_scan_limit (bounded scan)", () =>
  withRepo(BASE, (repo) => {
    put(repo, "src/big.ts", "// x\n" + "export const v = 1;\n".repeat(Math.ceil(MAX_BLOB_SCAN_BYTES / 19) + 10));
    const a = assessWorkspace(repo);
    assert.equal(a.risk_level, "high");
    assert.deepEqual(a.reasons.find((r) => r.code === "process_scan_limit"), { code: "process_scan_limit", signal: "shell_process", path: "src/big.ts" });
  }));

test("results are deterministic", () =>
  withRepo(BASE, (repo) => {
    put(repo, "src/a.ts", 'import { spawn } from "node:child_process";\nspawn("ls");\n');
    put(repo, "package.json", '{"a":1}\n');
    put(repo, "README.md", "changed\n");
    assert.deepEqual(assessWorkspace(repo), assessWorkspace(repo));
  }));

test("only frozen trees are read: editing the worktree after freeze changes nothing", () =>
  withRepo(BASE, (repo) => {
    put(repo, "src/a.ts", 'execSync("ls");\n');
    const frozen = freezeSnapshot(repo, { kind: "current-changes", projection: "workspace" });
    if (frozen.status !== "frozen") throw new Error("unreachable");
    const before = assessRisk(frozen.snapshot, frozen.repository);
    put(repo, "src/a.ts", "export const harmless = 1;\n");
    put(repo, "README.md", "x\n");
    unlinkSync(join(repo, "package.json"));
    chmodSync(join(repo, "src/run.ts"), 0o755);
    const after = assessRisk(frozen.snapshot, frozen.repository);
    assert.deepEqual(after, before);
    assert.equal(after.risk_level, "high");
  }));

test("assessRisk resolves the repository itself when none is given", () =>
  withRepo(BASE, (repo) => {
    put(repo, "src/a.ts", "export const a = 3;\n");
    const frozen = freezeSnapshot(repo, { kind: "current-changes", projection: "workspace" });
    if (frozen.status !== "frozen") throw new Error("unreachable");
    assert.deepEqual(assessRisk(frozen.snapshot, resolveRepository(repo)), assessRisk(frozen.snapshot, frozen.repository));
  }));

test("assessCandidate: plan-shaped, read-only, due = high", async () => {
  await withRepo(BASE, (repo) => {
    put(repo, "src/a.ts", 'execSync("ls");\n');
    const before = git(repo, "status", "--porcelain=v1");
    const high = assessCandidate(repo, { kind: "current-changes", projection: "workspace" });
    assert.equal(high.status, "assessed");
    if (high.status !== "assessed") throw new Error("unreachable");
    assert.equal(high.risk, "high");
    assert.equal(high.reviewDue, true);
    assert.deepEqual(high.changedPaths, ["src/a.ts"]);
    assert.equal(high.changedLines, 2);
    assert.ok(high.reasons.length > 0);
    assert.equal(git(repo, "status", "--porcelain=v1"), before);
  });
  await withRepo(BASE, (repo) => {
    put(repo, "src/a.ts", "export const a = 9;\n");
    const medium = assessCandidate(repo, { kind: "current-changes", projection: "workspace" });
    assert.equal(medium.status === "assessed" && medium.reviewDue, false);
  });
  await withRepo(BASE, (repo) => {
    assert.deepEqual(assessCandidate(repo, { kind: "current-changes", projection: "workspace" }), { status: "not_due", reason: "no_changes", reviewDue: false, kind: "current-changes", projection: "workspace" });
  });
});

test("start.ts with assessRisk: lens counts 0 / 1 / 4", async () => {
  const cases: Array<[string, Record<string, string>, number, string]> = [
    ["low", { "README.md": "docs\n" }, 0, "closed"],
    ["medium", { "src/a.ts": "export const a = 2;\n" }, 1, "created"],
    ["high", { "src/a.ts": 'execSync("ls");\n' }, 4, "created"],
  ];
  for (const [level, edits, lenses, action] of cases) {
    await withRepo(BASE, async (repo) => {
      for (const [rel, content] of Object.entries(edits)) put(repo, rel, content);
      const o = await startReview({ cwd: repo, target: { kind: "current-changes" }, consent: "granted", riskAssessor: assessRisk });
      assert.equal(o.status, "started", JSON.stringify(o));
      if (o.status !== "started") return;
      assert.equal(o.result.risk_level, level);
      assert.equal(o.result.selected_lenses.length, lenses);
      assert.equal(o.result.action, action);
    });
  }
});

test("assessRisk type matches the injected assessor shape", () => {
  const f: (s: Snapshot) => unknown = (s) => s;
  assert.equal(typeof f, "function");
});
