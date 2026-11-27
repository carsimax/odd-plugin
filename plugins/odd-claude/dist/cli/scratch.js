// `node dist/cli/scratch.js [--session <id>] [--data-dir <dir>]`. Read-only: shows this session's scratch dir. Always exits 0.
import { listScratch, scratchDir } from "../lib/scratch.js";
import { envWithDataDir, flagValue, runMain } from "../lib/system.js";
function formatSize(bytes) {
    if (bytes < 1024)
        return `${bytes} B`;
    const units = ["KiB", "MiB", "GiB"];
    let v = bytes / 1024;
    let u = 0;
    while (v >= 1024 && u < units.length - 1) {
        v /= 1024;
        u++;
    }
    return `${v.toFixed(1)} ${units[u]}`;
}
export function scratchCli(argv, env = process.env) {
    const session = flagValue(argv, "--session");
    const merged = envWithDataDir(argv, env);
    if (!session)
        return { exitCode: 0, stdout: "odd-claude scratch: no session available (run it inside a Claude Code session)." };
    const dir = scratchDir(session, { env: merged });
    const l = listScratch(dir);
    if (!l.exists)
        return { exitCode: 0, stdout: `odd-claude scratch: ${dir}\n(not created yet or already removed)` };
    return {
        exitCode: 0,
        stdout: [
            `odd-claude scratch: ${dir}`,
            `size: ${formatSize(l.bytes)}; entries: ${l.entries.length}`,
            ...(l.entries.length > 0 ? l.entries.map((e) => `  ${e}`) : ["  (empty)"]),
            "removed when the session ends",
        ].join("\n"),
    };
}
runMain(import.meta.url, () => scratchCli(process.argv.slice(2)));
