// Child-process driver of the hook start-up measurement (dev-only; see hookstart.ts). One fresh process = one sample.
// usage: node bench/dist/hookphase.js <plugin dist/hooks/run.js> <event>   (hook JSON in ODD_HOOKPHASE_STDIN)
// Prints one JSON line: ms since process start when the driver began (node boot), the static import of run.js, the first dispatch (lazy
// handler load, if any, plus the handler), a second dispatch of the same event (modules warm: the handler alone) and the module files loaded.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import * as nodeModule from "node:module";

const bootMs = performance.now();
const [runJs, event] = process.argv.slice(2);
const files: string[] = [];
type Next = (url: string, ctx: unknown) => unknown;
const registerHooks = (nodeModule as unknown as { registerHooks?: (h: { load: (url: string, ctx: unknown, next: Next) => unknown }) => void }).registerHooks;
registerHooks?.({
  load(url, ctx, next) {
    if (url.startsWith("file:")) files.push(url);
    return next(url, ctx);
  },
});

type Result = { exitCode: number; stdout: string };
type Run = (event: string, stdin: string) => Result | Promise<Result>;
const stdin = process.env.ODD_HOOKPHASE_STDIN ?? "";
const t0 = performance.now();
// The hook process dispatches through lazy.js when the build has it (T9); older builds: run.js's eager runHook. Importing run.js
// itself would load every handler eagerly (it only stays lazy when it is the entrypoint), which is not what a hook process does.
const lazyJs = join(dirname(runJs ?? ""), "lazy.js");
const mod = (await import(pathToFileURL(existsSync(lazyJs) ? lazyJs : (runJs ?? "")).href)) as { runHook: Run; runHookLazy?: Run };
const t1 = performance.now();
const run: Run = mod.runHookLazy ?? mod.runHook;
const first = await run(event ?? "", stdin);
const t2 = performance.now();
await run(event ?? "", stdin);
const t3 = performance.now();
process.stdout.write(JSON.stringify({
  boot_ms: bootMs,
  import_ms: t1 - t0,
  first_ms: t2 - t1,
  warm_ms: t3 - t2,
  modules: registerHooks === undefined ? null : files.length,
  review_modules: registerHooks === undefined ? null : files.filter((f) => f.includes("/dist/review/")).length,
  stdout_bytes: first.stdout.length,
}) + "\n");
