// Read-only status (R38 status semantics): plugin, data dir, session state, hooks, roadmap.
import { dataDirFromEnv, listSessionIds, readSessionState } from "./state.js";
export const ROADMAP_PHASE = "v5.3: harness research, done-when lint and verifier calibration shipped";
export function collectStatus(deps) {
    const dataDir = dataDirFromEnv(deps.env);
    let id = null;
    let origin = "none";
    if (deps.sessionId)
        [id, origin] = [deps.sessionId, "flag"];
    else if (deps.env.CLAUDE_SESSION_ID)
        [id, origin] = [deps.env.CLAUDE_SESSION_ID, "env"];
    else {
        const latest = listSessionIds({ dataDir })[0];
        if (latest !== undefined)
            [id, origin] = [latest, "latest"];
    }
    const state = id !== null ? readSessionState(id, { dataDir }) : {};
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
        `data dir: ${s.dataDir}`,
        summary,
        `hooks: ${s.hooks.length === 0 ? "none" : s.hooks.join(", ")}`,
        `roadmap: ${s.roadmapPhase}`,
    ].join("\n");
}
