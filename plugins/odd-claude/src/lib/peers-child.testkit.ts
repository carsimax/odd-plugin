// Child process for peers.spec.ts concurrency tests.
// argv: <send|take> <dataDir> <recipient> <goFile> [sender] [text]
// Busy-waits until <goFile> exists (barrier), runs one operation, prints one JSON line.
import { existsSync } from "node:fs";
import { send, take, PeersError } from "./peers.js";

const [mode, dataDir, recipient, goFile, sender, text] = process.argv.slice(2);
while (!existsSync(goFile)) {
  // spin: all children start the real operation at about the same time
}
try {
  if (mode === "send") {
    const r = send(recipient, { from: sender, reason: "concurrency test", message: text }, { dataDir });
    console.log(JSON.stringify({ ok: true, seq: r.seq }));
  } else {
    const msgs = take(recipient, { dataDir });
    console.log(JSON.stringify({ ok: true, texts: msgs.map((m) => m.message), seqs: msgs.map((m) => m.seq) }));
  }
} catch (err) {
  console.log(JSON.stringify({ ok: false, code: err instanceof PeersError ? err.code : "other", error: String(err) }));
}
