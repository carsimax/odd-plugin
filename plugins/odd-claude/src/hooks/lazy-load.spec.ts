import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import * as nodeModule from "node:module";
import { setReviewMode } from "../review/mode.js";

// T9 contract: `node dist/hooks/run.js <event>` loads only the modules its event needs. A module-load probe (`--import`) records every
// file the process loads; cheap events must not pull in the review engine (gate, risk, status, start, consent, ack) or another event's handler.

const runJs = fileURLToPath(new URL("./run.js", import.meta.url));
const root = dirname(dirname(runJs));
const probeSupported = typeof (nodeModule as unknown as { registerHooks?: unknown }).registerHooks === "function";
const skip = probeSupported ? false : "node:module registerHooks is not available in this Node version";

const PROBE = `import { registerHooks } from "node:module";
import { appendFileSync } from "node:fs";
registerHooks({ load(url, ctx, next) { if (url.startsWith("file:")) appendFileSync(process.env.ODD_PROBE_OUT, url + "\\n"); return next(url, ctx); } });
`;

/** Files loaded (relative to the plugin dist root, e.g. `review/gate.js`) by one fresh hook process. */
function loaded(event: string, input: object, setup?: (data: string) => void): { files: string[]; stdout: string } {
  const dir = mkdtempSync(join(tmpdir(), "odd-lazy-"));
  try {
    const data = join(dir, "data");
    mkdirSync(data);
    setup?.(data);
    const probe = join(dir, "probe.mjs");
    writeFileSync(probe, PROBE);
    const out = join(dir, "loaded.txt");
    const r = spawnSync(process.execPath, ["--import", pathToFileURL(probe).href, runJs, event], {
      input: JSON.stringify(input),
      encoding: "utf8",
      cwd: dir,
      env: { PATH: process.env.PATH, HOME: dir, CLAUDE_PLUGIN_DATA: data, CLAUDE_PLUGIN_ROOT: root, ODD_PROBE_OUT: out, ODD_CLAUDE_NO_SKILL_REGISTRY: "1" },
    });
    assert.equal(r.status, 0, r.stderr);
    const files = existsSync(out) ? readFileSync(out, "utf8").split("\n").filter((l) => l !== "").map((u) => fileURLToPath(u)).filter((f) => f.startsWith(root + "/")).map((f) => f.slice(root.length + 1)) : [];
    return { files, stdout: r.stdout };
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

const HANDLERS = ["post-tool-use", "pre-tool-use", "session-end", "session-start", "stop-failure", "stop", "subagents", "user-prompt-submit"].map((n) => `hooks/${n}.js`);
const ENGINE = ["review/gate.js", "review/risk.js", "review/status.js", "review/start.js", "review/consent.js", "review/ack.js"];
// A private project dir: SessionStart writes `<cwd>/.atl/skill-registry.md`, so the shared real tmpdir must not be the cwd.
const projectDir = mkdtempSync(join(tmpdir(), "odd-lazyload-cwd-"));
after(() => rmSync(projectDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
const base = { session_id: "s1", cwd: projectDir };

const cases: { name: string; event: string; input: object; own: string; reviewFree: boolean }[] = [
  { name: "PreToolUse non-delivery Bash, RDD off", event: "PreToolUse", input: { ...base, tool_name: "Bash", tool_input: { command: "ls -la" } }, own: "hooks/pre-tool-use.js", reviewFree: false },
  { name: "PreToolUse delivery, RDD off", event: "PreToolUse", input: { ...base, tool_name: "Bash", tool_input: { command: "git push origin main" } }, own: "hooks/pre-tool-use.js", reviewFree: false },
  { name: "Stop, RDD off", event: "Stop", input: { ...base, stop_hook_active: false }, own: "hooks/stop.js", reviewFree: false },
  { name: "PostToolUse", event: "PostToolUse", input: { ...base, tool_name: "Read", tool_input: { file_path: "/x" } }, own: "hooks/post-tool-use.js", reviewFree: true },
  { name: "UserPromptSubmit", event: "UserPromptSubmit", input: { ...base, prompt: "hola" }, own: "hooks/user-prompt-submit.js", reviewFree: true },
  { name: "SessionStart", event: "SessionStart", input: { ...base, source: "startup" }, own: "hooks/session-start.js", reviewFree: true },
  { name: "SessionEnd", event: "SessionEnd", input: base, own: "hooks/session-end.js", reviewFree: true },
  { name: "StopFailure", event: "StopFailure", input: base, own: "hooks/stop-failure.js", reviewFree: true },
  { name: "SubagentStart", event: "SubagentStart", input: base, own: "hooks/subagents.js", reviewFree: true },
];

for (const c of cases) {
  test(`${c.name}: loads neither the review engine nor another event's handler`, { skip }, () => {
    const { files } = loaded(c.event, c.input);
    assert.ok(files.includes("hooks/run.js"), `probe saw the entry: ${files.join(", ")}`);
    for (const m of ENGINE) assert.ok(!files.includes(m), `${m} was loaded: ${files.join(", ")}`);
    for (const h of HANDLERS) if (h !== c.own) assert.ok(!files.includes(h), `${h} was loaded: ${files.join(", ")}`);
    if (c.reviewFree) assert.deepEqual(files.filter((f) => f.startsWith("review/")), [], files.join(", "));
  });
}

test("PreToolUse and Stop load the gate and the settle engine once the global RDD switch is on", { skip }, () => {
  const on = (data: string): void => void setReviewMode("enable", "global", projectDir, { dataDir: data });
  const pre = loaded("PreToolUse", { ...base, tool_name: "Bash", tool_input: { command: "git push origin main" } }, on);
  assert.ok(pre.files.includes("review/gate.js"), pre.files.join(", "));
  const stop = loaded("Stop", { ...base, stop_hook_active: false }, on);
  assert.ok(stop.files.includes("hooks/stop.js"), stop.files.join(", "));
});

// R07 P4: the delivery module (and the mailbox scan behind it) is loaded only when the session has a mailbox with queued messages.
const PEER_R = "rrrrrrrr-1111-4111-8111-rrrrrrrrrrrr";
for (const [event, extra] of [["UserPromptSubmit", { prompt: "hola" }], ["SessionStart", { source: "compact" }]] as const) {
  test(`${event}: peers-delivery loads only when the session has queued mail`, { skip }, () => {
    const input = { session_id: PEER_R, cwd: projectDir, ...extra };
    const none = loaded(event, input);
    assert.ok(!none.files.includes("lib/peers-delivery.js"), none.files.join(", "));
    assert.ok(!none.stdout.includes("peer-messages"));
    const withMail = loaded(event, input, (data) => {
      mkdirSync(join(data, "peers", PEER_R), { recursive: true });
      writeFileSync(join(data, "peers", PEER_R, "0000000001.json"), "{}");
    });
    assert.ok(withMail.files.includes("lib/peers-delivery.js"), withMail.files.join(", "));
  });
}
