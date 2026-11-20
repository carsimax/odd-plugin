// Child process for store.spec.ts. Modes:
//   loop <commonDir> <lineage> <successes> <logFile> <staleEvery>
//     read-CAS-update loop: bumps a counter embedded in target_identity until it has applied `successes` updates.
//     Every `staleEvery`-th attempt deliberately uses a stale expected revision. Logs `ok <from> <to>` for each applied
//     update and `conflict <expected> <current>` for each ConcurrentUpdate rejection. Any other error is logged and fatal.
//   crash <commonDir> <lineage> <readyFile>
//     updateState whose rename is intercepted (test-only fs injection, see patchRename): the temp is written and fsynced,
//     then readyFile is written and the child blocks forever, so the parent can SIGKILL it mid-write.
//   create <commonDir> <lineage> <n> | receipt <commonDir> <lineage> <tag>
//     one createState (counter n) / writeReceipt ({writer: tag}); prints {"ok":true} or {"ok":false,"name":<error name>}.
import fs, { appendFileSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";
import { StoreConcurrentUpdateError, createState, readState, updateState, writeReceipt } from "./store.js";
import { start, stateRevision, type Outcome, type StateRecord } from "./state.js";

/** Test-only seam: runs `hook(from, to)` before every rename inside node:fs. Returns the restore function. */
export function patchRename(hook: (from: string, to: string) => void): () => void {
  const mutable = fs as unknown as { renameSync: (a: string, b: string) => void };
  const real = mutable.renameSync;
  mutable.renameSync = (a, b) => {
    hook(String(a), String(b));
    return real(a, b);
  };
  syncBuiltinESMExports();
  return () => {
    mutable.renameSync = real;
    syncBuiltinESMExports();
  };
}

export function mkRecord(lineage: string, n = 0): StateRecord {
  const hex = (c: string, len: number) => c.repeat(len).slice(0, len);
  const out = start({
    lineageId: lineage,
    targetIdentity: `sha256:${n.toString(16).padStart(64, "0")}`,
    projection: "workspace",
    baseTree: hex("b", 40),
    candidateTree: hex("c", 40),
    riskLevel: "medium",
    selectedLenses: ["reliability"],
    originalChangedLines: 8,
    now: "2026-11-19T10:00:00.000Z",
  });
  if (!out.ok) throw new Error("start failed");
  return out.record;
}

const [mode, commonDir = "", lineage = "", a = "", b = "", c = ""] = process.argv.slice(2);
const LOCK_OPTS = { timeoutMs: 60_000, pollMs: 5 };

export function counterOf(record: StateRecord): number {
  return parseInt(record.target_identity.slice("sha256:".length), 16);
}

export function bump(record: StateRecord): Outcome {
  const next = { ...record, target_identity: `sha256:${(counterOf(record) + 1).toString(16).padStart(64, "0")}` };
  next.revision = stateRevision(next);
  return { ok: true, record: next };
}

async function main(): Promise<void> {
  if (mode === "loop") {
    const [successes, logFile, staleEvery] = [Number(a), b, Number(c)];
    const stale = readState(commonDir, lineage).revision;
    let applied = 0;
    let attempt = 0;
    while (applied < successes) {
      attempt++;
      const current = readState(commonDir, lineage);
      const expected = staleEvery > 0 && attempt % staleEvery === 0 ? stale : current.revision;
      try {
        const out = await updateState(commonDir, lineage, expected, bump, { lock: LOCK_OPTS });
        appendFileSync(logFile, `ok ${expected} ${out.record.revision}\n`);
        applied++;
      } catch (e) {
        if (!(e instanceof StoreConcurrentUpdateError)) {
          appendFileSync(logFile, `fatal ${(e as Error).name}: ${(e as Error).message}\n`);
          process.exit(3);
        }
        appendFileSync(logFile, `conflict ${expected} ${e.currentRevision}\n`);
      }
    }
    return;
  }
  if (mode === "crash") {
    const current = readState(commonDir, lineage);
    patchRename((from) => {
      if (!from.includes("/.atomic-")) return;
      writeFileSync(a, "ready");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); // blocks until SIGKILL
    });
    await updateState(commonDir, lineage, current.revision, bump, { lock: LOCK_OPTS });
    return;
  }
  if (mode === "create" || mode === "receipt") {
    const lock = { timeoutMs: 60_000, pollMs: 5 };
    let result: { ok: boolean; name?: string };
    try {
      if (mode === "create") await createState(commonDir, mkRecord(lineage, Number(a)), { lock });
      else await writeReceipt(commonDir, lineage, { writer: a, pad: "x".repeat(1000) }, { lock });
      result = { ok: true };
    } catch (e) {
      result = { ok: false, name: (e as Error).name };
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  throw new Error(`unknown mode ${mode}`);
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
