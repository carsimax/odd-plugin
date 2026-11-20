// Test-only crash injection for the REAL MCP server process: `node --import <this file> dist-test/mcp/review-server.js`.
// Environment (all required, otherwise the preload does nothing):
//   ODD_KILL_CD    <git-common-dir>: only node:fs calls under it are counted (the LOCK directory is excluded)
//   ODD_KILL_ARM   a path OUTSIDE ODD_KILL_CD; counting starts when that file exists (the test creates it right before the
//                  one tool call it wants to crash, so earlier calls of the same process never consume the budget)
//   ODD_KILL_LOG   a path OUTSIDE ODD_KILL_CD; after every counted call it is rewritten with {"n":..,"labels":[..]}
//   ODD_KILL_AT    k >= 1: SIGKILL this process right before (ODD_KILL_PHASE=before) or right after (=after) the k-th call;
//                  0 only counts
// It patches node:fs in this process only, never production code. The kill is `process.kill(pid, "SIGKILL")`: no handler,
// no flush, no `finally`, exactly kill -9.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const cd = process.env.ODD_KILL_CD ?? "";
const arm = process.env.ODD_KILL_ARM ?? "";
const log = process.env.ODD_KILL_LOG ?? "";
const killAt = Number(process.env.ODD_KILL_AT ?? "0");
const phase = process.env.ODD_KILL_PHASE ?? "before";

if (cd !== "" && arm !== "" && log !== "") {
  type Fn = (...a: unknown[]) => unknown;
  const m = fs as unknown as Record<string, Fn>;
  const o: Record<string, Fn> = {};
  for (const k of ["openSync", "writeSync", "fsyncSync", "fchmodSync", "closeSync", "renameSync", "mkdirSync", "rmSync", "existsSync", "writeFileSync"]) o[k] = m[k]!;
  const tracked = new Set<number>();
  const labels: string[] = [];
  let n = 0;
  const interesting = (p: unknown): p is string => typeof p === "string" && p.startsWith(cd) && !p.includes("/LOCK");
  const armed = (): boolean => o.existsSync!(arm) as boolean;
  const ev = <T>(label: string, fn: () => T): T => {
    if (!armed()) return fn();
    n++;
    labels.push(label);
    o.writeFileSync!(log, JSON.stringify({ n, labels }));
    if (n === killAt && phase === "before") process.kill(process.pid, "SIGKILL");
    const r = fn();
    if (n === killAt && phase === "after") process.kill(process.pid, "SIGKILL");
    return r;
  };
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
}
