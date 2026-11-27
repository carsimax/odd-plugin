// `node dist/cli/retro.js [--json] [--session <id> --data-dir <dir> | --transcript <path>]`. Read-only, local only; always exits 0.
import { collectRetro, renderRetro } from "../lib/retro.js";
import { readTranscriptPath } from "../lib/stats.js";
import { validPath } from "../lib/transcript-path.js";
import { envWithDataDir, flagValue, runMain } from "../lib/system.js";

const SCHEMA = "odd-claude.retro/v1";

export function retroCli(argv: string[], env: Record<string, string | undefined> = process.env): { exitCode: number; stdout: string } {
  const json = argv.includes("--json");
  const note = (n: string) => ({ exitCode: 0, stdout: json ? JSON.stringify({ schema: SCHEMA, note: n }, null, 2) : n });
  try {
    let path: string | undefined;
    const explicit = flagValue(argv, "--transcript");
    if (explicit !== undefined) {
      if (!validPath(explicit)) return note("Invalid transcript path (must be an absolute path ending in .jsonl); no retro to show.");
      path = explicit;
    } else {
      const session = flagValue(argv, "--session");
      if (session === undefined) return note("No session id or transcript (pass --session <id> --data-dir <dir>, or --transcript <path>); no retro to show.");
      const e = envWithDataDir(argv, env);
      path = readTranscriptPath(session, { env: e });
      if (path === undefined) return note("No transcript path recorded for this session yet (it is saved at the next prompt).");
    }
    const digest = collectRetro(path);
    if (digest === undefined) return note("Transcript unreadable.");
    return { exitCode: 0, stdout: json ? JSON.stringify(digest, null, 2) : renderRetro(digest) };
  } catch {
    return note("Retro unavailable.");
  }
}

const main = () => retroCli(process.argv.slice(2));

runMain(import.meta.url, main);
