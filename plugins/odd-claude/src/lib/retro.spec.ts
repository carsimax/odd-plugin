import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectRetro, renderRetro } from "./retro.js";
import { STATS_MAX_LINE_BYTES, STATS_TAIL_BYTES } from "./stats.js";
import { updateSessionState } from "./state.js";
import { retroCli } from "../cli/retro.js";

// Synthetic fixtures only, written to an OS temp dir; no real transcript, no personal data.
const tmp = (): string => mkdtempSync(join(tmpdir(), "odd-retro-"));
const j = (o: unknown): string => JSON.stringify(o);
const user = (content: unknown, extra: Record<string, unknown> = {}): string => j({ type: "user", message: { role: "user", content }, ...extra });
const use = (id: string, name: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}): string =>
  j({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] }, ...extra });
const result = (id: string, isError?: boolean, extra: Record<string, unknown> = {}): string =>
  j({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "SECRET-BODY", ...(isError === undefined ? {} : { is_error: isError }) }] }, ...extra });

function digest(lines: string[]) {
  const dir = tmp();
  try {
    const p = join(dir, "t.jsonl");
    writeFileSync(p, lines.join("\n"));
    return collectRetro(p)!;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("human prompts: only typed user records count, with 1-based line numbers", () => {
  const d = digest([
    user("first human prompt"), // 1
    use("a", "Read", { file_path: "/p/a.ts" }), // 2
    result("a"), // 3 tool result, not a prompt
    user([{ type: "text", text: "second prompt" }]), // 4
    user("reminder", { isMeta: true }), // 5
    user("compact summary", { isCompactSummary: true }), // 6
    user("sidechain prompt", { isSidechain: true }), // 7
    user("   "), // 8 empty
    user([{ type: "text", text: "x" }, { type: "tool_result", tool_use_id: "a" }]), // 9 carries a tool_result
  ]);
  assert.deepEqual(d.prompts, { count: 2, lines: [1, 4] });
  assert.equal(d.schema, "odd-claude.retro/v1");
});

test("tool counts by name; duplicated tool_use ids (streaming) count once; sidechain skipped", () => {
  const d = digest([
    use("a", "Read", { file_path: "/p/a.ts" }),
    use("a", "Read", { file_path: "/p/a.ts" }),
    use("b", "Bash", { command: "npm test" }),
    use("c", "Read", { file_path: "/p/b.ts" }),
    use("s", "Grep", { pattern: "x" }, { isSidechain: true }),
  ]);
  assert.deepEqual(d.tools, [
    { name: "Read", count: 2 },
    { name: "Bash", count: 1 },
  ]);
});

test("tool errors: is_error results report tool name and line; non-errors are not listed", () => {
  const d = digest([
    use("a", "Bash", { command: "npm test" }), // 1
    result("a", true), // 2
    use("b", "Read", { file_path: "/p/a.ts" }), // 3
    result("b", false), // 4
    use("c", "Edit", { file_path: "/p/a.ts" }), // 5
    result("c", true), // 6
    result("zzz", true), // 7 unknown id
  ]);
  assert.deepEqual(d.errors.items, [
    { tool: "Bash", line: 2 },
    { tool: "Edit", line: 6 },
    { tool: "unknown", line: 7 },
  ]);
  assert.equal(d.errors.count, 3);
});

test("files read 3+ times and edited 2+ times, with lines and main-thread flag", () => {
  const d = digest([
    use("r1", "Read", { file_path: "/p/a.ts" }), // 1
    use("r2", "Read", { file_path: "/p/a.ts" }), // 2
    use("r3", "Read", { file_path: "/p/a.ts" }), // 3
    use("r4", "Read", { file_path: "/p/b.ts" }), // 4
    use("r5", "Read", { file_path: "/p/b.ts" }), // 5
    use("e1", "Edit", { file_path: "/p/c.ts" }), // 6
    use("e2", "Write", { file_path: "/p/c.ts" }), // 7
    use("e3", "Edit", { file_path: "/p/d.ts" }), // 8
    use("e4", "Edit", { file_path: "/p/a.ts" }, { isSidechain: true }), // 9 ignored
    use("e5", "Edit", { file_path: "/p/d.ts" }, { isSidechain: true }), // 10 ignored
  ]);
  assert.deepEqual(d.rereads, [{ file: "/p/a.ts", count: 3, lines: [1, 2, 3] }]);
  assert.deepEqual(d.reedits, [{ file: "/p/c.ts", count: 2, lines: [6, 7], mainThread: true }]);
});

test("Bash commands repeated 2+ times exactly; git status, git diff, ls, pwd are exempt", () => {
  const d = digest([
    use("1", "Bash", { command: "npm test" }), // 1
    use("2", "Bash", { command: "npm test" }), // 2
    use("3", "Bash", { command: "npm  test " }), // 3 whitespace-normalized
    use("4", "Bash", { command: "git status" }),
    use("5", "Bash", { command: "git status" }),
    use("6", "Bash", { command: "git diff --stat" }),
    use("7", "Bash", { command: "git diff --stat" }),
    use("8", "Bash", { command: "ls" }),
    use("9", "Bash", { command: "ls" }),
    use("10", "Bash", { command: "pwd" }),
    use("11", "Bash", { command: "pwd" }),
    use("12", "Bash", { command: "npm run build" }),
    use("13", "Bash", { command: "git statusx" }),
    use("14", "Bash", { command: "git statusx" }),
  ]);
  assert.deepEqual(d.repeatedCommands, [
    { command: "npm test", count: 3, lines: [1, 2, 3] },
    { command: "git statusx", count: 2, lines: [13, 14] },
  ]);
});

test("Agent/Task launches by subagent_type and model; odd-worker without allowed edit surfaces is flagged", () => {
  const d = digest([
    use("1", "Agent", { subagent_type: "odd-claude:odd-worker", model: "sonnet", prompt: "do it" }), // 1 flagged
    use("2", "Task", { subagent_type: "odd-claude:odd-worker", prompt: "x\n## Allowed edit surfaces\n- a" }), // 2 ok
    use("3", "Agent", { subagent_type: "Explore", model: "haiku", prompt: "look" }), // 3 not a worker
    use("4", "Agent", { prompt: "no type" }), // 4
  ]);
  assert.deepEqual(d.agents, [
    { line: 1, subagentType: "odd-claude:odd-worker", model: "sonnet", missingEditSurfaces: true },
    { line: 2, subagentType: "odd-claude:odd-worker", model: "", missingEditSurfaces: false },
    { line: 3, subagentType: "Explore", model: "haiku", missingEditSurfaces: false },
    { line: 4, subagentType: "", model: "", missingEditSurfaces: false },
  ]);
});

test("compaction records, first source write and first feature-document write", () => {
  const d = digest([
    use("1", "Read", { file_path: "/p/a.ts" }), // 1
    j({ type: "system", subtype: "compact_boundary" }), // 2
    user("summary", { isCompactSummary: true }), // 3
    use("2", "Write", { file_path: "/p/odd/tasks/feat.md" }), // 4 feature doc
    use("3", "Edit", { file_path: "/p/src/a.ts" }), // 5 first source write
    use("4", "Edit", { file_path: "/p/odd/tasks/feat.md" }), // 6
  ]);
  assert.deepEqual(d.compactions, [2, 3]);
  assert.equal(d.firstSourceWrite, 5);
  assert.equal(d.firstFeatureDoc, 4);
  const none = digest([use("1", "Read", { file_path: "/p/a.ts" })]);
  assert.equal(none.firstSourceWrite, undefined);
  assert.equal(none.firstFeatureDoc, undefined);
  assert.deepEqual(none.compactions, []);
});

test("malformed, non-object, field-less and oversized lines are skipped without shifting line numbers", () => {
  const huge = j({ type: "user", message: { content: "h".repeat(STATS_MAX_LINE_BYTES + 10) } });
  const d = digest([
    "not json", // 1
    "42", // 2
    "null", // 3
    j({ type: "assistant", message: { content: [{ type: "tool_use" }, null, "x", { type: "tool_use", id: "k", name: "Read", input: null }] } }), // 4
    huge, // 5
    j({ type: "user" }), // 6
    user("real prompt"), // 7
  ]);
  assert.deepEqual(d.prompts, { count: 1, lines: [7] });
  assert.deepEqual(d.tools, [{ name: "Read", count: 1 }]);
  assert.equal(d.lines, 7);
});

test("strings are control-character cleaned and capped at 160; bodies are never printed", () => {
  const cmd = "echo " + "x".repeat(300);
  const d = digest([
    user("PROMPT-BODY-TEXT"),
    use("1", "Bash", { command: cmd }),
    use("2", "Bash", { command: cmd }),
    use("3", "Read", { file_path: "/p/\u001b[31mred\u0007‮.ts" }),
    use("4", "Read", { file_path: "/p/\u001b[31mred\u0007‮.ts" }),
    use("5", "Read", { file_path: "/p/\u001b[31mred\u0007‮.ts" }),
    result("1", true),
  ]);
  assert.equal(d.repeatedCommands[0]?.command.length, 160);
  assert.equal(d.rereads[0]?.file, "/p/red.ts");
  const text = renderRetro(d);
  const json = JSON.stringify(d);
  for (const out of [text, json]) {
    assert.ok(!out.includes("PROMPT-BODY-TEXT"));
    assert.ok(!out.includes("SECRET-BODY"));
    // eslint-disable-next-line no-control-regex
    assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f‮]/.test(out));
  }
});

test("tail cap: a large transcript reports truncated and reads at most the tail", () => {
  const dir = tmp();
  try {
    const p = join(dir, "t.jsonl");
    const line = user("p".repeat(1000)) + "\n";
    writeFileSync(p, line.repeat(Math.ceil((STATS_TAIL_BYTES + 5000) / line.length)));
    const d = collectRetro(p)!;
    assert.equal(d.truncated, true);
    assert.ok(d.bytesRead <= STATS_TAIL_BYTES);
    assert.match(renderRetro(d), /partial: only the last/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unreadable, missing and FIFO transcripts give undefined without hanging", () => {
  const dir = tmp();
  try {
    assert.equal(collectRetro(join(dir, "missing.jsonl")), undefined);
    const fifo = join(dir, "f.jsonl");
    assert.equal(spawnSync("mkfifo", [fifo]).status, 0);
    assert.equal(collectRetro(fifo), undefined);
    assert.equal(collectRetro(dir), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("renderRetro prints the sections with line numbers", () => {
  const d = digest([user("hi"), use("1", "Bash", { command: "npm test" }), use("2", "Bash", { command: "npm test" }), result("2", true)]);
  const t = renderRetro(d);
  assert.match(t, /^odd-claude retro \(local transcript digest\)/);
  assert.match(t, /prompts +1 \(lines 1\)/);
  assert.match(t, /Bash 2/);
  assert.match(t, /errors +1/);
  assert.match(t, /Bash @4/);
  assert.match(t, /npm test x2 \(lines 2, 3\)/);
});

test("retroCli: --json carries the schema; --transcript is validated; always exit 0", () => {
  const dir = tmp();
  try {
    const p = join(dir, "t.jsonl");
    writeFileSync(p, [user("hi"), use("1", "Read", { file_path: "/p/a.ts" })].join("\n"));
    const r = retroCli(["--json", "--transcript", p]);
    assert.equal(r.exitCode, 0);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.schema, "odd-claude.retro/v1");
    assert.deepEqual(parsed.prompts, { count: 1, lines: [1] });
    assert.match(retroCli(["--transcript", p]).stdout, /^odd-claude retro/);
    assert.equal(retroCli(["--transcript", "relative.jsonl"]).stdout, "Invalid transcript path (must be an absolute path ending in .jsonl); no retro to show.");
    assert.equal(retroCli(["--transcript", join(dir, "nope.jsonl")]).stdout, "Transcript unreadable.");
    assert.equal(retroCli(["--transcript", join(dir, "nope.jsonl")]).exitCode, 0);
    const bad = JSON.parse(retroCli(["--json", "--transcript", "relative.jsonl"]).stdout);
    assert.equal(bad.schema, "odd-claude.retro/v1");
    assert.match(bad.note, /^Invalid transcript path/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("retroCli: no-session, no-data-dir, no-path and session-resolved messages", () => {
  const dir = tmp();
  try {
    const none = retroCli([], {});
    assert.equal(none.exitCode, 0);
    assert.equal(none.stdout, "No session id or transcript (pass --session <id> --data-dir <dir>, or --transcript <path>); no retro to show.");
    assert.equal(retroCli(["--session", "s1"], {}).stdout, "No data dir (pass --data-dir <dir> or set CLAUDE_PLUGIN_DATA); no retro to show.");
    assert.equal(retroCli(["--session", "s1", "--data-dir", dir], {}).stdout, "No transcript path recorded for this session yet (it is saved at the next prompt).");
    const p = join(dir, "t.jsonl");
    writeFileSync(p, user("hi"));
    updateSessionState("s1", (s) => ({ ...s, transcriptPath: p }), { env: { CLAUDE_PLUGIN_DATA: dir } });
    const r = retroCli(["--session", "s1", "--data-dir", dir, "--json"], {});
    assert.equal(JSON.parse(r.stdout).prompts.count, 1);
    const fifoSession = join(dir, "g.jsonl");
    assert.equal(spawnSync("mkfifo", [fifoSession]).status, 0);
    updateSessionState("s2", (s) => ({ ...s, transcriptPath: fifoSession }), { env: { CLAUDE_PLUGIN_DATA: dir } });
    assert.equal(retroCli(["--session", "s2", "--data-dir", dir], {}).stdout, "Transcript unreadable.");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("retro CLI as a script: prints the digest and exits 0 on bad input", () => {
  const r = spawnSync(process.execPath, [join(import.meta.dirname, "..", "cli", "retro.js"), "--transcript", "nope"], { encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^Invalid transcript path/);
});

test("truncated tail: reported line numbers are absolute (match sed -n on the full file)", () => {
  const dir = tmp();
  try {
    const p = join(dir, "t.jsonl");
    const all: string[] = [];
    for (let i = 1; i <= 400; i++) all.push(i === 390 ? use(`e${i}`, "Edit", { file_path: "/p/src/late.ts" }) : user(`prompt number ${i} ${"z".repeat(i % 7)}`));
    writeFileSync(p, all.join("\n") + "\n");
    const d = collectRetro(p, 4096)!;
    assert.equal(d.truncated, true);
    assert.ok(d.firstLine > 1);
    assert.equal(d.firstSourceWrite, 390);
    assert.ok(all[(d.firstSourceWrite as number) - 1]?.includes("late.ts"));
    assert.equal(d.prompts.lines[0], d.firstLine);
    assert.ok(all[d.firstLine - 1]?.includes(`prompt number ${d.firstLine} `) || all[d.firstLine - 1]?.includes(`prompt number ${d.firstLine}"`));
    assert.equal(d.prompts.count, 400 - d.firstLine + 1 - 1); // lines firstLine..400 minus the Edit at 390
    assert.equal(d.firstLine + d.lines - 1, 401); // trailing empty line after the final newline
    assert.match(renderRetro(d), new RegExp(`first line read +${d.firstLine}`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("untruncated transcript starts at line 1", () => {
  assert.equal(digest([user("hi")]).firstLine, 1);
});
