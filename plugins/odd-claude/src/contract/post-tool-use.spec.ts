// Black-box tests of the PostToolUse hook through the hook runner entry, moved from hooks/post-tool-use.spec.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { entry, PLUGIN_ROOT, run } from "./impl.testkit.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "odd-post-"));
}

/** Session state file `<dir>/sessions/<id>.json` is `{ version, data }`; returns `data.exploration`. */
const exploration = (dir: string, id: string): { lookups: number } => JSON.parse(readFileSync(join(dir, "sessions", `${id}.json`), "utf8")).data.exploration;

test("CLI: PostToolUse fixture exits 0 with advisory-only JSON; hooks.json registers it with a short timeout", () => {
  const dir = tmp();
  try {
    let last = "";
    for (let i = 0; i < 4; i++) {
      const r = run("hook-runner", ["PostToolUse"], {
        input: JSON.stringify({ session_id: "c1", tool_name: "mcp__codegraph__codegraph_query", tool_response: "x" }),
        env: { ...process.env, CLAUDE_PLUGIN_DATA: dir },
      });
      assert.equal(r.status, 0);
      last = r.stdout;
    }
    assert.match(JSON.parse(last).hookSpecificOutput.additionalContext, /Exploration budget/);
    const cfg = JSON.parse(readFileSync(join(PLUGIN_ROOT, "hooks", "hooks.json"), "utf8")) as {
      hooks: Record<string, { matcher?: string; hooks: { command: string; timeout?: number }[] }[]>;
    };
    const g = cfg.hooks.PostToolUse[0];
    const m = new RegExp(`^(?:${g.matcher})$`);
    for (const t of ["Read", "Grep", "Glob", "WebFetch", "WebSearch", "mcp__codegraph__x"]) assert.ok(m.test(t), t);
    assert.ok(!m.test("Bash"));
    assert.ok(!m.test("mcp__plugin_odd-claude_codegraph__x"), "the plugin-namespaced MCP name left the matcher with the plugin distribution");
    assert.ok((g.hooks[0].timeout ?? 999) <= 10);
    assert.match(g.hooks[0].command, /run\.js" PostToolUse$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("F2: a FIFO transcript_path is ignored without hanging", () => {
  const dir = tmp();
  try {
    const fifo = join(dir, "fifo");
    execFileSync("mkfifo", [fifo]);
    const t0 = Date.now();
    const r = run("hook-runner", ["PostToolUse"], {
      input: JSON.stringify({ session_id: "f1", tool_name: "Bash", tool_response: "x", transcript_path: fifo }),
      env: { ...process.env, CLAUDE_PLUGIN_DATA: dir },
      timeout: 2000,
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "");
    assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0} ms`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const spawnHook = () => {
  const e = entry("hook-runner");
  return (dir: string) => spawn(e.command, [...e.args, "PostToolUse"], { env: { ...process.env, CLAUDE_PLUGIN_DATA: dir } });
};

test("F1: 10 parallel PostToolUse processes count exactly and notify exactly once", async () => {
  const dir = tmp();
  try {
    const input = JSON.stringify({ session_id: "par", tool_name: "Read", tool_response: "x" });
    const start = spawnHook();
    const runOne = () =>
      new Promise<string>((resolve, reject) => {
        const c = start(dir);
        let out = "";
        c.stdout.on("data", (d) => (out += d));
        c.on("error", reject);
        c.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`exit ${code}`))));
        c.stdin.end(input);
      });
    const outs = await Promise.all(Array.from({ length: 10 }, runOne));
    assert.equal(outs.filter((o) => o.includes("Exploration budget")).length, 1);
    assert.equal(exploration(dir, "par").lookups, 10);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("F1 stress: 10 parallel spawns x 20 rounds always give 1 notice, lookups + logged lock timeouts == 10 and no leftover lock/marker files", async () => {
  const dir = tmp();
  try {
    const start = spawnHook();
    const runOne = (sid: string) =>
      new Promise<string>((resolve, reject) => {
        const c = start(dir);
        let out = "";
        c.stdout.on("data", (d) => (out += d));
        c.on("error", reject);
        c.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`exit ${code}`))));
        c.stdin.end(JSON.stringify({ session_id: sid, tool_name: "Read", tool_response: "x" }));
      });
    // The session-state lock waits ~1s and then fails open BY DESIGN (the hook logs "session state lock timeout"
    // and skips the increment). Under heavy CPU load a holder can be descheduled past that bound, so a round may
    // legitimately count fewer than 10. Every missing increment must be accounted for by one logged timeout.
    const timeouts = (): number => {
      try {
        return readFileSync(join(dir, "logs", "hooks.log"), "utf8").split("\n").filter((l) => l.includes("session state lock timeout")).length;
      } catch {
        return 0;
      }
    };
    let logged = 0;
    for (let round = 0; round < 20; round++) {
      const sid = `stress${round}`;
      const outs = await Promise.all(Array.from({ length: 10 }, () => runOne(sid)));
      const now = timeouts();
      const lost = now - logged;
      logged = now;
      assert.equal(outs.filter((o) => o.includes("Exploration budget")).length, 1, `round ${round}`);
      const lookups = exploration(dir, sid).lookups;
      assert.equal(lookups + lost, 10, `round ${round}: lookups ${lookups} + logged lock timeouts ${lost}`);
    }
    const files = readdirSync(join(dir, "sessions"));
    assert.deepEqual(files.filter((f) => !/^stress\d+\.json$/.test(f)), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
