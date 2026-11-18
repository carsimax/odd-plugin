// `node dist/cli/changes.js [--cwd <dir>]`. Read-only summary of the working-tree changes (git status + diff --stat).
// Defaults to the process cwd (the project dir when run from a skill). Always exits 0; prints nothing the user typed.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { collectChanges } from "../lib/changes.js";
import { flagValue } from "../lib/system.js";

export function changesCli(argv: string[]): { exitCode: number; stdout: string } {
  let stdout: string;
  try {
    stdout = collectChanges(flagValue(argv, "--cwd") ?? process.cwd());
  } catch {
    stdout = "Changes unavailable.";
  }
  return { exitCode: 0, stdout };
}

function main(): void {
  process.stdout.write(changesCli(process.argv.slice(2)).stdout + "\n");
}

try {
  if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main();
} catch {
  // importing must never throw
}
