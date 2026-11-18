// statusLine command (R44/R42): reads the Claude Code statusLine JSON on stdin and prints ONE line.
// Never throws: any failure prints a minimal fallback line and exits 0. Honours NO_COLOR and COLUMNS.
// No network, no spawned processes: the git branch comes from reading .git/HEAD.
// Installed by `/odd-claude:setup --statusline on` through the shim <data-dir>/statusline.mjs.
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readDelegationMode } from "../lib/context.js";
import { readPersona } from "../lib/persona.js";
import { atomicWriteFile, resolveDataDir, safeSegment } from "../lib/state.js";
import { FALLBACK_LINE, computeTps, extractUsage, renderStatusline } from "../lib/statusline.js";
/** Current branch (or short sha when detached) read from .git/HEAD, walking up from `dir`. */
export function readBranch(dir) {
    try {
        let d = resolve(dir);
        for (let i = 0; i < 40; i++) {
            const g = join(d, ".git");
            if (existsSync(g)) {
                let gitDir = g;
                if (statSync(g).isFile()) {
                    const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(g, "utf8"));
                    if (!m)
                        return undefined;
                    gitDir = isAbsolute(m[1].trim()) ? m[1].trim() : resolve(d, m[1].trim());
                }
                const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
                const ref = /^ref: refs\/heads\/(.+)$/.exec(head);
                return ref ? ref[1] : /^[0-9a-f]{7,}$/.test(head) ? head.slice(0, 7) : undefined;
            }
            const up = dirname(d);
            if (up === d)
                return undefined;
            d = up;
        }
    }
    catch {
        // no branch segment
    }
    return undefined;
}
function field(o, ...path) {
    let cur = o;
    for (const k of path) {
        if (typeof cur !== "object" || cur === null)
            return undefined;
        cur = cur[k];
    }
    return cur;
}
/** Reads the previous sample, computes tokens/s and stores the new one only when it changed. */
function tokensPerSecond(payload, dataDir) {
    const cur = extractUsage(payload);
    const sid = field(payload, "session_id");
    if (cur === undefined || typeof sid !== "string" || sid === "" || !dataDir)
        return computeTps(cur);
    let file;
    try {
        file = join(resolveDataDir({ dataDir }), "statusline", `${safeSegment(sid)}.json`);
    }
    catch {
        return computeTps(cur);
    }
    let prev;
    try {
        const raw = JSON.parse(readFileSync(file, "utf8"));
        if (typeof raw.outputTokens === "number" && typeof raw.apiMs === "number") {
            prev = { outputTokens: raw.outputTokens, apiMs: raw.apiMs, tps: typeof raw.tps === "number" ? raw.tps : undefined };
        }
    }
    catch {
        prev = undefined;
    }
    const tps = computeTps(cur, prev);
    if (prev === undefined || prev.outputTokens !== cur.outputTokens || prev.apiMs !== cur.apiMs || prev.tps !== tps) {
        try {
            atomicWriteFile(file, JSON.stringify({ ...cur, ...(tps === undefined ? {} : { tps }) }) + "\n");
        }
        catch {
            // read-only or missing data dir: the segment still renders
        }
    }
    return tps;
}
export function statuslineCli(stdin, env, dataDirArg) {
    try {
        const payload = JSON.parse(stdin);
        if (typeof payload !== "object" || payload === null || Array.isArray(payload))
            return { exitCode: 0, stdout: FALLBACK_LINE };
        const dataDir = env.CLAUDE_PLUGIN_DATA || dataDirArg || undefined;
        const stateOpts = dataDir ? { dataDir } : undefined;
        let coordinator;
        let persona;
        if (stateOpts) {
            try {
                coordinator = readDelegationMode(stateOpts) === "full";
                persona = readPersona(stateOpts);
            }
            catch {
                // segments omitted
            }
        }
        const dir = field(payload, "workspace", "current_dir") ?? field(payload, "cwd");
        const cols = Number.parseInt(env.COLUMNS ?? "", 10);
        const stdout = renderStatusline(payload, {
            color: !env.NO_COLOR,
            cols: Number.isFinite(cols) && cols > 0 ? cols : 120,
            coordinator,
            persona,
            branch: typeof dir === "string" && dir !== "" ? readBranch(dir) : undefined,
            tps: tokensPerSecond(payload, dataDir),
        });
        return { exitCode: 0, stdout };
    }
    catch {
        return { exitCode: 0, stdout: FALLBACK_LINE };
    }
}
function readStdin() {
    try {
        return readFileSync(0, "utf8");
    }
    catch {
        return "";
    }
}
/** Entry used by the setup shim; `dataDir` is the shim's own directory. */
export function runStatusline(dataDir) {
    const res = statuslineCli(readStdin(), process.env, dataDir);
    process.stdout.write(res.stdout + "\n");
    process.exitCode = res.exitCode;
}
let isMain = false;
try {
    isMain = !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
}
catch {
    // importing must never throw
}
if (isMain)
    runStatusline(process.argv[2] === "--data-dir" ? process.argv[3] : undefined);
