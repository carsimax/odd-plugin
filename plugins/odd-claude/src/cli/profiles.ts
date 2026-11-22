// `node dist/cli/profiles.js [list|show|use <name>|set <role> <model> [effort]|clear] [--data-dir <dir>]`
// Every argument is validated against a whitelist (lib/profiles.ts). Exit codes: 0 ok; 1 invalid value; 2 usage / no data dir.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { clearProfile, defaultProfile, readProfile, renderPresetList, renderProfiles, setRole, useProfile } from "../lib/profiles.js";
import { envWithDataDir } from "../lib/system.js";

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const USAGE = "usage: profiles.js [list|show|use <name>|set <role> <model> [effort]|clear] [--data-dir <dir>]";
const usage = (m: string): CliResult => ({ exitCode: 2, stdout: "", stderr: `error: ${m}\n${USAGE}` });

export function profilesCli(argv: string[], env: Record<string, string | undefined> = process.env): CliResult {
  const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--data-dir") {
      const v = argv[i + 1];
      if (v === undefined || v === "" || v.startsWith("--")) return usage("--data-dir needs a value");
      i++;
    } else if (a.startsWith("--")) return usage(`unknown argument ${a}`);
    else pos.push(a);
  }
  const opts = { env: envWithDataDir(argv, env) };
  const hasDir = Boolean(opts.env.CLAUDE_PLUGIN_DATA);
  const [cmd = "list", ...rest] = pos;
  const ok = (stdout: string): CliResult => ({ exitCode: 0, stdout, stderr: "" });
  if (cmd === "list" || cmd === "show") {
    if (rest.length > 0) return usage(`${cmd} takes no arguments`);
    const p = hasDir ? readProfile(opts) : defaultProfile();
    return ok(cmd === "list" ? renderPresetList(p.active) : renderProfiles(p));
  }
  if (cmd !== "use" && cmd !== "set" && cmd !== "clear") return usage(`unknown command ${JSON.stringify(cmd).slice(0, 40)}`);
  if (cmd === "use" && rest.length !== 1) return usage("use needs exactly one profile name");
  if (cmd === "set" && (rest.length < 2 || rest.length > 3)) return usage("set needs <role> <model> [effort]");
  if (cmd === "clear" && rest.length > 0) return usage("clear takes no arguments");
  if (!hasDir) return usage("no data dir (pass --data-dir or set CLAUDE_PLUGIN_DATA)");
  try {
    if (cmd === "use") {
      const p = useProfile(rest[0]!, opts);
      return ok(`profile set to: ${p.active}\n${renderProfiles(p)}\nApplies from the next session start (or /clear) for the orchestrator (the SessionStart context line carries the profile).`);
    }
    if (cmd === "set") {
      const p = setRole(rest[0]!, rest[1]!, rest[2], opts);
      return ok(`role updated\n${renderProfiles(p)}\nApplies from the next session start (or /clear) for the orchestrator (the SessionStart context line carries the profile).`);
    }
    clearProfile(opts);
    return ok(`profile cleared: back to the default profile\n${renderProfiles(readProfile(opts))}`);
  } catch (err) {
    return { exitCode: 1, stdout: "", stderr: `error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function main(): void {
  const res = profilesCli(process.argv.slice(2), process.env);
  if (res.stdout !== "") process.stdout.write(res.stdout + "\n");
  if (res.stderr !== "") process.stderr.write(res.stderr + "\n");
  process.exitCode = res.exitCode;
}

try {
  if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main();
} catch {
  // importing must never throw
}
