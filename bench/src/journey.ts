// Journey interface and runner: sandbox per journey, steps executed in order, metrics derived from what the harness observes.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { addBlock, emptyBlocks, emptyMetricSet, measured, proxy, summarizeLatency, type BlockClass, type MetricSet } from "./metrics.js";
import { sameJson } from "./compare.js";
import { mcpOperation } from "./mcp-client.js";
import { runProcess, type ProcessResult } from "./process.js";
import { createSandbox, type Sandbox } from "./sandbox.js";
import type { JourneyRow, Projection } from "./schema.js";

export interface StepOutcome {
  ok: boolean;
  /** Set when the step was blocked (hook deny, tool refusal); the journey declares the class. */
  block?: BlockClass;
  /** Normalized facts this step contributes to the outcome projection (merged across steps). */
  observed?: Projection;
}

export interface Step {
  name: string;
  /** `human` steps count as human prompts; `agent` steps count as commands. */
  actor: "human" | "agent";
  /** Text the human types on a human step (manual_tokens proxy). */
  humanText?: string;
  run(env: JourneyEnv): Promise<StepOutcome>;
}

export interface Journey {
  id: string;
  description: string;
  needsOrigin?: boolean;
  /** Whole-journey deadline (default 60s). */
  deadlineMs?: number;
  setup?(env: JourneyEnv): Promise<void>;
  steps: Step[];
  /** Expected outcome projection, compared by deep equality with the merged `observed` of all steps. */
  expected: Projection;
}

export interface JourneyEnv {
  sandbox: Sandbox;
  /** Records text the agent/human is shown (counts toward human_surface_bytes). */
  see(text: string): void;
  /** One MCP tool call on a fresh server process; its text is surfaced and its latency recorded as `mcp.<tool>`. */
  mcpCall(tool: string, args?: Record<string, unknown>): Promise<{ text: string; isError: boolean; json: unknown }>;
  /** One tools/list on a fresh server process; latency `mcp.tools_list`, nothing is surfaced to the human. */
  mcpTools(): Promise<string[]>;
  /** One hook/CLI process; stdout is surfaced and latency recorded as `hook.<name>`. */
  runHook(name: string, command: string, args: readonly string[], stdin?: string): Promise<ProcessResult>;
}

export interface RunOptions { serverPath?: string }

export const DEFAULT_SERVER_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../../plugins/odd-claude/dist/mcp/review-server.js");
const DEFAULT_DEADLINE_MS = 60_000;
const utf8 = (s: string): number => Buffer.byteLength(s, "utf8");

export async function runJourney(journey: Journey, opts: RunOptions = {}): Promise<JourneyRow> {
  const serverPath = opts.serverPath ?? DEFAULT_SERVER_PATH;
  const deadlineMs = journey.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const sandbox = await createSandbox({ origin: journey.needsOrigin === true });
  const latency = new Map<string, number[]>();
  const sample = (op: string, ms: number): void => void latency.set(op, [...(latency.get(op) ?? []), ms]);
  let surface = 0;
  const env: JourneyEnv = {
    sandbox,
    see: (t) => void (surface += utf8(t)),
    async mcpCall(tool, args = {}) {
      const r = await mcpOperation({ serverPath, cwd: sandbox.repo, env: sandbox.env, deadlineMs }, { method: "tools/call", params: { name: tool, arguments: args } });
      sample(`mcp.${tool}`, r.ms);
      surface += utf8(r.text);
      let json: unknown = null;
      try { json = JSON.parse(r.text); } catch { /* not JSON text */ }
      return { text: r.text, isError: r.isError, json };
    },
    async mcpTools() {
      const r = await mcpOperation({ serverPath, cwd: sandbox.repo, env: sandbox.env, deadlineMs }, { method: "tools/list" });
      sample("mcp.tools_list", r.ms);
      return ((r.result as { tools?: { name: string }[] }).tools ?? []).map((t) => t.name);
    },
    async runHook(name, command, args, stdin) {
      const r = await runProcess(command, args, { cwd: sandbox.repo, env: sandbox.env, deadlineMs, ...(stdin !== undefined ? { stdin } : {}) });
      sample(`hook.${name}`, r.ms);
      surface += utf8(r.stdout);
      return r;
    },
  };

  let prompts = 0, manualBytes = 0, commands = 0, recoveries = 0;
  const blocks = emptyBlocks();
  const observed: Projection = {};
  let failure: string | undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    await journey.setup?.(env);
    sandbox.resetCounters();
    surface = 0;
    latency.clear();
    const body = (async () => {
      let previousBlocked = false;
      for (const step of journey.steps) {
        if (step.actor === "human") { prompts += 1; manualBytes += utf8(step.humanText ?? ""); } else commands += 1;
        const out = await step.run(env);
        if (out.block) addBlock(blocks, out.block);
        if (previousBlocked && out.ok && !out.block) recoveries += 1;
        previousBlocked = out.block !== undefined;
        Object.assign(observed, out.observed);
      }
    })();
    const deadline = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`journey deadline exceeded after ${deadlineMs}ms`)), deadlineMs); });
    await Promise.race([body, deadline]);
  } catch (e) {
    failure = e instanceof Error ? e.message : String(e);
  } finally {
    clearTimeout(timer);
  }
  const metrics: MetricSet = emptyMetricSet();
  metrics.human_prompts = measured(prompts);
  metrics.manual_tokens = proxy(Math.ceil(manualBytes / 4), "ceil(bytes/4) of human step text");
  metrics.commands_to_completion = measured(commands);
  metrics.blocks = { value: blocks, derivation: "measured" };
  metrics.recovery_round_trips = measured(recoveries);
  metrics.model_runs = measured(sandbox.countModelRuns());
  metrics.human_surface_bytes = measured(surface);
  metrics.git_subprocesses = measured(sandbox.countGit());
  for (const [op, xs] of latency) metrics.latency[op] = summarizeLatency(xs);
  const root = sandbox.root;
  sandbox.cleanup();
  if (existsSync(root)) failure ??= "sandbox cleanup failed";
  if (failure === undefined && !sameJson(observed, journey.expected)) failure = `outcome projection differs from expected: ${JSON.stringify(observed)}`;
  return { id: journey.id, status: failure === undefined ? "passed" : "failed", outcome: observed, metrics, ...(failure !== undefined ? { reason: failure } : {}) };
}
