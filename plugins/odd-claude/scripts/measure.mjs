// Dev-only, deterministic, offline measurement (refine-v5 T0/T8). No deps, no model calls.
// Usage: node scripts/measure.mjs [--runs N] [--out file]
// Byte metrics are deterministic; latency and module counts are wall-clock / observed per fresh hook process.
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (name, dflt) => (args.includes(name) ? args[args.indexOf(name) + 1] : dflt);
const runs = Number(opt("--runs", "15"));
const outFile = opt("--out", undefined);
if (!Number.isInteger(runs) || runs < 1) throw new Error("--runs must be a positive integer");

const bytes = (s) => Buffer.byteLength(s, "utf8");
const read = (p) => readFileSync(join(root, p), "utf8");
const scratch = mkdtempSync(join(tmpdir(), "odd-measure-"));
try {
  const home = join(scratch, "home");
  const data = join(scratch, "data");
  const repo = join(scratch, "repo");
  for (const d of [home, data, repo]) mkdirSync(d, { recursive: true });
  const git = (...a) => spawnSync("git", ["-C", repo, ...a], { stdio: "ignore" });
  git("init", "-q");
  const transcript = join(scratch, "transcript.jsonl");
  writeFileSync(transcript, "");
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    TMPDIR: scratch,
    CLAUDE_PLUGIN_ROOT: root,
    CLAUDE_PLUGIN_DATA: data,
    ODD_CLAUDE_NO_SKILL_REGISTRY: "1", // no detached registry refresh: nothing touches real state, output stays deterministic
  };
  const base = { session_id: "measure-session-0001", transcript_path: transcript, cwd: repo };
  const fixtures = {
    SessionStart: { ...base, hook_event_name: "SessionStart", source: "startup" },
    UserPromptSubmit: { ...base, hook_event_name: "UserPromptSubmit", prompt: "Add a retry to the fetch helper and update its test." },
    PreToolUse: { ...base, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git status --short" } },
    PostToolUse: { ...base, hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: join(root, "package.json") }, tool_response: { content: "{}" } },
    Stop: { ...base, hook_event_name: "Stop", stop_hook_active: false },
    StopFailure: { ...base, hook_event_name: "StopFailure", error: "rate_limit" },
    SessionEnd: { ...base, hook_event_name: "SessionEnd", reason: "other" },
    SubagentStart: { ...base, hook_event_name: "SubagentStart", agent_id: "agent-0001", agent_type: "odd-worker" },
    SubagentStop: { ...base, hook_event_name: "SubagentStop", agent_id: "agent-0001", agent_type: "odd-worker" },
  };
  const events = Object.keys(JSON.parse(read("hooks/hooks.json")).hooks);
  for (const e of events) if (!fixtures[e]) throw new Error(`no fixture for hook event ${e}`);

  // Module counter: a sync resolve hook counting distinct dist/ modules, written on exit to MEASURE_MODULES_FILE.
  const counter = join(scratch, "count-modules.mjs");
  writeFileSync(
    counter,
    `import { registerHooks } from "node:module";
import { writeFileSync } from "node:fs";
const seen = new Set();
registerHooks({ resolve(s, c, next) { const r = next(s, c); if (r.url.startsWith("file:") && r.url.includes("/dist/")) seen.add(r.url); return r; } });
process.on("exit", () => writeFileSync(process.env.MEASURE_MODULES_FILE, String(seen.size)));
`,
  );
  const modulesFile = join(scratch, "modules.txt");

  const run = (event, extraNodeArgs = [], extraEnv = {}) => {
    const t0 = process.hrtime.bigint();
    const r = spawnSync(process.execPath, [...extraNodeArgs, join(root, "dist/hooks/run.js"), event], {
      input: JSON.stringify(fixtures[event]),
      env: { ...env, ...extraEnv },
      cwd: repo,
      encoding: "utf8",
    });
    return { ms: Number(process.hrtime.bigint() - t0) / 1e6, status: r.status, stdout: r.stdout };
  };
  const ctxBytes = (stdout) => {
    try { return bytes(JSON.parse(stdout).hookSpecificOutput?.additionalContext ?? ""); } catch { return 0; }
  };

  const fm = (text) => {
    const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
    if (!m) return { description: "", body: text };
    const lines = m[1].split("\n");
    const i = lines.findIndex((l) => l.startsWith("description:"));
    let d = "";
    if (i >= 0) {
      d = lines[i].slice("description:".length).trim();
      if (/^[>|][+-]?$/.test(d)) {
        d = "";
        for (let j = i + 1; j < lines.length && /^\s/.test(lines[j]); j++) d += lines[j].trim() + " ";
        d = d.trim();
      } else if (/^(".*"|'.*')$/.test(d)) d = d.slice(1, -1);
    }
    return { description: d, body: m[2] };
  };

  const agents = {};
  let agentDesc = 0;
  for (const f of readdirSync(join(root, "agents")).filter((n) => n.endsWith(".md")).sort()) {
    const { description, body } = fm(read(`agents/${f}`));
    agentDesc += bytes(description);
    agents[f] = { descriptionBytes: bytes(description), bodyBytes: bytes(body), fileBytes: bytes(read(`agents/${f}`)) };
  }
  let skillDesc = 0;
  let skillCount = 0;
  for (const d of readdirSync(join(root, "skills")).sort()) {
    const p = `skills/${d}/SKILL.md`;
    if (!existsSync(join(root, p))) continue;
    skillDesc += bytes(fm(read(p)).description);
    skillCount++;
  }

  const startRun = run("SessionStart");
  const promptRun = run("UserPromptSubmit");
  const bytesReport = {
    outputStyleBytes: bytes(read("output-styles/odd.md")),
    sessionStartAdditionalContextBytes: ctxBytes(startRun.stdout),
    userPromptSubmitAdditionalContextBytes: ctxBytes(promptRun.stdout),
    agentDescriptionBytes: agentDesc,
    skillDescriptionBytes: skillDesc,
    skillCount,
    totalFrontmatterDescriptionBytes: agentDesc + skillDesc,
    agents,
  };

  const median = (a) => { const s = [...a].sort((x, y) => x - y); const h = s.length >> 1; return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };
  const p95 = (a) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.ceil(a.length * 0.95) - 1)];
  const r1 = (n) => Math.round(n * 10) / 10;
  const hooks = {};
  for (const e of events) {
    const times = [];
    const codes = new Set();
    for (let i = 0; i < runs; i++) { const r = run(e); times.push(r.ms); codes.add(r.status); }
    let modules = null;
    run(e, ["--import", counter], { MEASURE_MODULES_FILE: modulesFile });
    if (existsSync(modulesFile)) modules = Number(readFileSync(modulesFile, "utf8"));
    hooks[e] = { medianMs: r1(median(times)), p95Ms: r1(p95(times)), exitCodes: [...codes], distModulesLoaded: modules };
  }

  const report = { node: process.version, runs, bytes: bytesReport, hooks };
  const json = JSON.stringify(report, null, 2) + "\n";
  if (outFile) writeFileSync(resolve(outFile), json);
  process.stdout.write(json);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
