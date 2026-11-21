import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { eventCases, median, renderTable } from "./hookstart.js";

test("median handles odd, even and empty input", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.ok(Number.isNaN(median([])));
});

test("eventCases covers the six measured hook cases with JSON-serializable payloads", () => {
  const cases = eventCases("/w");
  assert.deepEqual(cases.map((c) => c.event), ["PreToolUse", "PreToolUse", "Stop", "PostToolUse", "SessionStart", "UserPromptSubmit"]);
  for (const c of cases) assert.equal(JSON.parse(JSON.stringify(c.payload)).cwd, "/w");
});

test("renderTable prints one row per case", () => {
  const row = { label: "Stop", event: "Stop", node_ms: 1, total_ms: 2, boot_ms: 3, import_ms: 4, first_ms: 5, warm_ms: 6, load_ms: 7, modules: 8, review_modules: null, runs: 1 };
  assert.equal(renderTable([row]).split("\n").length, 3);
  assert.match(renderTable([row]), /\| Stop \| 1\.0 \| 2\.0 \| 3\.0 \| 7\.0 \| 6\.0 \| 8 \| n\/a \|/);
});

test("a flag missing its value exits 2 with a message instead of falling back", () => {
  const script = fileURLToPath(new URL("./hookstart.js", import.meta.url));
  for (const args of [["--runs"], ["--runs", "--out", "x.json"], ["--out"], ["--out", "--runs", "1"], ["--run-js"], ["--runs", "1", "--run-js", "--out", "x"]]) {
    const r = spawnSync(process.execPath, [script, ...args], { encoding: "utf8", timeout: 20_000 });
    assert.equal(r.status, 2, args.join(" "));
    assert.match(r.stderr, /needs a value/, args.join(" "));
    assert.equal(r.stdout, "", args.join(" "));
  }
});
