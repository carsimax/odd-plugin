// Captures every persisted-format fixture from the TS implementation into test-fixtures/contracts/<format>/.
// Usage (from plugins/odd-claude, after `npm run build && npm run build:test`): node ../../test-fixtures/contracts/capture.mjs
// Everything runs in a mktemp sandbox (HOME, data dir, git repos); the real ~/.claude, ~/.odd-claude and data dir are never touched.
// Entries come from the resolver (impl.testkit.js) and the black-box harness testkits, never from product modules.
// Volatile values are normalized: the sandbox path -> <SANDBOX>, ISO timestamps -> <TIMESTAMP>. Review-store files are copied verbatim
// (their revision/receipt hashes cover the values, so normalizing would break them).
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const T = join(HERE, "..", "..", "plugins", "odd-claude", "dist-test", "contract");
const load = (n) => import(pathToFileURL(join(T, n)).href);
const { run, entry } = await load("impl.testkit.js");
const { makeWorld, makeFakeReviewer, commitMedium, withClient, git } = await load("harness.testkit.js");
const { approveThroughCapture, acknowledge } = await load("scenarios.testkit.js");

const SID = "sess-contract-0001";
const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "odd-capture-")));
const home = join(sandbox, "home"), data = join(sandbox, "data"), work = join(sandbox, "work"), bin = join(sandbox, "bin");
for (const d of [home, data, work, bin]) mkdirSync(d);
writeFileSync(join(bin, "claude"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
const env = (extra = {}) => ({ PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, GIT_CONFIG_NOSYSTEM: "1", ...extra });

const norm = (s) => s.split(sandbox).join("<SANDBOX>").replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, "<TIMESTAMP>");
const out = (fmt, name, text) => {
  mkdirSync(join(HERE, fmt), { recursive: true });
  writeFileSync(join(HERE, fmt, name), norm(text));
};
const hook = (event, input, e = env({ ODD_CLAUDE_DATA: data })) => run("hook-runner", [event], { input, env: e });

try {
  // Session state + agent status + scratch: SessionStart then a prompt, as Claude Code sends them.
  hook("SessionStart", JSON.stringify({ session_id: SID, cwd: work, source: "startup" }));
  hook("UserPromptSubmit", JSON.stringify({ session_id: SID, cwd: work, prompt: "hello" }));
  out("session-state", "session.json", readFileSync(join(data, "sessions", `${SID}.json`), "utf8"));
  out("agent-status", "agent-status.json", readFileSync(join(data, "status", `${SID}.json`), "utf8"));
  const mode = (p) => (statSync(p).mode & 0o777).toString(8).padStart(4, "0");
  out("scratch", "listing.txt", [`${mode(join(data, "scratch"))} d scratch/`, `${mode(join(data, "scratch", SID))} d scratch/${SID}/`, ""].join("\n"));

  // Plugin-wide state: the delegation mode and the profile, through their CLIs.
  run("coordinator", ["--action", "on", "--data-dir", data], { env: env() });
  run("review-mode", ["enable", "--scope", "global", "--cwd", work, "--data-dir", data], { env: env() });
  for (const f of readdirSync(data).filter((n) => n.endsWith(".json")).sort()) out("plugin-state", f, readFileSync(join(data, f), "utf8"));

  // Logs: a hook that fails writes one line (stdin `null` -> TypeError), exit 0.
  hook("SessionStart", "null");
  out("logs", "hooks.log", readFileSync(join(data, "logs", "hooks.log"), "utf8"));

  // Output schemas.
  const transcript = join(sandbox, "transcript.jsonl");
  const tl = [
    { type: "user", timestamp: "2026-11-19T10:00:00.000Z", message: { role: "user", content: "hi" } },
    { type: "assistant", timestamp: "2026-11-19T10:00:05.000Z", message: { role: "assistant", model: "claude-sonnet-5", content: [{ type: "text", text: "hello" }], usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 } } },
  ].map((l) => JSON.stringify(l)).join("\n") + "\n";
  writeFileSync(transcript, tl);
  mkdirSync(join(HERE, "output-schemas"), { recursive: true });
  copyFileSync(transcript, join(HERE, "output-schemas", "transcript.jsonl"));
  hook("UserPromptSubmit", JSON.stringify({ session_id: SID, cwd: work, prompt: "again", transcript_path: transcript }));
  out("output-schemas", "stats.json", run("stats", ["--json", "--session", SID, "--data-dir", data], { env: env() }).stdout);
  out("output-schemas", "retro.json", run("retro", ["--json", "--transcript", transcript], { env: env() }).stdout);
  const repo = join(sandbox, "tasksrepo");
  mkdirSync(join(repo, "odd", "tasks"), { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  copyFileSync(join(HERE, "output-schemas", "feature.md"), join(repo, "odd", "tasks", "feature.md"));
  out("output-schemas", "tasks-lint.json", run("tasks", ["--json", "--cwd", repo], { env: env() }).stdout);

  // Review store: a medium-risk lineage taken to approved and burned through the real MCP server (fake reviewer, fake claude).
  const w = makeWorld();
  const fake = makeFakeReviewer();
  try {
    commitMedium(w);
    await withClient({ fake, world: w }, async (c) => {
      const a = await approveThroughCapture(c, w);
      await acknowledge(c, w, a.ack);
    });
    const root = join(w.commonDir, "odd-plugin", "review-transactions", "v2");
    const [lineage] = readdirSync(root).filter((n) => /^review-[0-9a-f]{16}$/.test(n));
    mkdirSync(join(HERE, "review-store"), { recursive: true });
    for (const f of ["review-state.json", "review-receipt.json"]) copyFileSync(join(root, lineage, f), join(HERE, "review-store", f));
  } finally {
    w.cleanup();
    fake.cleanup();
  }

  // Installer: a real install into the sandbox HOME (fake `claude` first on PATH, no deps), then the ledgers.
  const plugin = join(HERE, "..", "..", "plugins", "odd-claude");
  const i = run("installer", ["install", "--source", plugin, "--yes", "--no-deps", "--json"], { env: env() });
  if (i.status !== 0) throw new Error(`installer failed: ${i.stderr}${i.stdout.slice(0, 500)}`);
  for (const f of ["manifest.json", "settings-state.json"]) out("installer", f, readFileSync(join(home, ".odd-claude", f), "utf8"));

  // Data dir env: env inputs -> resolved data dir, as the `status` CLI prints it (HOME is the sandbox home).
  const rows = [
    { env: {}, note: "no data variable: <ODD_CLAUDE_HOME default>/data" },
    { env: { ODD_CLAUDE_HOME: `${sandbox}/oddhome` }, note: "ODD_CLAUDE_HOME moves the default" },
    { env: { CLAUDE_PLUGIN_DATA: `${sandbox}/plugin-data` }, note: "CLAUDE_PLUGIN_DATA (legacy)" },
    { env: { ODD_CLAUDE_DATA: `${sandbox}/odd-data` }, note: "ODD_CLAUDE_DATA" },
    { env: { ODD_CLAUDE_DATA: `${sandbox}/odd-data`, CLAUDE_PLUGIN_DATA: `${sandbox}/plugin-data` }, note: "ODD_CLAUDE_DATA wins over CLAUDE_PLUGIN_DATA" },
    { env: { ODD_CLAUDE_DATA: "", CLAUDE_PLUGIN_DATA: `${sandbox}/plugin-data` }, note: "an empty value counts as unset" },
    { env: { ODD_CLAUDE_DATA: `${sandbox}/odd-data`, ODD_CLAUDE_HOME: `${sandbox}/oddhome` }, note: "an explicit data dir wins over ODD_CLAUDE_HOME" },
  ];
  const table = rows.map((r) => {
    const o = run("status", ["--json"], { env: env(r.env) });
    return { note: r.note, env: JSON.parse(norm(JSON.stringify(r.env))), dataDir: norm(JSON.parse(o.stdout).dataDir) };
  });
  out("data-dir-env", "table.json", JSON.stringify(table, null, 2) + "\n");
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
console.log("captured under", HERE);
