#!/usr/bin/env node
// R07 spike sender (throwaway).
//   node send.mjs <recipient-session-id> "<message>"   write a message into the recipient's mailbox
//   node send.mjs --list                               known session ids from logged SessionStart inputs
import { existsSync, linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;
const spikeDir = () => process.env.ODD_R07_SPIKE_DIR || join(tmpdir(), "odd-r07-spike");

export function listSessions(root = spikeDir()) {
  const f = join(root, "hook-inputs.jsonl");
  if (!existsSync(f)) return [];
  const seen = new Map();
  for (const line of readFileSync(f, "utf8").split("\n")) {
    if (!line) continue;
    try {
      const e = JSON.parse(line);
      if (e.event === "SessionStart" && e.input && typeof e.input.session_id === "string") {
        seen.set(e.input.session_id, { session_id: e.input.session_id, cwd: e.input.cwd, source: e.input.source, at: e.logged_at });
      }
    } catch { /* skip bad line */ }
  }
  return [...seen.values()];
}

export function send(recipient, message, { root = spikeDir(), sender = process.env.ODD_R07_SENDER || `pid-${process.pid}` } = {}) {
  if (!SAFE_ID.test(recipient) || recipient === "." || recipient === "..") throw new Error(`invalid session id: ${recipient}`);
  const inbox = join(root, "mailbox", recipient);
  mkdirSync(inbox, { recursive: true });
  const tmp = join(inbox, `.tmp-${process.pid}-${randomBytes(4).toString("hex")}`);
  // Claim the next sequence number atomically: link() fails with EEXIST if the seq file exists.
  for (let seq = nextSeq(root, recipient); ; seq++) {
    const msg = { seq, sent_at: new Date().toISOString(), sender, recipient, message };
    writeFileSync(tmp, JSON.stringify(msg, null, 2));
    const final = join(inbox, `${String(seq).padStart(6, "0")}.json`);
    try { linkSync(tmp, final); unlinkSync(tmp); return { ...msg, path: final }; }
    catch (e) { if (e.code !== "EEXIST") { try { unlinkSync(tmp); } catch {} throw e; } }
  }
}

// Sequence is per recipient and counts delivered messages too, so it never repeats.
function nextSeq(root, recipient) {
  let max = 0;
  for (const sub of ["mailbox", "delivered"]) {
    try {
      for (const n of readdirSyncSafe(join(root, sub, recipient))) {
        const m = /^(\d+)\.json$/.exec(n);
        if (m) max = Math.max(max, Number(m[1]));
      }
    } catch {}
  }
  return max + 1;
}
import { readdirSync } from "node:fs";
function readdirSyncSafe(p) { try { return readdirSync(p); } catch { return []; } }

if (process.argv[1] && process.argv[1].endsWith("send.mjs")) {
  const args = process.argv.slice(2);
  try {
    if (args[0] === "--list") {
      const s = listSessions();
      if (s.length === 0) console.log("(no sessions logged yet)");
      for (const x of s) console.log(`${x.session_id}\t${x.source ?? ""}\t${x.cwd ?? ""}\t${x.at}`);
    } else if (args.length === 2) {
      const r = send(args[0], args[1]);
      console.log(`sent seq=${r.seq} at=${r.sent_at} -> ${r.path}`);
    } else {
      console.error('usage: node send.mjs <recipient-session-id> "<message>" | node send.mjs --list');
      process.exit(2);
    }
  } catch (e) { console.error(String(e.message || e)); process.exit(1); }
}
