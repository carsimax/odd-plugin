import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findLineage, hasRole, lensesPending } from "./lineage.js";
import type { StateRecord } from "./state.js";

const rec = (lenses: string[], results: Array<{ role: string; lens?: string }>): StateRecord =>
  ({ selected_lenses: lenses, admitted_role_results: results }) as unknown as StateRecord;

test("lensesPending lists selected lenses without an admitted lens result", () => {
  const r = rec(["a", "b", "c"], [{ role: "lens", lens: "b" }, { role: "refuter", lens: "c" }]);
  assert.deepEqual(lensesPending(r), ["a", "c"]);
  assert.deepEqual(lensesPending(rec([], [])), []);
});

test("hasRole is true only for an admitted result of that role", () => {
  const r = rec(["a"], [{ role: "lens", lens: "a" }, { role: "refuter" }]);
  assert.equal(hasRole(r, "lens"), true);
  assert.equal(hasRole(r, "refuter"), true);
  assert.equal(hasRole(r, "validator"), false);
});

test("findLineage on a store without lineages finds nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "odd-lineage-"));
  try {
    assert.deepEqual(findLineage(dir, "id", "workspace" as never), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
