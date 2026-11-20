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
  /** Environment for processes the journey spawns: own HOME, shimmed PATH, fixed git identity. */
  env: NodeJS.ProcessEnv;
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

const lines = (file: string): number => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).length : 0);

export async function createSandbox(opts: { origin?: boolean } = {}): Promise<Sandbox> {
  const root = mkdtempSync(join(tmpdir(), "odd-bench-"));
  const home = join(root, "home"), repo = join(root, "repo"), binDir = join(root, "bin"), logs = join(root, "logs");
  for (const d of [home, repo, binDir, logs]) mkdirSync(d);
  const basePath = process.env.PATH ?? "/usr/bin:/bin";
  const realGit = execFileSync("sh", ["-c", "command -v git"], { env: { PATH: basePath }, encoding: "utf8" }).trim();
  const gitLog = join(logs, "git.log"), claudeLog = join(logs, "claude.log");
  installCountingShim(binDir, "git", gitLog, { forwardTo: realGit });
  installCountingShim(binDir, "claude", claudeLog, { canned: "odd-bench fake claude: no model was run" });
  const identity = { GIT_AUTHOR_NAME: "odd-bench", GIT_AUTHOR_EMAIL: "bench@example.invalid", GIT_COMMITTER_NAME: "odd-bench", GIT_COMMITTER_EMAIL: "bench@example.invalid" };
  const env: NodeJS.ProcessEnv = { HOME: home, PATH: `${binDir}:${basePath}`, TMPDIR: process.env.TMPDIR, LANG: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(home, ".gitconfig"), ...identity };
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
    root, home, repo, ...(origin !== undefined ? { origin } : {}), env,
    git: (args) => rawGit(args),
    countGit: () => lines(gitLog),
    countModelRuns: () => lines(claudeLog),
    resetCounters,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
