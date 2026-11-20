// Crash-injection child for store.spec.ts. Usage: <op> <commonDir> <lineage> <killAt> <phase>
//   op = create | update | receipt; phase = before | after.
// Every interesting node:fs call under <commonDir> (open, write, fsync, fchmod, close, rename, mkdir, rm; the LOCK
// directory is excluded) is numbered. killAt = 0 only counts and prints {"n":<count>,"labels":[...]}; killAt = k sends
// SIGKILL to this process right before (phase "before") or right after (phase "after") the k-th call.
// Test-only: it patches node:fs in this child process, never in production code.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";

const [op = "", cd = "", lin = "", killAtS = "0", phase = "before"] = process.argv.slice(2);

async function main(): Promise<void> {
  const killAt = Number(killAtS);
  const tracked = new Set<number>();
  const labels: string[] = [];
  let n = 0;
  const interesting = (p: unknown): p is string => typeof p === "string" && p.startsWith(cd) && !p.includes("/LOCK");
  const ev = <T>(label: string, fn: () => T): T => {
    n++;
    labels.push(label);
    if (n === killAt && phase === "before") process.kill(process.pid, "SIGKILL");
    const r = fn();
    if (n === killAt && phase === "after") process.kill(process.pid, "SIGKILL");
    return r;
  };
  type Fn = (...a: unknown[]) => unknown;
  const m = fs as unknown as Record<string, Fn>;
  const o: Record<string, Fn> = {};
  for (const k of ["openSync", "writeSync", "fsyncSync", "fchmodSync", "closeSync", "renameSync", "mkdirSync", "rmSync"]) o[k] = m[k]!;
  m.openSync = (p, ...a) => {
    if (!interesting(p)) return o.openSync!(p, ...a);
    const fd = ev(`open ${p.slice(cd.length)}`, () => o.openSync!(p, ...a)) as number;
    tracked.add(fd);
    return fd;
  };
  for (const k of ["writeSync", "fsyncSync", "fchmodSync"]) {
    m[k] = (fd, ...a) => (tracked.has(fd as number) ? ev(k, () => o[k]!(fd, ...a)) : o[k]!(fd, ...a));
  }
  m.closeSync = (fd) => {
    if (!tracked.has(fd as number)) return o.closeSync!(fd);
    tracked.delete(fd as number);
    return ev("close", () => o.closeSync!(fd));
  };
  m.renameSync = (a, b) => (interesting(a) ? ev(`rename ${(a as string).slice(cd.length)}`, () => o.renameSync!(a, b)) : o.renameSync!(a, b));
  m.mkdirSync = (p, ...a) =>
    interesting(p) && !(a[0] as { recursive?: boolean } | undefined)?.recursive ? ev(`mkdir ${p.slice(cd.length)}`, () => o.mkdirSync!(p, ...a)) : o.mkdirSync!(p, ...a);
  m.rmSync = (p, ...a) => (interesting(p) ? ev(`rm ${p.slice(cd.length)}`, () => o.rmSync!(p, ...a)) : o.rmSync!(p, ...a));
  syncBuiltinESMExports();

  const { createState, readState, updateState, writeReceipt } = await import("./store.js");
  const { bump, mkRecord } = await import("./store-child.testkit.js");
  const L = { lock: { timeoutMs: 20_000, pollMs: 5 } };
  if (op === "create") await createState(cd, mkRecord(lin, 0), L);
  else if (op === "update") await updateState(cd, lin, readState(cd, lin).revision, bump, L);
  else if (op === "receipt") await writeReceipt(cd, lin, { r: "x".repeat(5000) }, L);
  else throw new Error(`unknown op ${op}`);
  process.stdout.write(`${JSON.stringify({ n, labels })}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then(
    () => process.exit(0),
    (e) => {
      process.stderr.write(`${(e as Error).stack ?? e}\n`);
      process.exit(2);
    },
  );
}
