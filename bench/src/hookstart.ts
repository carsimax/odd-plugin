// Hook start-up latency breakdown (dev-only, T9): per hook event, the median of N fresh processes for a bare `node -e 0`, the whole
// `node dist/hooks/run.js <event>` call and the phases measured inside a driver process (hookphase.ts): node boot, module graph import,
// first dispatch (lazy load + handler) and the handler alone (second dispatch). Offline: no git repo, no model, own HOME and data dir.
// usage: npm run bench:hooks -- [--runs N] [--out file.json] [--run-js <path to another build's dist/hooks/run.js>]
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface EventCase { label: string; event: string; payload: Record<string, unknown> }

export function median(xs: readonly number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** The six measured cases (RDD is off everywhere: the data dir is empty). `cwd` is a plain temp directory, never a git repo. */
export function eventCases(cwd: string): EventCase[] {
  const base = { session_id: "bench-hooks", cwd };
  return [
    { label: "PreToolUse (Bash, not a delivery)", event: "PreToolUse", payload: { ...base, tool_name: "Bash", tool_input: { command: "ls -la" } } },
    { label: "PreToolUse (delivery, RDD off)", event: "PreToolUse", payload: { ...base, tool_name: "Bash", tool_input: { command: "git push origin main" } } },
    { label: "Stop (RDD off)", event: "Stop", payload: { ...base, stop_hook_active: false } },
    { label: "PostToolUse", event: "PostToolUse", payload: { ...base, tool_name: "Read", tool_input: { file_path: join(cwd, "a.txt") } } },
    { label: "SessionStart", event: "SessionStart", payload: { ...base, source: "startup" } },
    { label: "UserPromptSubmit", event: "UserPromptSubmit", payload: { ...base, prompt: "hola" } },
  ];
}

interface Phase { boot_ms: number; import_ms: number; first_ms: number; warm_ms: number; modules: number | null; review_modules: number | null; stdout_bytes: number }
export interface Row { label: string; event: string; node_ms: number; total_ms: number; boot_ms: number; import_ms: number; first_ms: number; warm_ms: number; load_ms: number; modules: number | null; review_modules: number | null; runs: number }

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i < 0) return undefined;
  const v = process.argv[i + 1];
  if (v === undefined || v.startsWith("--")) { process.stderr.write(`${name} needs a value\n`); process.exit(2); }
  return v;
}

export function measure(runs: number, runJs: string, driverJs: string): Row[] {
  const root = mkdtempSync(join(tmpdir(), "odd-hookstart-"));
  try {
    const home = join(root, "home"), data = join(root, "data"), cwd = join(root, "work");
    for (const d of [home, data, cwd]) mkdirSync(d, { recursive: true });
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home, TMPDIR: root, CLAUDE_PLUGIN_DATA: data, CLAUDE_PLUGIN_ROOT: resolve(dirname(runJs), "..", "..") };
    const cases = eventCases(cwd);
    const node: number[] = [];
    const total = new Map<string, number[]>(), phases = new Map<string, Phase[]>();
    for (const c of cases) { total.set(c.label, []); phases.set(c.label, []); }
    const timed = (args: string[], input: string, e: NodeJS.ProcessEnv): { ms: number; out: string } => {
      const t = performance.now();
      const r = spawnSync(process.execPath, args, { input, env: e, cwd, encoding: "utf8", timeout: 20_000 });
      const ms = performance.now() - t;
      if (r.status !== 0) throw new Error(`node ${args.join(" ")} exited ${String(r.status)}: ${r.stderr}`);
      return { ms, out: r.stdout };
    };
    // Warm-up round (file cache), then `runs` samples, round-robin so machine drift hits every row alike.
    for (let i = -1; i < runs; i++) {
      const n = timed(["-e", "0"], "", env);
      if (i >= 0) node.push(n.ms);
      for (const c of cases) {
        const stdin = JSON.stringify(c.payload);
        const t = timed([runJs, c.event], stdin, env);
        const p = timed([driverJs, runJs, c.event], "", { ...env, ODD_HOOKPHASE_STDIN: stdin });
        if (i >= 0) { total.get(c.label)!.push(t.ms); phases.get(c.label)!.push(JSON.parse(p.out) as Phase); }
      }
    }
    const med = (ps: Phase[], k: "boot_ms" | "import_ms" | "first_ms" | "warm_ms"): number => median(ps.map((p) => p[k]));
    return cases.map((c) => {
      const ps = phases.get(c.label)!;
      const first = med(ps, "first_ms"), warm = med(ps, "warm_ms");
      return {
        label: c.label, event: c.event, node_ms: median(node), total_ms: median(total.get(c.label)!),
        boot_ms: med(ps, "boot_ms"), import_ms: med(ps, "import_ms"), first_ms: first, warm_ms: warm,
        load_ms: med(ps, "import_ms") + Math.max(0, first - warm),
        modules: ps[0]!.modules, review_modules: ps[0]!.review_modules, runs,
      };
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function renderTable(rows: readonly Row[]): string {
  const f = (n: number): string => n.toFixed(1);
  const head = "| case | node -e 0 | total | node boot | module load | handler (warm) | modules | review modules |\n|---|---|---|---|---|---|---|---|";
  return [head, ...rows.map((r) => `| ${r.label} | ${f(r.node_ms)} | ${f(r.total_ms)} | ${f(r.boot_ms)} | ${f(r.load_ms)} | ${f(r.warm_ms)} | ${r.modules ?? "n/a"} | ${r.review_modules ?? "n/a"} |`)].join("\n");
}

function main(): void {
  // Read every flag first so a missing value fails before any measuring starts.
  const runsArg = arg("--runs"), runJsArg = arg("--run-js"), out = arg("--out");
  const runs = Number(runsArg ?? "15");
  if (!Number.isInteger(runs) || runs < 1 || runs > 200) { process.stderr.write("--runs must be an integer in 1..200\n"); process.exit(2); }
  const here = dirname(fileURLToPath(import.meta.url));
  const runJs = resolve(runJsArg ?? resolve(here, "../../plugins/odd-claude/dist/hooks/run.js"));
  const rows = measure(runs, runJs, join(here, "hookphase.js"));
  if (out !== undefined) writeFileSync(out, JSON.stringify({ schema: "odd-claude.bench-hooks/v1", node: process.version, platform: `${process.platform} ${process.arch}`, runs, rows }, null, 2) + "\n");
  process.stdout.write(`median of ${runs} fresh processes, ms (${process.version}, ${process.platform} ${process.arch})\n\n${renderTable(rows)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
