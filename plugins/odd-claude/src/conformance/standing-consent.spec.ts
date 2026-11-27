// autonomous-review S3/S4: an escalated review blocks the work-unit commit; one standing consent per tracked feature, recorded verbatim in the Log.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");

test("ODD rules state the once-per-feature standing consent, recorded verbatim in the Log, limited to that feature branch (S4)", () => {
  for (const f of ["claude-md/03-protocol.md", "rules/odd-tracking.md"]) {
    const t = read(f);
    assert.match(t, /standing consent/i, f);
    assert.match(t, /once per (tracked )?feature/i, f);
    assert.match(t, /verbatim[^\n]*`## Log`/, f);
    assert.match(t, /that feature branch/i, f);
    assert.match(t, /(decline|without a recorded)[^\n]*per-run relay|per-run relay[^\n]*(decline|without a recorded)/i, f);
  }
});

test("ODD rules state that an escalated review blocks the work-unit commit and the parent asks the human (S3)", () => {
  for (const f of ["claude-md/03-protocol.md", "rules/odd-tracking.md"]) {
    assert.match(read(f), /`escalated`[^\n]*no (work-unit )?commit[^\n]*asks? the human/i, f);
  }
});

test("MCP instructions, tool descriptions and the Stop hook state the same narrow standing-consent exception (S4)", () => {
  for (const f of ["src/mcp/review-server.ts", "src/mcp/tools.ts", "src/hooks/stop.ts"]) {
    const t = read(f);
    assert.match(t, /standing consent recorded in the feature document `## Log`/i, f);
    assert.match(t, /never on your own judgment/i, f);
  }
});

test("every standing-consent clause is limited to work-unit commit candidates (S4)", () => {
  for (const f of ["src/mcp/review-server.ts", "src/mcp/tools.ts", "src/hooks/stop.ts", "claude-md/03-protocol.md", "rules/odd-tracking.md"]) {
    for (const line of read(f).split("\n").filter((l) => /standing consent/i.test(l))) {
      assert.match(line, /work-unit (commit )?candidate/i, `${f}: ${line.slice(0, 120)}`);
    }
  }
});
