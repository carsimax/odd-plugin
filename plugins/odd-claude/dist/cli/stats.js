// `node dist/cli/stats.js [--json] [--session <id>] [--data-dir <dir>]`. Read-only, local only; always exits 0.
import { collectTranscriptStats, readExploration, readTranscriptPath, renderStats } from "../lib/stats.js";
import { readSubagents } from "../lib/subagents.js";
import { envWithDataDir, flagValue, runMain } from "../lib/system.js";
export function statsCli(argv, env = process.env) {
    try {
        const session = flagValue(argv, "--session");
        if (session === undefined || session === "")
            return { exitCode: 0, stdout: "No session id (pass --session <id>); no stats to show." };
        const e = envWithDataDir(argv, env);
        const opts = { env: e };
        const path = readTranscriptPath(session, opts);
        const transcript = path === undefined ? undefined : collectTranscriptStats(path);
        const view = {
            transcript,
            subagents: readSubagents(session, opts),
            exploration: readExploration(session, opts),
            note: path === undefined ? "No transcript path recorded for this session yet (it is saved at the next prompt)." : transcript === undefined ? "Transcript unreadable." : undefined,
        };
        if (argv.includes("--json"))
            return { exitCode: 0, stdout: JSON.stringify({ schema: "odd-claude.stats/v1", session, ...view }, null, 2) };
        return { exitCode: 0, stdout: renderStats(view) };
    }
    catch {
        return { exitCode: 0, stdout: "Stats unavailable." };
    }
}
const main = () => statsCli(process.argv.slice(2));
runMain(import.meta.url, main);
