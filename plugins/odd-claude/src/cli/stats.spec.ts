import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { statsCli } from "./stats.js";
import { recordTranscriptPath } from "../lib/transcript-path.js";

test("S27: note says 'Transcript unreadable.' only when the read failed", () => {
  const dir = mkdtempSync(join(tmpdir(), "odd-stats-"));
  try {
    const env = { ODD_CLAUDE_DATA: dir };
    const ok = join(dir, "ok.jsonl");
    writeFileSync(ok, JSON.stringify({ type: "assistant", message: { id: "m", model: "x", usage: { input_tokens: 1, output_tokens: 1 } } }) + "\n");
    recordTranscriptPath({ session_id: "good", transcript_path: ok }, { env });
    recordTranscriptPath({ session_id: "bad", transcript_path: join(dir, "missing.jsonl") }, { env });
    const good = JSON.parse(statsCli(["--json", "--session", "good"], env).stdout);
    assert.notEqual(good.transcript, undefined);
    assert.equal(good.note, undefined);
    assert.equal(JSON.parse(statsCli(["--json", "--session", "bad"], env).stdout).note, "Transcript unreadable.");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
