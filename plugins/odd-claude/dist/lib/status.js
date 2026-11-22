// Read-only status (R38 status semantics): plugin, data dir, session state, hooks, roadmap.
import { listSessionIds, readSessionState } from "./state.js";
export const ROADMAP_PHASE = "v2.3: simplification in progress (mods, banner, themes, statusline removed)";
export function collectStatus(deps) {
    const dataDir = deps.env.CLAUDE_PLUGIN_DATA || null;
    let id = null;
    let origin = "none";
    if (deps.sessionId)
        [id, origin] = [deps.sessionId, "flag"];
    else if (deps.env.CLAUDE_SESSION_ID)
        [id, origin] = [deps.env.CLAUDE_SESSION_ID, "env"];
    else if (dataDir) {
        const latest = listSessionIds({ dataDir })[0];
        if (latest !== undefined)
            [id, origin] = [latest, "latest"];
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
export function renderStatus(s) {
    const keys = Object.keys(s.session.state);
    const summary = s.session.id === null
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
