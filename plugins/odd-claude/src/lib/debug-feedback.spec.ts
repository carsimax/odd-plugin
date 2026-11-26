import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p: string): string => readFileSync(join(root, p), "utf8");

const split = (p: string): { fm: string; body: string } => {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(read(p));
  assert.ok(m, `${p} has frontmatter`);
  return { fm: m[1] ?? "", body: m[2] ?? "" };
};

// A rule is pinned by a literal phrase that occurs exactly once in its file, so removing the rule breaks the test.
const pin = (file: string, phrases: string[]): void => {
  const s = read(file);
  for (const p of phrases) assert.equal(s.split(p).length - 1, 1, `${file}: exactly one "${p}"`);
};

const DEBUG = "skills/systematic-debugging/SKILL.md";
const REVIEW = "skills/receiving-review/SKILL.md";

for (const dir of ["systematic-debugging", "receiving-review"]) {
  test(`skill ${dir}: frontmatter matches dir, MIT, one-line Trigger description, small body`, () => {
    const { fm, body } = split(`skills/${dir}/SKILL.md`);
    assert.match(fm, new RegExp(`^name: ${dir}$`, "m"));
    assert.match(fm, /^license: MIT$/m);
    const desc = fm.split("\n").filter((l) => l.startsWith("description:"));
    assert.equal(desc.length, 1);
    assert.match(desc[0] ?? "", /^description: "Trigger:/);
    const words = body.split(/\s+/).filter(Boolean).length;
    assert.ok(words <= 750, `${dir} body has ${words} words`);
  });
}

test("systematic-debugging: description carries the trigger words", () => {
  const { fm } = split(DEBUG);
  for (const t of ["bug", "failing test", "test failure", "unexpected behavior", "build failure", "flaky test", "regression", "depurar"]) {
    assert.ok(fm.includes(t), t);
  }
});

test("systematic-debugging: root cause before fix, qualifier, preserve evidence", () => {
  pin(DEBUG, [
    "No fix, and no fix proposal presented as the answer, before the root cause is named with observed evidence",
    "Listing candidate hypotheses or options when the human asks is fine",
    "stop adding features or changes; preserve the error output first",
  ]);
});

test("systematic-debugging: reproduce and widen the evidence", () => {
  pin(DEBUG, ["Reproduce it.", "record the conditions and widen the evidence (timing, environment, state)"]);
});

test("systematic-debugging: localize at boundaries, bisect, trace back and fix at the source", () => {
  pin(DEBUG, [
    "instrument component boundaries to see where good data turns bad",
    "use `git bisect` for regressions",
    "trace a bad value backward to where it originates",
    "fix there, not where it surfaces",
  ]);
});

test("systematic-debugging: one hypothesis, one variable, no stacked fixes", () => {
  pin(DEBUG, [
    "One written hypothesis at a time",
    "tested with the smallest change and one variable",
    "A failed hypothesis means a new hypothesis, never stacked fixes",
  ]);
});

test("systematic-debugging: fix with a regression test seen failing, completion gate, no drive-by refactors", () => {
  pin(DEBUG, [
    "a regression test seen failing without it, then passing",
    'see "Completion gate" section of the `odd` skill',
    "No drive-by refactors",
  ]);
});

test("systematic-debugging: three failed attempts stop and go to the human", () => {
  pin(DEBUG, [
    "Three failed fix attempts: stop, do not try a fourth",
    "bring the architecture question and the evidence to the human",
    "AskUserQuestion when available",
    "a delegated worker must return `partial`",
  ]);
});

test("systematic-debugging: wait for the condition, timing exception", () => {
  pin(DEBUG, ["Wait for the condition, not a fixed sleep", "unless timing itself is the behavior under test"]);
});

test("systematic-debugging: no-root-cause outcome with list, handling and logging", () => {
  pin(DEBUG, [
    "No root cause found is valid only with the list of what was investigated",
    "plus handling and logging so the next occurrence is diagnosable",
  ]);
});

test("systematic-debugging: authorized suite, not a blanket suite run", () => {
  pin(DEBUG, ["run the authorized suite and checks"]);
});

test("systematic-debugging: red-flags list has at least four bullets", () => {
  const s = read(DEBUG);
  const m = /^## Red flags\n([\s\S]*?)(?=^## )/m.exec(s);
  assert.ok(m, "Red flags section");
  const bullets = (m?.[1] ?? "").split("\n").filter((l) => l.startsWith("- "));
  assert.ok(bullets.length >= 4, `${bullets.length} bullets`);
});

test("systematic-debugging: references/techniques.md exists, is linked and covers the techniques", () => {
  pin(DEBUG, ["`references/techniques.md`: backward tracing"]);
  assert.ok(existsSync(join(root, "skills/systematic-debugging/references/techniques.md")));
  const t = read("skills/systematic-debugging/references/techniques.md");
  for (const h of ["Backward tracing", "Boundary instrumentation", "Bisection", "Defense in depth", "Condition-based waiting"]) {
    assert.ok(t.includes(h), h);
  }
});

test("receiving-review: description carries the trigger words", () => {
  const { fm } = split(REVIEW);
  for (const t of ["review feedback", "PR comments", "address comments", "requested changes", "reviewer findings", "Copilot review", "atender comentarios"]) {
    assert.ok(fm.includes(t), t);
  }
});

test("receiving-review: scope and fix flows of the other reviewers stay theirs", () => {
  pin(REVIEW, ["does not replace the fix flows of Judgment Day or 4r-review"]);
});

test("receiving-review: clarify before implementing, verify against the code", () => {
  pin(REVIEW, [
    "Read every item before acting",
    "ask about it before implementing any item",
    "Verify each item against the current code before accepting it",
    "why is the code this way",
  ]);
});

test("receiving-review: source trust, prior human decision", () => {
  pin(REVIEW, [
    "the human's feedback is trusted, though ask when its scope is unclear",
    "are claims to verify",
    "conflicts with a prior human decision goes back to the human",
  ]);
});

test("receiving-review: YAGNI usage search, evidence pushback, ask when unverifiable", () => {
  pin(REVIEW, [
    "YAGNI check",
    "search for real usage",
    "Push back with technical evidence",
    "say what is missing and ask",
  ]);
});

test("receiving-review: order, one item at a time in the batch, authorized checks", () => {
  pin(REVIEW, [
    "clarifications first, then blocking issues, then simple fixes, then complex ones",
    "One item at a time within the correction batch, each with its check",
    "run the authorized suite and checks",
  ]);
});

test("receiving-review: replies state the change, no performative agreement, own mistakes in one line", () => {
  pin(REVIEW, [
    "No performative agreement",
    "You're absolutely right",
    "State what changed and where, or the evidence for declining",
    "say so in one line and fix it",
  ]);
});

test("receiving-review: GitHub inline comments answered in their thread, wording and language", () => {
  pin(REVIEW, [
    "in its thread",
    "pulls/{pr}/comments/{id}/replies",
    "/comment-writer",
    "the thread's language",
  ]);
});

test("odd-worker: bug-fix rule with root cause first and a counted three-attempt partial", () => {
  pin("agents/odd-worker.md", [
    "reproduce it and name the root cause from observed evidence before changing code",
    "after three failed fix attempts, counting the first fix, stop",
    "return `partial` with the evidence instead of a fourth attempt",
  ]);
});

test("cards/skills.md: both skill hints", () => {
  const s = read("cards/skills.md");
  assert.match(s, /`\/systematic-debugging`/);
  assert.match(s, /`\/receiving-review`/);
});

test("README lists both skills in both lists", () => {
  const lines = read("README.md").split("\n");
  for (const marker of ["**Commands / skills**", "**Skills** ("]) {
    const l = lines.find((x) => x.includes(marker)) ?? "";
    assert.ok(l.includes("`systematic-debugging`"), `${marker} systematic-debugging`);
    assert.ok(l.includes("`receiving-review`"), `${marker} receiving-review`);
  }
});

test("card sources: attribution rows for the new skills", () => {
  const s = read("cards/SOURCES.md");
  assert.match(s, /skills\/systematic-debugging\//);
  assert.match(s, /skills\/receiving-review\//);
  assert.match(s, /debugging-and-error-recovery/);
  assert.match(s, /receiving-code-review/);
});

test("output style stays unchanged: no mention of the new skills", () => {
  const s = read("output-styles/odd.md");
  assert.doesNotMatch(s, /systematic-debugging/);
  assert.doesNotMatch(s, /receiving-review/);
});
