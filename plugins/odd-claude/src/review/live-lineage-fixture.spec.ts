import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { start } from "./state.js";
import { createState, storeRootFor } from "./store.js";
import { LIVE_LINEAGE, plantLiveLineage } from "../contract/store.testkit.js";

test("the frozen live lineage of the crash contract is byte-identical to what the store writes", async () => {
  const a = mkdtempSync(join(tmpdir(), "odd-live-a-")), b = mkdtempSync(join(tmpdir(), "odd-live-b-"));
  try {
    const out = start({ lineageId: LIVE_LINEAGE, targetIdentity: `sha256:${"7".repeat(64)}`, projection: "workspace", baseTree: "b".repeat(40), candidateTree: "c".repeat(40), riskLevel: "medium", selectedLenses: ["reliability"], originalChangedLines: 8, now: "2026-11-19T10:00:00.000Z" });
    assert.equal(out.ok, true);
    await createState(a, (out as { ok: true; record: Parameters<typeof createState>[1] }).record);
    plantLiveLineage(b);
    const f = (c: string) => join(storeRootFor(c), LIVE_LINEAGE, "review-state.json");
    assert.equal(readFileSync(f(b), "utf8"), readFileSync(f(a), "utf8"));
    assert.equal(statSync(f(b)).mode & 0o777, statSync(f(a)).mode & 0o777);
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});
