// `node dist/cli/stats.js [--json] [--session <id>] [--data-dir <dir>]`. Read-only, local only; always exits 0.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { collectTranscriptStats, readExploration, readTranscriptPath, renderStats } from "../lib/stats.js";
import { readSubagents } from "../lib/subagents.js";
import { envWithDataDir, flagValue } from "../lib/system.js";
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
            note: path === undefined ? "No transcript path recorded for this session yet (it is saved at the next prompt)." : "Transcript unreadable.",
        };
        if (argv.includes("--json"))
            return { exitCode: 0, stdout: JSON.stringify({ schema: "odd-claude.stats/v1", session, ...view }, null, 2) };
        return { exitCode: 0, stdout: renderStats(view) };
    }
    catch {
        return { exitCode: 0, stdout: "Stats unavailable." };
    }
}
function main() {
    process.stdout.write(statsCli(process.argv.slice(2)).stdout + "\n");
}
try {
    if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)))
        main();
}
catch {
    // importing must never throw
}
