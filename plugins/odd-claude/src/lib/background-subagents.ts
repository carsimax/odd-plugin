// Background subagents policy (R12). Stored as plugin-wide state `background-subagents` ({ policy }).
// Resolution: stored state > env ODD_CLAUDE_BACKGROUND_SUBAGENTS ("on"|"off") > default "off".
// A present-but-malformed state file fails closed to "off" and stays attributed to the state.
import { readPluginState, writePluginState, resolveDataDir, type StateOptions } from "./state.js";
import { existsSync } from "node:fs";
import { join } from "node:path";

export const BACKGROUND_POLICIES = ["on", "off"] as const;
export type BackgroundPolicy = (typeof BACKGROUND_POLICIES)[number];
export const BACKGROUND_ENV = "ODD_CLAUDE_BACKGROUND_SUBAGENTS";

export interface BackgroundResolution {
  policy: BackgroundPolicy;
  source: "state" | "environment" | "default";
  malformed: boolean;
}

function isPolicy(v: unknown): v is BackgroundPolicy {
  return v === "on" || v === "off";
}

export function resolveBackgroundSubagents(opts: StateOptions = {}): BackgroundResolution {
  const env = opts.env ?? process.env;
  try {
    // existsSync distinguishes "no state file" from "state file with unusable content".
    const file = join(resolveDataDir(opts), "background-subagents.json");
    if (existsSync(file)) {
      const policy = readPluginState("background-subagents", opts).policy;
      return isPolicy(policy)
        ? { policy, source: "state", malformed: false }
        : { policy: "off", source: "state", malformed: true };
    }
  } catch {
    // no data dir: fall through to env/default
  }
  const fromEnv = env[BACKGROUND_ENV];
  if (isPolicy(fromEnv)) return { policy: fromEnv, source: "environment", malformed: false };
  return { policy: "off", source: "default", malformed: false };
}

export function readBackgroundSubagents(opts: StateOptions = {}): BackgroundPolicy {
  return resolveBackgroundSubagents(opts).policy;
}

/** Validates then stores; throws on an invalid policy without touching the stored value. */
export function writeBackgroundSubagents(policy: string, opts: StateOptions = {}): BackgroundPolicy {
  if (!isPolicy(policy)) {
    throw new Error(`invalid policy ${JSON.stringify(policy)}; available policies: ${BACKGROUND_POLICIES.join(", ")}`);
  }
  writePluginState("background-subagents", { policy }, opts);
  return policy;
}

/** One line for the SessionStart context so the orchestrator knows how to launch Agent. */
export function backgroundSubagentsLine(policy: BackgroundPolicy): string {
  return policy === "on"
    ? "Background subagents: on — launch independent, non-blocking Agent work with run_in_background: true and keep working; collect results when notified."
    : "Background subagents: off — run Agent calls in the foreground (do not set run_in_background) unless the user asks for background work.";
}
