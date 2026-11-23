// The one bare pid probe (`kill(pid, 0)`). It says nothing about host, boot or start time: callers that need that
// proof (review/lock.ts) layer it on top. EPERM means the process exists but is not ours, so it counts as alive.
export type PidState = "alive" | "dead" | "unknown" | "invalid";

/** invalid: not a positive integer (never signalled: 0 and negatives would target process groups). dead: ESRCH. unknown: any other error. */
export function pidState(pid: number): PidState {
  if (!Number.isInteger(pid) || pid <= 0) return "invalid";
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM") return "alive";
    return code === "ESRCH" ? "dead" : "unknown";
  }
}

export function isPidAlive(pid: number): boolean {
  return pidState(pid) === "alive";
}
