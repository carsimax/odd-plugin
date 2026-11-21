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

/** Friction events a subject reports for one step. Everything else (model runs, git subprocesses) is observed on the sandbox PATH. */
export type MetricEvent =
  | { kind: "human_prompt"; text: string }
  | { kind: "command" }
  | { kind: "block"; class: BlockClass }
  | { kind: "recovery" }
  /** Only for what the sandbox PATH shims cannot see (a subject that does not spawn `claude` or `git` through PATH). Odd reports none. */
  | { kind: "model_run" }
  | { kind: "git_subprocess" }
  | { kind: "surface"; bytes: number }
  | { kind: "latency"; op: string; ms: number }
  /** The row's numbers must not be compared with the other subject's (see `JourneyRow.not_comparable`); not a friction event. */
  | { kind: "not_comparable"; reason: string };

export interface StepOutcome {
  ok: boolean;
  /** Set when the step was blocked (hook deny, tool refusal) and the step carries no events. */
  block?: BlockClass;
  /** Normalized facts this step contributes to the outcome projection (merged across steps). */
  observed?: Projection;
  /** Metric events of the step (see `MetricEvent`); blocks here count exactly like `block`. */
  events?: MetricEvent[];
}

export interface Step {
  name: string;
  /** `human` steps count as human prompts; `agent` steps count as commands; `events` steps count only what their events report. */
  actor: "human" | "agent" | "events";
  /** Text the human types on a human step (manual_tokens proxy). */
  humanText?: string;
  run(env: JourneyEnv): Promise<StepOutcome>;
}

export interface Journey {
  id: string;
  /** Closest upstream journey id, for traceability only. */
  refId?: string;
  description: string;
  needsOrigin?: boolean;
  /**
   * Deadline in ms (default 60s), with two scopes. The journey as a whole must finish within it: when it passes the journey fails, the
   * in-flight step is cancelled (its processes are killed, later operations are refused). It is also the longest any single process or MCP
   * operation may run (their own per-operation timeout), so one hung operation cannot outlive the journey.
   */
  deadlineMs?: number;
  /** Set when the subject cannot express this journey: the row is `unsupported` with this reason and nothing runs. */
  unsupported?: string;
  setup?(env: JourneyEnv): Promise<void>;
  steps: Step[];
  /** Expected outcome projection, compared by deep equality with the merged `observed` of all steps. */
  expected: Projection;
}

export interface JourneyEnv {
  sandbox: Sandbox;
  /** Absolute paths of the built plugin entrypoints the odd subject drives. */
  plugin: { server: string; hooks: string; reviewMode: string };
  /** Records text the agent/human is shown (counts toward human_surface_bytes). */
  see(text: string): void;
  /** One MCP tool call on a fresh server process; its text is surfaced and its latency recorded as `mcp.<tool>`. */
  mcpCall(tool: string, args?: Record<string, unknown>): Promise<{ text: string; isError: boolean; json: unknown }>;
  /** One tools/list on a fresh server process; latency `mcp.tools_list`, nothing is surfaced to the human. */
  mcpTools(): Promise<string[]>;
  /** One hook/CLI process; stdout is surfaced and latency recorded as `hook.<name>`. */
  runHook(name: string, command: string, args: readonly string[], stdin?: string): Promise<ProcessResult>;
  /** One command-line process (a subject's own CLI, `git`): stdout and stderr are surfaced and latency recorded as `cli.<name>`. `env` replaces the sandbox env (a subject adds its own switches). */
  runCli(name: string, command: string, args: readonly string[], opts?: { stdin?: string; env?: NodeJS.ProcessEnv }): Promise<ProcessResult>;
}

/** Thrown by a subject mid-journey when the product cannot express what the step asks; the row becomes `unsupported`, never `failed`. */
export class UnsupportedError extends Error {}

export interface RunOptions { serverPath?: string }

/** Result row of one journey: the shared row plus the upstream id it traces to, when there is one. */
export interface JourneyResultRow extends JourneyRow { ref_id?: string }

/** The plugin checkout the odd subject drives (`bench/dist` -> repo root -> `plugins/odd-claude`). */
export const DEFAULT_PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../plugins/odd-claude");
export const DEFAULT_SERVER_PATH = resolve(DEFAULT_PLUGIN_DIR, "dist/mcp/review-server.js");
const DEFAULT_DEADLINE_MS = 60_000;
const utf8 = (s: string): number => Buffer.byteLength(s, "utf8");

export async function runJourney(journey: Journey, opts: RunOptions = {}): Promise<JourneyResultRow> {
  const trace = journey.refId !== undefined ? { ref_id: journey.refId } : {};
  if (journey.unsupported !== undefined) return { id: journey.id, ...trace, status: "unsupported", outcome: null, metrics: null, reason: journey.unsupported };
  const serverPath = opts.serverPath ?? DEFAULT_SERVER_PATH;
  const deadlineMs = journey.deadlineMs ?? DEFAULT_DEADLINE_MS;
  let sandbox: Sandbox;
  try {
    sandbox = await createSandbox({ origin: journey.needsOrigin === true });
  } catch (e) {
    return { id: journey.id, ...trace, status: "failed", outcome: {}, metrics: emptyMetricSet(), reason: `sandbox setup failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  const latency = new Map<string, number[]>();
  const sample = (op: string, ms: number): void => void latency.set(op, [...(latency.get(op) ?? []), ms]);
  let surface = 0;
  /** Set once the journey is over (deadline or failure): operations are refused and in-flight ones are killed, so a late step changes nothing. */
  const cancel = new AbortController();
  const live = (): AbortSignal => {
    if (cancel.signal.aborted) throw new Error("journey ended: operation refused after the row was built");
    return cancel.signal;
  };
  const hooksDir = resolve(dirname(serverPath), "../hooks"), cliDir = resolve(dirname(serverPath), "../cli");
  const env: JourneyEnv = {
    sandbox,
    plugin: { server: serverPath, hooks: resolve(hooksDir, "run.js"), reviewMode: resolve(cliDir, "review-mode.js") },
    see: (t) => void (surface += utf8(t)),
    async mcpCall(tool, args = {}) {
      const r = await mcpOperation({ serverPath, cwd: sandbox.repo, env: sandbox.env, deadlineMs, signal: live() }, { method: "tools/call", params: { name: tool, arguments: args } });
      sample(`mcp.${tool}`, r.ms);
      surface += utf8(r.text);
      let json: unknown = null;
      try { json = JSON.parse(r.text); } catch { /* not JSON text */ }
      return { text: r.text, isError: r.isError, json };
    },
    async mcpTools() {
      const r = await mcpOperation({ serverPath, cwd: sandbox.repo, env: sandbox.env, deadlineMs, signal: live() }, { method: "tools/list" });
      sample("mcp.tools_list", r.ms);
      return ((r.result as { tools?: { name: string }[] }).tools ?? []).map((t) => t.name);
    },
    async runHook(name, command, args, stdin) {
      const r = await runProcess(command, args, { cwd: sandbox.repo, env: sandbox.env, deadlineMs, signal: live(), ...(stdin !== undefined ? { stdin } : {}) });
      sample(`hook.${name}`, r.ms);
      surface += utf8(r.stdout);
      return r;
    },
    async runCli(name, command, args, o = {}) {
      const r = await runProcess(command, args, { cwd: sandbox.repo, env: o.env ?? sandbox.env, deadlineMs, signal: live(), ...(o.stdin !== undefined ? { stdin: o.stdin } : {}) });
      sample(`cli.${name}`, r.ms);
      surface += utf8(r.stdout) + utf8(r.stderr);
      return r;
    },
  };

  let prompts = 0, manualBytes = 0, commands = 0, recoveries = 0, extraModelRuns = 0, extraGit = 0;
  const blocks = emptyBlocks();
  const observed: Projection = {};
  const notComparable: string[] = [];
  let failure: string | undefined;
  let unsupported: string | undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    await journey.setup?.(env);
    sandbox.resetCounters();
    surface = 0;
    latency.clear();
    const body = (async () => {
      let previousBlocked = false;
      for (const step of journey.steps) {
        if (cancel.signal.aborted) return;
        if (step.actor === "human") { prompts += 1; manualBytes += utf8(step.humanText ?? ""); } else if (step.actor === "agent") commands += 1;
        const out = await step.run(env);
        if (cancel.signal.aborted) return;
        const stepBlocks: BlockClass[] = out.block ? [out.block] : [];
        for (const ev of out.events ?? []) {
          if (ev.kind === "human_prompt") { prompts += 1; manualBytes += utf8(ev.text); }
          else if (ev.kind === "command") commands += 1;
          else if (ev.kind === "block") stepBlocks.push(ev.class);
          else if (ev.kind === "recovery") recoveries += 1;
          else if (ev.kind === "model_run") extraModelRuns += 1;
          else if (ev.kind === "git_subprocess") extraGit += 1;
          else if (ev.kind === "surface") surface += ev.bytes;
          else if (ev.kind === "not_comparable") { if (!notComparable.includes(ev.reason)) notComparable.push(ev.reason); }
          else sample(ev.op, ev.ms);
        }
        for (const cls of stepBlocks) addBlock(blocks, cls);
        if (!out.ok && stepBlocks.length === 0) throw new Error(`step "${step.name}" reported ok:false without a block class`);
        if (previousBlocked && out.ok && stepBlocks.length === 0) recoveries += 1;
        previousBlocked = stepBlocks.length > 0;
        Object.assign(observed, out.observed);
      }
    })();
    // The deadline may win the race; the body then finishes (or fails) on its own after cancellation, and that must neither crash nor count.
    body.catch(() => {});
    const deadline = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`journey deadline exceeded after ${deadlineMs}ms`)), deadlineMs); });
    await Promise.race([body, deadline]);
  } catch (e) {
    if (e instanceof UnsupportedError) unsupported = e.message;
    else failure = e instanceof Error ? e.message : String(e);
  } finally {
    clearTimeout(timer);
    cancel.abort();
  }
  const metrics: MetricSet = emptyMetricSet();
  metrics.human_prompts = measured(prompts);
  metrics.manual_tokens = proxy(Math.ceil(manualBytes / 4), "ceil(bytes/4) of human step text");
  metrics.commands_to_completion = measured(commands);
  metrics.blocks = { value: { ...blocks }, derivation: "measured" };
  metrics.recovery_round_trips = measured(recoveries);
  metrics.model_runs = measured(sandbox.countModelRuns() + extraModelRuns);
  metrics.human_surface_bytes = measured(surface);
  metrics.git_subprocesses = measured(sandbox.countGit() + extraGit);
  for (const [op, xs] of latency) metrics.latency[op] = summarizeLatency(xs);
  const root = sandbox.root;
  sandbox.cleanup();
  if (existsSync(root)) failure ??= "sandbox cleanup failed";
  if (unsupported !== undefined && failure === undefined) return { id: journey.id, ...trace, status: "unsupported", outcome: null, metrics: null, reason: unsupported };
  if (failure === undefined && !sameJson(observed, journey.expected)) failure = `outcome projection differs from expected: ${JSON.stringify(observed)}`;
  return { id: journey.id, ...trace, status: failure === undefined ? "passed" : "failed", outcome: { ...observed }, metrics, ...(failure !== undefined ? { reason: failure } : {}), ...(notComparable.length > 0 ? { not_comparable: [...notComparable] } : {}) };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Subject-neutral step model. A journey is data: a fixture and abstract steps with the normalized facts each must produce.
// A `Subject` (odd now, the upstream CLI oracle in T3) executes the steps and normalizes what it saw, so the same journey runs
// against both and only normalized projections (never bytes, hashes or ids) are compared.
// ---------------------------------------------------------------------------------------------------------------------------

export type Risk = "low" | "medium" | "high";
/** What a step reviews: the working tree, or the committed range ahead of the remote (committed-only). */
export type TargetKind = "workspace" | "committed";
/** Edits a journey applies to the repository: a real correction of the finding, a no-op, or a different change mid-run. */
export type EditKind = "fix" | "noop" | "drift";

export type StepSpec =
  /** Read-only risk classification. */
  | { kind: "assess"; target?: TargetKind }
  /** Read-only list of the review authority and the RDD mode. */
  | { kind: "inspect" }
  /** Read-only routing: what the product offers next. */
  | { kind: "status"; target?: TargetKind }
  /** Starts a review. `relay` stops at the consent question; `granted`/`declined` also records the human's explicit answer. */
  | { kind: "start"; consent: "relay" | "granted" | "declined"; target?: TargetKind; lenses?: string[] }
  /** The human's explicit answer to the consent question the last `start` relayed. */
  | { kind: "answerConsent"; answer: "granted" | "declined" }
  /** Runs every reviewer batch the product offers (human approves the cost forecast) with a synthesized verdict, until the review settles. */
  | { kind: "captureAll"; verdict: "approve" | "findings" }
  /** Resumes a consented or corrected review by its lineage and settles it with an approving verdict. */
  | { kind: "resume" }
  /** Edits the repository (a correction, a no-op, or drift while a review is in flight) and, for `fix`/`noop`, hands it back to the review. */
  | { kind: "correct"; edit: EditKind }
  /** Commits the working tree onto the current branch. */
  | { kind: "commit" }
  /** Acknowledges the approved review once. */
  | { kind: "acknowledge" }
  /** A delivery command (push, or opening a pull request) as the agent would run it, presented to the delivery gate only; it is never executed. */
  | { kind: "gateCheck"; command: "push" | "prOpen" }
  /** The agent's Stop event. */
  | { kind: "stopHook"; session?: string }
  /** Turns review-driven development on or off, user-wide (`global`) or for this repository only (`clone`). */
  | { kind: "modeSet"; mode: "on" | "off"; scope: "global" | "clone" };

export type StepKind = StepSpec["kind"];

/** Normalized facts of one step. Absent means "not part of this step's projection". */
export interface NormalizedFacts {
  /** `assessed`, `not_due`, `consent_required`, `consented`, `declined`, `closed`, `approved`, `correction_required`, `acknowledged`, `refused`, `forecast`, `allow`, `deny`, `remind`, `silent`, `edited`, `mode_set`, `inspected`, `status`, `committed`. */
  outcome: string;
  risk?: Risk;
  /** Review state after the step: `none`, `approved`, `reviewing`, `correction_required`, `validating`, `declined`, `burned`. */
  state?: string;
  /** Reviewer lenses that were required (start) or actually ran (capture). */
  lenses?: number;
  /** What status offers next: `start`, `collect`, `acknowledge`, `stop`. */
  next?: string;
  /** Delivery gate decision. */
  gate?: "allow" | "deny";
  /** Why the gate denied or why a refusal happened (`review_due`, `binding_drift`, `correction_pending`, `unchanged_candidate`, ...). */
  reason?: string;
  /** RDD mode in effect. */
  mode?: "on" | "off";
  /** Lineages known to the review authority. */
  lineages?: number;
}

/** What a subject returns for one step. */
export interface Observation {
  facts: NormalizedFacts;
  events: MetricEvent[];
}

export interface FixtureSpec {
  /** The change under review. */
  change: "none" | Risk;
  /** Left uncommitted in the working tree, or committed on the branch (ahead of the remote when `origin`). */
  placement?: "workspace" | "committed";
  /** A second, different workspace change on top of a committed one (journeys about the workspace not authorizing the committed range). */
  extraWorkspace?: boolean;
  /** Bare origin wired and in sync before the change. */
  origin?: boolean;
  /** RDD mode at the start (default off). */
  rdd?: "on" | "off";
}

export interface SubjectSession {
  exec(step: StepSpec): Promise<Observation>;
}

export interface Subject {
  readonly name: "odd" | "oracle";
  /** Why this subject cannot express the journey at all, or undefined. Checked before anything runs. */
  unsupported?(def: JourneyDef): string | undefined;
  /** The projection this subject is expected to produce when its product legitimately differs from the shared expectation (default: `expectedProjection`). */
  expected?(def: JourneyDef): Projection;
  /** Applies the fixture inside the sandbox and returns the session that executes steps. Runs before counters reset. */
  open(env: JourneyEnv, fixture: FixtureSpec): Promise<SubjectSession>;
}

export interface JourneyStepDef { do: StepSpec; expect: NormalizedFacts }

/** A journey as data (see above); `toJourney` binds it to a subject. */
export interface JourneyDef {
  id: string;
  /** Closest upstream journey id, for traceability only (their vocabulary and behavior may differ). */
  refId?: string;
  description: string;
  fixture: FixtureSpec;
  steps: JourneyStepDef[];
  deadlineMs?: number;
}

/** The projection of a journey: one normalized entry per step, in order. */
export const expectedProjection = (def: JourneyDef): Projection => ({ steps: def.steps.map((s) => ({ step: s.do.kind, ...s.expect })) });

/** Binds an abstract journey to a subject: the runner then accounts friction from the events the subject reports. */
export function toJourney(def: JourneyDef, subject: Subject): Journey {
  const sessions = new WeakMap<Sandbox, SubjectSession>();
  const seen = new WeakMap<Sandbox, Record<string, unknown>[]>();
  return {
    id: def.id,
    ...(def.refId !== undefined ? { refId: def.refId } : {}),
    description: def.description,
    needsOrigin: def.fixture.origin === true,
    ...(subject.unsupported?.(def) !== undefined ? { unsupported: subject.unsupported(def)! } : {}),
    ...(def.deadlineMs !== undefined ? { deadlineMs: def.deadlineMs } : {}),
    expected: subject.expected?.(def) ?? expectedProjection(def),
    async setup(env) {
      sessions.set(env.sandbox, await subject.open(env, def.fixture));
      seen.set(env.sandbox, []);
    },
    steps: def.steps.map((s, i): Step => ({
      name: `${i + 1}. ${s.do.kind}`,
      actor: "events",
      async run(env) {
        const session = sessions.get(env.sandbox);
        if (!session) throw new Error("journey session was not opened");
        const obs = await session.exec(s.do);
        const list = seen.get(env.sandbox)!;
        list.push({ step: s.do.kind, ...obs.facts });
        return { ok: true, observed: { steps: [...list] }, events: obs.events };
      },
    })),
  };
}
