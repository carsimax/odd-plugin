import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { statuslineCli } from "./statusline.js";

const strip = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, "");
const payload = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    session_id: "s1",
    model: { display_name: "Opus 4.1" },
    cost: { total_api_duration_ms: 20000 },
    context_window: { used_percentage: 42, total_output_tokens: 1000 },
    ...over,
  });

test("garbage, empty and huge-but-invalid stdin print the fallback line and exit 0", () => {
  for (const bad of ["", "not json", "{", "\u0000\u0001", "[1,2]", "null"]) {
    const r = statuslineCli(bad, { NO_COLOR: "1" });
    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout, "odd-claude");
  }
});

test("NO_COLOR removes colors; COLUMNS bounds the width; output is a single line", () => {
  const colored = statuslineCli(payload(), {});
  assert.match(colored.stdout, /\u001b\[/);
  const plain = statuslineCli(payload(), { NO_COLOR: "1", COLUMNS: "200" });
  assert.ok(!plain.stdout.includes("\u001b"));
  assert.match(plain.stdout, /^Opus 4\.1 · ctx 42%/);
  assert.ok(!plain.stdout.includes("\n"));
  const narrow = statuslineCli(payload(), { NO_COLOR: "1", COLUMNS: "12" });
  assert.ok(narrow.stdout.length <= 12, narrow.stdout);
  assert.equal(narrow.exitCode, 0);
});

test("reads coordinator and persona from the data dir; TPS comes from deltas between invocations", () => {
  const dir = mkdtempSync(join(tmpdir(), "odd-sl-"));
  try {
    const env = { NO_COLOR: "1", COLUMNS: "300", CLAUDE_PLUGIN_DATA: dir };
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "delegation.json"), JSON.stringify({ version: 1, sessionId: "", data: { mode: "full" } }));
    writeFileSync(join(dir, "persona.json"), JSON.stringify({ version: 1, sessionId: "", data: { mode: "neutral" } }));
    const first = statuslineCli(payload(), env);
    assert.match(first.stdout, /coord ON · neutral/);
    assert.match(first.stdout, /50 tok\/s/); // session average on first sight
    const second = statuslineCli(payload({ cost: { total_api_duration_ms: 30000 }, context_window: { used_percentage: 43, total_output_tokens: 1600 } }), env);
    assert.match(second.stdout, /60 tok\/s/); // delta: 600 tokens / 10 s
    const third = statuslineCli(payload({ cost: { total_api_duration_ms: 30000 }, context_window: { used_percentage: 44, total_output_tokens: 1600 } }), env);
    assert.match(third.stdout, /60 tok\/s/); // idle: previous reading kept
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unwritable or missing data dir never breaks the line", () => {
  const dir = mkdtempSync(join(tmpdir(), "odd-sl-"));
  try {
    writeFileSync(join(dir, "f"), "x");
    for (const data of [join(dir, "f", "sub"), "relative/dir", join(dir, "missing")]) {
      const r = statuslineCli(payload(), { NO_COLOR: "1", COLUMNS: "300", CLAUDE_PLUGIN_DATA: data });
      assert.equal(r.exitCode, 0);
      assert.match(strip(r.stdout), /^Opus 4\.1 · ctx 42%/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
