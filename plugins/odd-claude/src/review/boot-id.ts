// Boot / pid-namespace identity for the review store lock. `kill(pid, 0)` only means something inside the pid namespace
// (and boot) that owns the pid, and a machine id file can be shared (container mounting ~/.local/state, NFS home). So a
// lock may be judged dead by pid only when the owner recorded the SAME machine id AND the SAME boot identity.
//   Linux: /proc/sys/kernel/random/boot_id + the pid namespace link of /proc/self/ns/pid, e.g. "<uuid>/pid:[4026531836]"
//          (a container shares the host boot_id but not the pid namespace).
//   macOS: `kern.bootsessionuuid` (a per-boot UUID) via one cached `/usr/sbin/sysctl -n` call (absolute path, 1 s timeout).
// Anything else, or any failure, is `undefined` (callers use the hostname rule). Nothing here throws.
import { spawnSync } from "node:child_process";
import { closeSync, constants, fstatSync, openSync, readlinkSync, readSync } from "node:fs";

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const NS_RE = /^pid:\[[0-9]{1,20}\]$/;
const BOOT_RE = /^[0-9A-Za-z:\[\]/_.-]{1,128}$/;

export function isBootId(v: unknown): v is string {
  return typeof v === "string" && BOOT_RE.test(v);
}

/** Linux: joins the boot_id file text and the pid namespace link text. undefined unless both are strictly valid. */
export function parseLinuxBoot(bootIdText: string | undefined, pidNsLink: string | undefined): string | undefined {
  if (bootIdText === undefined || pidNsLink === undefined) return undefined;
  const id = bootIdText.trim();
  const ns = pidNsLink.trim();
  if (!UUID_RE.test(id) || !NS_RE.test(ns)) return undefined;
  return `${id.toLowerCase()}/${ns}`;
}

/** macOS: the `kern.bootsessionuuid` output. */
export function parseMacBoot(out: string | undefined): string | undefined {
  if (out === undefined) return undefined;
  const id = out.trim();
  return UUID_RE.test(id) ? `mac:${id.toLowerCase()}` : undefined;
}

export interface BootReaders {
  platform: NodeJS.Platform;
  /** Bounded text of a file (<= 128 bytes) or undefined. */
  readText(path: string): string | undefined;
  readLink(path: string): string | undefined;
  sysctl(name: string): string | undefined;
}

function boundedRead(path: string): string | undefined {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch {
    return undefined;
  }
  try {
    if (!fstatSync(fd).isFile()) return undefined; // /proc files report size 0: only the type is checked
    const buf = Buffer.alloc(129);
    let n = 0;
    for (;;) {
      const r = readSync(fd, buf, n, buf.length - n, null);
      if (r === 0) break;
      n += r;
      if (n > 128) return undefined;
    }
    return buf.subarray(0, n).toString("utf8");
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

/** Absolute path: no PATH lookup that a shadowing binary could answer. */
export const SYSCTL_PATH = "/usr/sbin/sysctl";

export const realReaders: BootReaders = {
  platform: process.platform,
  readText: boundedRead,
  readLink(path) {
    try {
      return readlinkSync(path);
    } catch {
      return undefined;
    }
  },
  sysctl(name) {
    try {
      const r = spawnSync(SYSCTL_PATH, ["-n", name], { timeout: 1000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 4096 });
      return r.status === 0 && typeof r.stdout === "string" ? r.stdout : undefined;
    } catch {
      return undefined;
    }
  },
};

export function readBootId(readers: BootReaders = realReaders): string | undefined {
  try {
    if (readers.platform === "linux") {
      return parseLinuxBoot(readers.readText("/proc/sys/kernel/random/boot_id"), readers.readLink("/proc/self/ns/pid"));
    }
    if (readers.platform === "darwin") return parseMacBoot(readers.sysctl("kern.bootsessionuuid"));
  } catch {
    // fall through
  }
  return undefined;
}

let cached: { value: string | undefined } | undefined;

/** The boot identity of this process, resolved once (a failure is cached: hostname rule for the whole process). */
export function bootId(): string | undefined {
  if (!cached) cached = { value: readBootId() };
  return cached.value;
}
