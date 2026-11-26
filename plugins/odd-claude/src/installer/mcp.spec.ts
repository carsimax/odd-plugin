import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMcp, planMcp, removeMcp, type McpRunner } from "./mcp.js";

type Call = { cmd: string; args: string[]; env: NodeJS.ProcessEnv | undefined };
function fake(existing: string[], opts: { listFails?: boolean; getFails?: boolean; addFails?: string } = {}) {
  const calls: Call[] = [];
  const reg = new Set(existing);
  const runner: McpRunner = (cmd, args, o) => {
    calls.push({ cmd, args, env: o.env });
    const [a, b] = args;
    if (cmd !== "claude" || a !== "mcp") return { code: 2, stdout: "", stderr: "unexpected" };
    if (b === "get") {
      if (opts.getFails) return { code: 1, stdout: "", stderr: "boom" };
      return reg.has(args[2]) ? { code: 0, stdout: `${args[2]}:\n  Scope: User`, stderr: "" } : { code: 1, stdout: "", stderr: `No MCP server found with name: ${args[2]}` };
    }
    if (b === "list") {
      if (opts.listFails) return { code: 1, stdout: "", stderr: "boom" };
      return { code: 0, stdout: "Checking MCP server health...\n\n" + [...reg].map((n) => `${n}: cmd - ✓ Connected`).join("\n") + "\n", stderr: "" };
    }
    if (b === "add") {
      const name = args[4];
      if (opts.addFails === name) return { code: 1, stdout: "", stderr: "add failed" };
      reg.add(name);
      return { code: 0, stdout: "", stderr: "" };
    }
    if (b === "remove") {
      reg.delete(args[4]);
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 2, stdout: "", stderr: "unexpected" };
  };
  return { runner, calls, reg };
}
const env = { CLAUDE_CONFIG_DIR: "/tmp/cfg" } as NodeJS.ProcessEnv;
const mut = (calls: Call[]) => calls.filter((c) => c.args[1] === "add" || c.args[1] === "remove").map((c) => c.args);
function tmpState() {
  const dir = mkdtempSync(join(tmpdir(), "odd-mcp-"));
  return { statePath: join(dir, "settings-state.json"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("apply registers odd-review, odd-peers and codegraph with the exact argv, passing env through", async () => {
  const f = fake([]);
  const s = tmpState();
  try {
    const r = await applyMcp({ runner: f.runner, env, oddRoot: "/o/current", statePath: s.statePath });
    assert.deepEqual(mut(f.calls), [
      ["mcp", "add", "-s", "user", "odd-review", "--", "node", "/o/current/dist/mcp/review-server.js"],
      ["mcp", "add", "-s", "user", "odd-peers", "--", "node", "/o/current/dist/mcp/peers-server.js"],
      ["mcp", "add", "-s", "user", "codegraph", "--", "codegraph", "serve", "--mcp"],
    ]);
    assert.deepEqual(r.results.map((x) => x.status), ["added", "added", "added"]);
    assert.ok(f.calls.every((c) => c.env === env && c.cmd === "claude"));
    assert.deepEqual(JSON.parse(readFileSync(s.statePath, "utf8")).mcp.added, ["odd-review", "odd-peers", "codegraph"]);
  } finally {
    s.cleanup();
  }
});

test("existing servers are skipped and never recorded as ours", async () => {
  const f = fake(["codegraph"]);
  const s = tmpState();
  try {
    const plan = await planMcp({ runner: f.runner, env, oddRoot: "/o/current" });
    assert.deepEqual(plan.servers.map((x) => [x.name, x.action]), [["odd-review", "add"], ["odd-peers", "add"], ["codegraph", "skip-existing"]]);
    assert.deepEqual(mut(f.calls), []);
    await applyMcp({ runner: f.runner, env, oddRoot: "/o/current", statePath: s.statePath });
    assert.deepEqual(JSON.parse(readFileSync(s.statePath, "utf8")).mcp.added, ["odd-review", "odd-peers"]);
  } finally {
    s.cleanup();
  }
});

test("a failing add is reported and the others continue", async () => {
  const f = fake([], { addFails: "odd-peers" });
  const s = tmpState();
  try {
    const r = await applyMcp({ runner: f.runner, env, oddRoot: "/o/current", statePath: s.statePath });
    assert.deepEqual(r.results.map((x) => x.status), ["added", "failed", "added"]);
    assert.match(r.results[1].detail, /add failed/);
    assert.deepEqual(JSON.parse(readFileSync(s.statePath, "utf8")).mcp.added, ["odd-review", "codegraph"]);
  } finally {
    s.cleanup();
  }
});

test("when detection fails the server is reported as unknown and nothing is added", async () => {
  const f = fake([], { getFails: true, listFails: true });
  const s = tmpState();
  try {
    const r = await applyMcp({ runner: f.runner, env, oddRoot: "/o/current", statePath: s.statePath });
    assert.deepEqual(r.results.map((x) => x.status), ["unknown", "unknown", "unknown"]);
    assert.deepEqual(mut(f.calls), []);
    assert.equal(existsSync(s.statePath), false);
  } finally {
    s.cleanup();
  }
});

test("detection falls back to claude mcp list when get fails ambiguously", async () => {
  const f = fake(["odd-review"], { getFails: true });
  const plan = await planMcp({ runner: f.runner, env, oddRoot: "/o/current" });
  assert.deepEqual(plan.servers.map((x) => x.action), ["skip-existing", "add", "add"]);
  assert.ok(f.calls.some((c) => c.args[1] === "list"));
});

test("removeMcp removes only the servers we recorded, then forgets them", async () => {
  const f = fake(["codegraph"]);
  const s = tmpState();
  try {
    await applyMcp({ runner: f.runner, env, oddRoot: "/o/current", statePath: s.statePath });
    f.calls.length = 0;
    const r = await removeMcp({ runner: f.runner, env, statePath: s.statePath });
    assert.deepEqual(mut(f.calls), [["mcp", "remove", "-s", "user", "odd-review"], ["mcp", "remove", "-s", "user", "odd-peers"]]);
    assert.deepEqual(r.results.map((x) => x.status), ["removed", "removed"]);
    assert.deepEqual([...f.reg], ["codegraph"]);
    assert.deepEqual((await removeMcp({ runner: f.runner, env, statePath: s.statePath })).results, []);
  } finally {
    s.cleanup();
  }
});

const REAL_MISSING = 'No MCP server named "odd-review". Configured servers: codegraph, engram, plugin:odd-claude:review';
const REAL_GET_OK = "codegraph:\n  Scope: User config (available in all your projects)\n  Status: ✔ Connected\n  Type: stdio\n  Command: codegraph\n  Args: serve --mcp\n";
const REAL_LIST =
  "Checking MCP server health…\n\nplugin:playwright:playwright: npx @playwright/mcp - ✔ Connected\nplugin:odd-claude:review: node x.js - ✔ Connected\ncodegraph: codegraph serve --mcp - ✔ Connected\n";

test("real CLI output: `get` exit 1 with 'No MCP server named' is absent, exit 0 is present", async () => {
  const runner: McpRunner = (_c, args) =>
    args[1] === "get" && args[2] === "codegraph"
      ? { code: 0, stdout: REAL_GET_OK, stderr: "" }
      : args[1] === "get"
        ? { code: 1, stdout: "", stderr: REAL_MISSING }
        : { code: 9, stdout: "", stderr: "list must not be needed" };
  const plan = await planMcp({ runner, env, oddRoot: "/o/current" });
  assert.deepEqual(plan.servers.map((x) => x.action), ["add", "add", "skip-existing"]);
});

test("real CLI output: list fallback matches the exact name followed by ': ' at line start", async () => {
  const runner: McpRunner = (_c, args) => (args[1] === "get" ? { code: 1, stdout: "", stderr: "boom" } : { code: 0, stdout: REAL_LIST, stderr: "" });
  const plan = await planMcp({ runner, env, oddRoot: "/o/current" });
  // "plugin:odd-claude:review" must not count as "odd-review"; codegraph is listed.
  assert.deepEqual(plan.servers.map((x) => x.action), ["add", "add", "skip-existing"]);
});
