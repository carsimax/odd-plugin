// Explicit trust for the codegraph SessionStart warm-up (R1-001). A `.codegraph/` directory comes from the
// repository and proves nothing, so the warm-up needs a signal the repository cannot plant:
//  - the project path recorded in plugin state (<dataDir>/codegraph-trust.json) by the user running
//    `node dist/cli/codegraph-trust.js --action trust --cwd <dir>`, or
//  - ODD_CLAUDE_CODEGRAPH_WARMUP=1 in the user's own environment (all projects).
// Default: no warm-up. Never throws.
import { resolve } from "node:path";
import { readPluginState, writePluginState, type StateOptions } from "./state.js";

export const WARMUP_TRUST_ENV = "ODD_CLAUDE_CODEGRAPH_WARMUP";
const STATE_NAME = "codegraph-trust";

export function listTrustedProjects(opts: StateOptions = {}): string[] {
  try {
    const p = readPluginState(STATE_NAME, opts).projects;
    return Array.isArray(p) ? p.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function isTrustedProject(cwd: string, env: Record<string, string | undefined>, opts: StateOptions = {}): boolean {
  const v = env[WARMUP_TRUST_ENV];
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  return listTrustedProjects(opts).includes(resolve(cwd));
}

/** Throws when there is no data dir (the explicit user action must not silently do nothing). */
export function trustProject(cwd: string, opts: StateOptions = {}): void {
  const abs = resolve(cwd);
  const current = listTrustedProjects(opts);
  if (!current.includes(abs)) writePluginState(STATE_NAME, { projects: [...current, abs] }, opts);
}

export function untrustProject(cwd: string, opts: StateOptions = {}): void {
  const abs = resolve(cwd);
  writePluginState(STATE_NAME, { projects: listTrustedProjects(opts).filter((p) => p !== abs) }, opts);
}
