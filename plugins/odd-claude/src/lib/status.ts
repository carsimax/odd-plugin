// Read-only status (R38 status semantics): plugin, data dir, session state, hooks, roadmap.
import { listSessionIds, readSessionState, type StateData } from "./state.js";

export const ROADMAP_PHASE = "v5.0: refinement round shipped";

export interface StatusDeps {
  pluginVersion: string;
  env: Record<string, string | undefined>;
  /** Hook events registered in hooks/hooks.json. */
  hooks: () => string[];
  /** Explicit session id (CLI flag); wins over the environment. */
  sessionId?: string;
}

export interface StatusReport {
  schema: 1;
  pluginVersion: string;
  dataDir: string | null;
  session: { id: string | null; origin: "flag" | "env" | "latest" | "none"; state: StateData };
  hooks: string[];
  roadmapPhase: string;
}

export function collectStatus(deps: StatusDeps): StatusReport {
  const dataDir = deps.env.CLAUDE_PLUGIN_DATA || null;
  let id: string | null = null;
  let origin: StatusReport["session"]["origin"] = "none";
  if (deps.sessionId) [id, origin] = [deps.sessionId, "flag"];
  else if (deps.env.CLAUDE_SESSION_ID) [id, origin] = [deps.env.CLAUDE_SESSION_ID, "env"];
  else if (dataDir) {
    const latest = listSessionIds({ dataDir })[0];
    if (latest !== undefined) [id, origin] = [latest, "latest"];
  }
  const state = id !== null && dataDir ? readSessionState(id, { dataDir }) : {};
  return {
    schema: 1,
    pluginVersion: deps.pluginVersion,
    dataDir,
    session: { id, origin, state },
    hooks: deps.hooks(),
    roadmapPhase: ROADMAP_PHASE,
  };
}

export function renderStatus(s: StatusReport): string {
  const keys = Object.keys(s.session.state);
  const summary =
    s.session.id === null
      ? "session: none"
      : `session: ${s.session.id} (${s.session.origin})` +
        (keys.length === 0 ? " no state recorded" : ` ${keys.map((k) => `${k}=${JSON.stringify(s.session.state[k])}`).join(" ")}`);
  return [
    `odd-claude ${s.pluginVersion}`,
    `data dir: ${s.dataDir ?? "not set"}`,
    summary,
    `hooks: ${s.hooks.length === 0 ? "none" : s.hooks.join(", ")}`,
    `roadmap: ${s.roadmapPhase}`,
  ].join("\n");
}
