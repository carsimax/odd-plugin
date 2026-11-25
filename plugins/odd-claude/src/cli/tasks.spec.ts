import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lintFeatureDocs, renderTasksLint, TASKS_LINT_SCHEMA } from "../lib/feature-doc.js";
import { tasksCli } from "./tasks.js";

const git = (cwd: string, ...a: string[]) =>
  execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const DOC = (branch: string, tasks: string, log = "- L1: request\n- L2: T1 evidence") => `# Feature
Goal. Branch: \`${branch}\`.

## Specs

- **S1** one

## Tasks

${tasks}

## Log

${log}
`;

/** A temp git repo on `main` with one commit; `feat/live` has its own commit, `feat/merged` is merged into main, `feat/fresh` sits at main's tip. */
function fixture(docs: Record<string, string>): { root: string; done: () => void } {
  const root = mkdtempSync(join(tmpdir(), "odd-tlint-"));
  git(root, "init", "-q", "-b", "main");
  mkdirSync(join(root, "odd", "tasks"), { recursive: true });
  writeFileSync(join(root, "f.txt"), "0");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  git(root, "checkout", "-q", "-b", "feat/live");
  writeFileSync(join(root, "f.txt"), "1");
  git(root, "commit", "-q", "-am", "live");
  git(root, "checkout", "-q", "main");
  git(root, "checkout", "-q", "-b", "feat/merged");
  writeFileSync(join(root, "f.txt"), "2");
  git(root, "commit", "-q", "-am", "merged");
  git(root, "checkout", "-q", "main");
  git(root, "merge", "-q", "--no-ff", "-m", "merge", "feat/merged");
  git(root, "branch", "feat/fresh");
  for (const [n, t] of Object.entries(docs)) writeFileSync(join(root, "odd", "tasks", n), t);
  return { root, done: () => rmSync(root, { recursive: true, force: true }) };
}

const OPEN = "- T1 | S1 | worker | pending — x; done when: spec passes";

test("a healthy document on a live branch has no finding", () => {
  const f = fixture({ "ok.md": DOC("feat/live", OPEN), "fresh.md": DOC("feat/fresh", OPEN) });
  try {
    const l = lintFeatureDocs(f.root)!;
    assert.deepEqual(l.findings, []);
    assert.equal(l.files, 2);
    assert.equal(renderTasksLint(l), "Feature documents: 2, findings: 0");
  } finally {
    f.done();
  }
});

test("open tasks on a branch that is merged or gone are reported with file, line and a fix", () => {
  const f = fixture({ "gone.md": DOC("feat/gone", OPEN), "merged.md": DOC("feat/merged", OPEN) });
  try {
    const l = lintFeatureDocs(f.root)!;
    assert.deepEqual(l.findings.map((x) => [x.file, x.line, x.rule]), [
      ["odd/tasks/gone.md", 2, "open-tasks-on-closed-branch"],
      ["odd/tasks/merged.md", 2, "open-tasks-on-closed-branch"],
    ]);
    assert.match(l.findings[0]!.message, /no longer exists locally.*mark finished tasks done/);
    assert.match(l.findings[1]!.message, /already merged into main/);
  } finally {
    f.done();
  }
});

test("a closed branch with every task done is not reported", () => {
  const f = fixture({ "d.md": DOC("feat/gone", "- T1 | S1 | worker | done — x") });
  try {
    assert.deepEqual(lintFeatureDocs(f.root)!.findings, []);
  } finally {
    f.done();
  }
});

test("the default branch comes from origin/HEAD when set", () => {
  const f = fixture({ "m.md": DOC("feat/merged", OPEN) });
  try {
    git(f.root, "branch", "trunk", "main");
    git(f.root, "update-ref", "refs/remotes/origin/trunk", "main");
    git(f.root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
    git(f.root, "branch", "-m", "main", "other");
    const l = lintFeatureDocs(f.root)!;
    assert.match(l.findings[0]!.message, /already merged into trunk/);
  } finally {
    f.done();
  }
});

test("done without a log entry, open without done when, and missing sections", () => {
  const tasks = ["- T1 | S1 | worker | done — shipped", "- T2 | S1 | worker | pending — no check"].join("\n");
  const f = fixture({ "a.md": DOC("feat/live", tasks, "- L1: T2 only"), "b.md": "# Bare\nBranch: `feat/live`.\n" });
  try {
    const l = lintFeatureDocs(f.root)!;
    const by = (file: string) => l.findings.filter((x) => x.file.endsWith(file)).map((x) => [x.line, x.rule]);
    assert.deepEqual(by("a.md"), [[10, "done-without-log"], [11, "open-without-done-when"]]);
    assert.deepEqual(by("b.md"), [[1, "missing-section"], [1, "missing-section"], [1, "missing-section"]]);
    const msgs = l.findings.map((x) => x.message).join("\n");
    assert.match(msgs, /T1 is marked done but never appears in ## Log; append a Log entry/);
    assert.match(msgs, /no `done when: <observable check>`; append/);
    assert.match(msgs, /no "## Specs" section; add it/);
  } finally {
    f.done();
  }
});

test("the CLI prints text, --json with the schema, honors --cwd, exits 0 and never throws", () => {
  const f = fixture({ "gone.md": DOC("feat/gone", OPEN) });
  try {
    const t = tasksCli(["--cwd", f.root]);
    assert.equal(t.exitCode, 0);
    assert.match(t.stdout, /^Feature documents: 1, findings: 1\nodd\/tasks\/gone\.md:2 open-tasks-on-closed-branch: /);
    const j = JSON.parse(tasksCli(["--json", "--cwd", f.root]).stdout);
    assert.equal(j.schema, TASKS_LINT_SCHEMA);
    assert.equal(j.schema, "odd-claude.tasks-lint/v1");
    assert.equal(j.files, 1);
    assert.deepEqual(Object.keys(j.findings[0]).sort(), ["file", "line", "message", "rule"]);
    const none = tasksCli(["--json"], () => undefined);
    assert.equal(none.exitCode, 0);
    assert.equal(JSON.parse(none.stdout).note, "No odd/tasks directory in a git repository; nothing to lint.");
    const boom = tasksCli([], () => {
      throw new Error("x");
    });
    assert.equal(boom.exitCode, 0);
  } finally {
    f.done();
  }
});
