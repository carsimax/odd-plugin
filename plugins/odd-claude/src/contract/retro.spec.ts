// Black-box test of the retro CLI entry, moved from lib/retro.spec.ts (the in-process collectRetro/retroCli tests stay there).
import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "./impl.testkit.js";

test("retro CLI as a script: prints the digest and exits 0 on bad input", () => {
  const r = run("retro", ["--transcript", "nope"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^Invalid transcript path/);
});
