// `npm run bench -- --out <file> [--journey <id>]...`: runs the journeys against odd's real MCP server and writes the result JSON.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { DEFAULT_SERVER_PATH, runJourney } from "./journey.js";
import { JOURNEYS } from "./journeys/index.js";
import { buildResult } from "./report.js";
import { validateResult } from "./schema.js";

function parse(argv: string[]): { out?: string; only: string[]; error?: string } {
  const only: string[] = [];
  let out: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") out = argv[++i];
    else if (a === "--journey") only.push(argv[++i] ?? "");
    else return { only, error: `unknown argument: ${a}` };
  }
  if (!out) return { only, error: "usage: bench --out <results.json> [--journey <id>]..." };
  return { out, only };
}

async function main(): Promise<number> {
  const args = parse(process.argv.slice(2));
  if (args.error || !args.out) { console.error(args.error); return 2; }
  const selected = args.only.length ? JOURNEYS.filter((j) => args.only.includes(j.id)) : JOURNEYS;
  const missing = args.only.filter((id) => !JOURNEYS.some((j) => j.id === id));
  if (missing.length) { console.error(`unknown journey: ${missing.join(", ")}`); return 2; }
  const rows = [];
  for (const j of selected) rows.push(await runJourney(j));
  const pluginDir = dirname(dirname(dirname(DEFAULT_SERVER_PATH)));
  const version = (JSON.parse(readFileSync(`${pluginDir}/package.json`, "utf8")) as { version: string }).version;
  const commit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: pluginDir, encoding: "utf8" }).stdout.trim() || "unknown";
  const result = buildResult("odd", rows, { binaryPath: DEFAULT_SERVER_PATH, binaryVersion: version, commit });
  const errs = validateResult(result);
  if (errs.length) { console.error(`invalid result: ${errs.join("; ")}`); return 3; }
  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, JSON.stringify(result, null, 2) + "\n");
  for (const r of rows) console.log(`${r.status.padEnd(11)} ${r.id}${r.reason ? `  (${r.reason})` : ""}`);
  return result.aggregate.counts.failed > 0 ? 1 : 0;
}

process.exitCode = await main();
