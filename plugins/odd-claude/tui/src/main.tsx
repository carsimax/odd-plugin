// Single entry point of the bundle: CLI subcommands and the TUI. `odd-claude <command> ...` runs non-interactively;
// with no command and a terminal it opens the interactive installer.
import { render } from "ink";
import { homedir } from "node:os";
import { runCli, type CliIo } from "../../src/installer/cli.js";
import { extrasFromArgs, selectionFromArgs } from "../../src/installer/args.js";
import { defaultRunner } from "../../src/installer/mcp.js";
import pkg from "../../package.json" with { type: "json" };
import { App } from "./app.js";
import { createServices } from "./services.js";

async function startTui({ args, io }: Parameters<NonNullable<CliIo["startTui"]>>[0]): Promise<number> {
  let code = 0;
  const initial = { selection: selectionFromArgs(args), extras: extrasFromArgs(args) };
  const app = render(<App services={createServices(io, args)} initial={initial} onExit={(c) => (code = c)} />);
  await app.waitUntilExit();
  return code;
}

process.exitCode = await runCli(process.argv.slice(2), {
  env: process.env,
  homedir: homedir(),
  runner: defaultRunner,
  stdout: (s) => void process.stdout.write(s),
  stderr: (s) => void process.stderr.write(s),
  isTty: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  version: pkg.version,
  startTui,
});
