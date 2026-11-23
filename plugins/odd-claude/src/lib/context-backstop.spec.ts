import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkContextBackstop } from "./context-backstop.js";

const usage = (n: number) => JSON.stringify({ message: { usage: { input_tokens: n } } }) + "\n";

function withDir(fn: (dir: string, t: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "odd-backstop-"));
  try {
    fn(dir, join(dir, "t.jsonl"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// T4: after the notice fired only a re-arm (a measured drop) matters, so the per-PostToolUse read is a short tail, not 512 KB.
test("after the notice fired, a usage line beyond the short tail is not read (no 512 KB re-read)", () => {
  withDir((dir, t) => {
    const opts = { dataDir: dir };
    writeFileSync(t, usage(200_000));
    assert.ok(checkContextBackstop("sess-0001", t, false, {}, opts)?.startsWith("Context backstop:"));
    writeFileSync(t, usage(10) + (JSON.stringify({ type: "user", pad: "x".repeat(200 * 1024) }) + "\n"));
    assert.equal(checkContextBackstop("sess-0001", t, false, {}, opts), undefined);
    // still armed: the low reading was out of reach, so a new crossing does not notify again
    writeFileSync(t, usage(200_000));
    assert.equal(checkContextBackstop("sess-0001", t, false, {}, opts), undefined);
  });
});

test("after the notice fired, a measured drop in the tail still re-arms it", () => {
  withDir((dir, t) => {
    const opts = { dataDir: dir };
    writeFileSync(t, usage(200_000));
    assert.ok(checkContextBackstop("sess-0002", t, false, {}, opts));
    writeFileSync(t, usage(10));
    assert.equal(checkContextBackstop("sess-0002", t, false, {}, opts), undefined);
    writeFileSync(t, usage(200_000));
    assert.ok(checkContextBackstop("sess-0002", t, false, {}, opts)?.startsWith("Context backstop:"));
  });
});
