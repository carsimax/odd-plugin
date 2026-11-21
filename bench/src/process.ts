import { spawn } from "node:child_process";

export interface ProcessResult { code: number | null; stdout: string; stderr: string; timedOut: boolean; ms: number }
export interface ProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdin?: string;
  /** Per-process deadline: the process is SIGKILLed when it passes and the result says `timedOut`. Not the journey's deadline (see `Journey.deadlineMs`). */
  deadlineMs: number;
  /** Aborting kills the child and rejects (the journey ended; nobody waits for this process any more). */
  signal?: AbortSignal;
}

/** Runs one fresh process; SIGKILLs it when the deadline passes. Never throws for a non-zero exit; rejects when it cannot start or the signal aborts. */
export function runProcess(command: string, args: readonly string[], opts: ProcessOptions): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new Error(`${command} aborted before it started`));
    const t0 = performance.now();
    const child = spawn(command, [...args], { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "", timedOut = false;
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, opts.deadlineMs);
    const onAbort = (): void => { clearTimeout(timer); child.kill("SIGKILL"); reject(new Error(`${command} aborted`)); };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const done = (): void => { clearTimeout(timer); opts.signal?.removeEventListener("abort", onAbort); };
    child.on("error", (e) => { done(); reject(e); });
    child.on("close", (code) => { done(); resolve({ code, stdout, stderr, timedOut, ms: performance.now() - t0 }); });
    child.stdin.on("error", () => {});
    child.stdin.end(opts.stdin ?? "");
  });
}
