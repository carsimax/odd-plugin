import { spawn } from "node:child_process";

export interface ProcessResult { code: number | null; stdout: string; stderr: string; timedOut: boolean; ms: number }
export interface ProcessOptions { cwd?: string; env?: NodeJS.ProcessEnv; stdin?: string; deadlineMs: number }

/** Runs one fresh process; SIGKILLs it when the deadline passes. Never throws for a non-zero exit. */
export function runProcess(command: string, args: readonly string[], opts: ProcessOptions): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const child = spawn(command, [...args], { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "", timedOut = false;
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, opts.deadlineMs);
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut, ms: performance.now() - t0 }); });
    child.stdin.on("error", () => {});
    child.stdin.end(opts.stdin ?? "");
  });
}
