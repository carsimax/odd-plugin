// `node dist/cli/persona.js [--mode <mode>] [--data-dir <dir>]`
// Without --mode: prints the current persona and the available modes (read-only). `neutral` is the only persona;
// any other value (e.g. the removed `mentor`) exits 1 with the invalid-mode error and writes nothing.
// Exit codes: 0 ok; 1 invalid mode; 2 usage error / no data dir.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PERSONA_MODES, isPersonaMode, readPersona, writePersona } from "../lib/persona.js";
import { envWithDataDir, flagValue } from "../lib/system.js";
const USAGE = "usage: persona.js [--mode neutral] [--data-dir <dir>]";
export function personaCli(argv, env) {
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--mode" || a === "--data-dir") {
            const v = argv[i + 1];
            if (v === undefined || v === "" || v.startsWith("--"))
                return usageError(`${a} needs a value`);
            i++;
        }
        else
            return usageError(`unknown argument ${a}`);
    }
    const opts = { env: envWithDataDir(argv, env) };
    const mode = flagValue(argv, "--mode");
    if (mode === undefined) {
        let current;
        try {
            current = readPersona(opts);
        }
        catch {
            current = readPersona({ env: {} });
        }
        return { exitCode: 0, stdout: `persona: ${current}\navailable modes: ${PERSONA_MODES.join(", ")}`, stderr: "" };
    }
    if (!isPersonaMode(mode)) {
        return { exitCode: 1, stdout: "", stderr: `error: invalid persona ${JSON.stringify(mode)}; available modes: ${PERSONA_MODES.join(", ")}` };
    }
    writePersona(mode, opts);
    return { exitCode: 0, stdout: `persona set to: ${mode}\nApplies from the next session start (or /clear).`, stderr: "" };
}
function usageError(message) {
    return { exitCode: 2, stdout: "", stderr: `error: usage: ${message}\n${USAGE}` };
}
function main() {
    const res = personaCli(process.argv.slice(2), process.env);
    if (res.stdout !== "")
        process.stdout.write(res.stdout + "\n");
    if (res.stderr !== "")
        process.stderr.write(res.stderr + "\n");
    process.exitCode = res.exitCode;
}
try {
    if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)))
        main();
}
catch {
    // importing must never throw
}
