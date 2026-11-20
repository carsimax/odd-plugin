// Test-only: a FAKE `claude` executable (a node script) for the runner specs. The real binary is never called.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface FakeBehavior {
  stdout?: string;
  stderr?: string;
  exit?: number;
  /** Sleep this long before answering (timeout tests). */
  sleepMs?: number;
  /** Emit this many bytes of stdout (output cap tests). */
  hugeBytes?: number;
  /** Leave a background grandchild (same process group) running; its pid goes to `<dir>/grandchild.pid`. */
  grandchild?: boolean | "holds-stdout" | "escapes";
  // "escapes": the grandchild leaves the process group (detached) while still holding stdout.
  /** Exit at once without reading stdin (EPIPE on a large prompt). */
  noRead?: boolean;
  /** After writing, stay alive (and ignore a closed stdout) until killed: the runner must kill it. */
  lingerAfterWrite?: boolean;
}

export interface FakeClaude {
  dir: string;
  binary: string;
  recordFile: string;
}

export interface FakeRecord {
  args: string[];
  cwd: string;
  stdin: string;
  pid: number;
  env: Record<string, string | undefined>;
  cwdEntries: string[];
}

/** Writes `<dir>/bin/claude`; it records args/cwd/env/stdin to `<dir>/record.json` and then follows `behavior`. */
export function makeFakeClaude(behavior: FakeBehavior = {}): FakeClaude {
  const dir = mkdtempSync(join(tmpdir(), "odd-fake-claude-"));
  mkdirSync(join(dir, "bin"));
  const binary = join(dir, "bin", "claude");
  const recordFile = join(dir, "record.json");
  const script = `#!${process.execPath}
const fs = require("node:fs");
const behavior = ${JSON.stringify(behavior)};
if (behavior.grandchild) {
  const gc = require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(()=>{}, 60000)"], { stdio: behavior.grandchild === "holds-stdout" || behavior.grandchild === "escapes" ? ["ignore", "inherit", "ignore"] : "ignore", detached: behavior.grandchild === "escapes" });
  gc.unref();
  fs.writeFileSync(${JSON.stringify(join(dir, "grandchild.pid"))}, String(gc.pid));
}
if (behavior.noRead) {
  process.stderr.write(behavior.stderr || "");
  process.stdout.write(behavior.stdout || "");
  process.exit(behavior.exit || 0);
}
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { stdin += c; });
process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(recordFile)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), stdin, pid: process.pid, env: process.env, cwdEntries: fs.readdirSync(process.cwd()) }));
  const answer = () => {
    if (behavior.lingerAfterWrite) { process.stdout.on("error", () => {}); setInterval(() => {}, 1000); }
    if (behavior.stderr) process.stderr.write(behavior.stderr);
    if (behavior.hugeBytes) process.stdout.write("x".repeat(behavior.hugeBytes));
    else if (behavior.stdout) process.stdout.write(behavior.stdout);
    process.exitCode = behavior.exit || 0;
  };
  if (behavior.sleepMs) setTimeout(answer, behavior.sleepMs); else answer();
});
`;
  writeFileSync(binary, script);
  chmodSync(binary, 0o755);
  return { dir, binary, recordFile };
}

/** Pid of the background grandchild the fake left behind, or null when none was started. */
export function grandchildPid(fake: FakeClaude): number | null {
  try {
    return Number(readFileSync(join(fake.dir, "grandchild.pid"), "utf8"));
  } catch {
    return null;
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Test cleanup: SIGKILL a pid that must already be dead (never throws). */
export function reap(pid: number | null): void {
  if (pid === null) return;
  try { process.kill(pid, "SIGKILL"); } catch { /* already dead */ }
}
