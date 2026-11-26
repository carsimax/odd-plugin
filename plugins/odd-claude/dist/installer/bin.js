// Plain Node entry (no TUI): `node dist/installer/bin.js <command> [flags]`. The bundle in tui/ adds the interactive installer.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "./cli.js";
import { defaultRunner } from "./mcp.js";
const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json"), "utf8"));
process.exitCode = await runCli(process.argv.slice(2), {
    env: process.env,
    homedir: homedir(),
    runner: defaultRunner,
    stdout: (s) => void process.stdout.write(s),
    stderr: (s) => void process.stderr.write(s),
    isTty: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    version: pkg.version,
});
