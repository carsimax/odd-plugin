// `node dist/cli/peers.js list|status --session <id> [--data-dir <dir>]`. READ-ONLY by design: it only shows the session's
// peer grants. There is no allow/revoke here: grants are written only by the UserPromptSubmit hook from the human's own
// prompt, so neither the model nor a skill can grant itself (R07 P2). Exit 0 for list/status, 2 for anything else.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { listGrants } from "../lib/peer-grants.js";
import { envWithDataDir, flagValue } from "../lib/system.js";
const REFUSAL = "odd-claude peers: this command is read-only (list, status). The CLI cannot grant or revoke; only the human can, by typing\n" +
    "`/odd-claude:peers allow <session-id>` or `/odd-claude:peers revoke <session-id|--all>` as their own prompt.";
export function peersCli(argv, env = process.env) {
    const sub = argv[0];
    if (sub !== "list" && sub !== "status")
        return { exitCode: 2, stdout: REFUSAL };
    const session = flagValue(argv, "--session");
    const merged = envWithDataDir(argv, env);
    if (!session || !merged.CLAUDE_PLUGIN_DATA)
        return { exitCode: 0, stdout: "odd-claude peers: no session or data dir available (run it inside a Claude Code session)." };
    try {
        const grants = listGrants(session, { env: merged });
        if (grants.length === 0)
            return { exitCode: 0, stdout: `odd-claude peers: session ${session} accepts messages from nobody (closed by default).` };
        return { exitCode: 0, stdout: [`odd-claude peers: session ${session} accepts messages from:`, ...grants.map((g) => `  ${g}`)].join("\n") };
    }
    catch (err) {
        return { exitCode: 0, stdout: `odd-claude peers: cannot read grants (${err instanceof Error ? err.message : String(err)}).` };
    }
}
try {
    if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
        const r = peersCli(process.argv.slice(2));
        process.stdout.write(r.stdout + "\n");
        process.exitCode = r.exitCode;
    }
}
catch {
    // importing must never throw
}
