// Per-journey sandbox: temp HOME, temp git repo (one commit), optional bare origin, and a PATH with counting shims.
// `git` on the sandbox PATH counts every invocation then execs the real git; `claude` is a fake that counts and prints canned
// text, so no model ever runs. Setup itself uses the real git directly and is never counted.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface Sandbox {
  root: string;
  home: string;
  repo: string;
  origin?: string;
  /** Plugin data dir (CLAUDE_PLUGIN_DATA) inside the sandbox: RDD mode and session state live here, never in the real user's. */
  dataDir: string;
  /** Environment for processes the journey spawns: built from scratch (nothing inherited but PATH's tail and TMPDIR), own HOME, config/data/cache dirs, shimmed PATH, fixed git identity. */
  env: NodeJS.ProcessEnv;
  /** Writes the verdict plan the fake reviewer follows (see `VerdictPlan`). */
  setVerdicts(plan: VerdictPlan): void;
  /** Uncounted real git inside the repo (journey setup and assertions). */
  git(args: readonly string[]): string;
  countGit(): number;
  countModelRuns(): number;
  /** Forgets counts so far (called after journey setup). */
  resetCounters(): void;
  cleanup(): void;
}

const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** Writes an executable `name` into `binDir` that appends a line to `logFile`, then forwards to `realPath` or prints `canned`. */
export function installCountingShim(binDir: string, name: string, logFile: string, target: { forwardTo: string } | { canned: string }): string {
  const body = "forwardTo" in target ? `exec ${shq(target.forwardTo)} "$@"` : `printf '%s\\n' ${shq(target.canned)}\nexit 0`;
  const file = join(binDir, name);
  writeFileSync(file, `#!/bin/sh\necho ${shq(name)} >> ${shq(logFile)}\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

/** Verdict plan the fake reviewer reads from `$HOME/odd-bench-verdicts.json` (HOME survives the reviewer env allowlist). */
export interface VerdictPlan {
  /** Findings per lens name; a lens that is not listed reports none. */
  findings?: Record<string, unknown[]>;
  /** Validator verdict (default true: the correction passes). */
  validatorPasses?: boolean;
}
export const VERDICT_FILE = "odd-bench-verdicts.json";

/**
 * Writes a fake `claude` that counts its run, then synthesizes a reviewer result from the prompt's own echo line and the
 * verdict plan: no model, no network. Without a prompt in the odd reviewer format it prints a canned line.
 */
export function installReviewerShim(binDir: string, logFile: string, planFile: string): string {
  const file = join(binDir, "claude");
  const body = `#!${process.execPath}
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(logFile)}, "claude\\n");
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { stdin += c; });
process.stdin.on("end", () => {
  const head = /Role: (\\w+)(?:, lens: (\\w+))?\\./.exec(stdin);
  const echoLine = /Echo these fields verbatim in the result: (\\{.*\\})/.exec(stdin);
  if (!head || !echoLine) { process.stdout.write("odd-bench fake claude: no model was run\\n"); return; }
  let plan = {};
  try { plan = JSON.parse(fs.readFileSync(${JSON.stringify(planFile)}, "utf8")); } catch {}
  const section = (name) => { const m = new RegExp("<<<ODD-DATA-\\\\w+ " + name + ">>>\\\\n([\\\\s\\\\S]*?)\\\\n<<<END-ODD-DATA-\\\\w+ " + name + ">>>").exec(stdin); return m ? m[1] : ""; };
  const echo = JSON.parse(echoLine[1]);
  let result;
  if (head[1] === "lens") {
    result = { ...echo, inspection: { status: "completed", paths: section("changed-path-manifest").split("\\n") }, findings: (plan.findings || {})[head[2]] || [], evidence: ["reviewed the complete candidate scope"] };
  } else if (head[1] === "refuter") {
    const ids = JSON.parse(section("findings")).map((f) => f.id);
    result = { ...echo, results: ids.map((id) => ({ finding_id: id, outcome: "corroborated", proof_refs: ["the finding still holds"] })) };
  } else {
    const ok = plan.validatorPasses !== false;
    result = { ...echo, original_criteria: { passed: ok, evidence: [ok ? "the original criteria now pass" : "the original criteria still fail"] }, correction_regression: { passed: true, evidence: ["no regression observed"] }, follow_ups: [] };
    if (!ok) result.original_criteria.passed = false;
  }
  process.stdout.write("\`\`\`json\\n" + JSON.stringify(result) + "\\n\`\`\`\\n");
});
`;
  writeFileSync(file, body);
  chmodSync(file, 0o755);
  return file;
}

const lines = (file: string): number => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).length : 0);

export async function createSandbox(opts: { origin?: boolean } = {}): Promise<Sandbox> {
  const root = mkdtempSync(join(tmpdir(), "odd-bench-"));
  const home = join(root, "home"), repo = join(root, "repo"), binDir = join(root, "bin"), logs = join(root, "logs");
  const dataDir = join(root, "plugin-data"), claudeConfig = join(root, "claude-config"), xdg = join(root, "xdg");
  for (const d of [home, repo, binDir, logs, dataDir, claudeConfig, join(xdg, "config"), join(xdg, "data"), join(xdg, "cache")]) mkdirSync(d, { recursive: true });
  const basePath = process.env.PATH ?? "/usr/bin:/bin";
  const realGit = execFileSync("sh", ["-c", "command -v git"], { env: { PATH: basePath }, encoding: "utf8" }).trim();
  const gitLog = join(logs, "git.log"), claudeLog = join(logs, "claude.log");
  installCountingShim(binDir, "git", gitLog, { forwardTo: realGit });
  const planFile = join(home, VERDICT_FILE);
  installReviewerShim(binDir, claudeLog, planFile);
  const identity = { GIT_AUTHOR_NAME: "odd-bench", GIT_AUTHOR_EMAIL: "bench@example.invalid", GIT_COMMITTER_NAME: "odd-bench", GIT_COMMITTER_EMAIL: "bench@example.invalid" };
  // Built from scratch: no ANTHROPIC_*/CLAUDE_*/AWS_* or any other parent variable leaks in; every config/data/cache location is inside the sandbox.
  const env: NodeJS.ProcessEnv = {
    HOME: home, PATH: `${binDir}:${basePath}`, TMPDIR: process.env.TMPDIR, LANG: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
    CLAUDE_PLUGIN_DATA: dataDir, CLAUDE_CONFIG_DIR: claudeConfig, XDG_CONFIG_HOME: join(xdg, "config"), XDG_DATA_HOME: join(xdg, "data"), XDG_CACHE_HOME: join(xdg, "cache"),
    ...identity,
  };
  const rawGit = (args: readonly string[], cwd = repo): string => execFileSync(realGit, [...args], { cwd, env: { ...env, PATH: basePath }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  rawGit(["init", "-q", "-b", "main"]);
  writeFileSync(join(repo, "README.md"), "# sandbox\n");
  rawGit(["add", "README.md"]);
  rawGit(["commit", "-q", "-m", "bench: initial"]);
  let origin: string | undefined;
  if (opts.origin) {
    origin = join(root, "origin.git");
    rawGit(["init", "-q", "--bare", "-b", "main", origin], root);
    rawGit(["remote", "add", "origin", origin]);
    rawGit(["push", "-q", "origin", "main"]);
  }
  const resetCounters = (): void => { for (const f of [gitLog, claudeLog]) writeFileSync(f, ""); };
  resetCounters();
  return {
    root, home, repo, dataDir, ...(origin !== undefined ? { origin } : {}), env,
    setVerdicts: (plan) => writeFileSync(planFile, JSON.stringify(plan)),
    git: (args) => rawGit(args),
    countGit: () => lines(gitLog),
    countModelRuns: () => lines(claudeLog),
    resetCounters,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
