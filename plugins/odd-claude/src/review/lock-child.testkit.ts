// Child process for lock.spec.ts. Modes:
//   loop <root> <counterFile> <iterations> <insideMarker> <overlapLog>
//     acquire -> (marker wx, read counter, write counter+1, marker rm) -> release, `iterations` times.
//   hold <root> <readyFile>
//     acquire, write readyFile, then stay alive until killed.
import { appendFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { acquireStoreLock } from "./lock.js";

const [mode, root, a, b, c, d] = process.argv.slice(2);

async function main(): Promise<void> {
  if (mode === "loop") {
    const [counter, iterations, marker, overlapLog] = [a, Number(b), c, d];
    for (let i = 0; i < iterations; i++) {
      const lock = await acquireStoreLock(root, { timeoutMs: 30_000, pollMs: 5 });
      try {
        try {
          writeFileSync(marker, String(process.pid), { flag: "wx" });
        } catch {
          appendFileSync(overlapLog, `overlap pid=${process.pid}\n`);
        }
        const n = Number(readFileSync(counter, "utf8"));
        writeFileSync(counter, String(n + 1));
        rmSync(marker, { force: true });
      } finally {
        const r = lock.release();
        if (r.status !== "released") appendFileSync(overlapLog, `release ${r.status} pid=${process.pid}\n`);
      }
    }
    return;
  }
  if (mode === "hold") {
    await acquireStoreLock(root, { timeoutMs: 5_000 });
    writeFileSync(a, "ready");
    setInterval(() => undefined, 1_000);
    return;
  }
  throw new Error(`unknown mode ${mode}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
