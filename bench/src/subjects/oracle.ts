// The oracle subject: the SAME abstract journeys, executed against the upstream `gentle-ai` binary instead of odd-claude.
// Every operation is one fresh process of the binary, inside the journey sandbox, and the answers are normalized to the same facts
// and metric events the odd subject reports (see the accounting conventions in docs/bench.md):
//  - the human is asked exactly where the product asks (the consent question); the oracle has no reviewer cost forecast to approve,
//  - denials, reminders and typed refusals are `in_band` blocks (each names the route forward),
//  - model runs are observed on the sandbox PATH: the binary runs its reviewers through the fake `claude` (no model, no network),
//  - git subprocesses are observed on the sandbox PATH (the binary shells out to git through it).
// Isolation: the binary only ever sees the sandbox env (own HOME and XDG dirs; its own state lives in `$HOME/.gentle-ai`), and
// telemetry is switched off with the product's own kill switches (see `oracleEnv`). Nothing else of the product is read or written.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BlockClass } from "../metrics.js";
import {
  type FixtureSpec, type JourneyDef, type JourneyEnv, type MetricEvent, type NormalizedFacts, type Observation, type StepSpec, type Subject, type SubjectSession, type TargetKind,
} from "../journey.js";
import { applyEdit, applyFixture } from "../journeys/fixtures.js";
import type { Projection } from "../schema.js";
import { createSandbox } from "../sandbox.js";
import { runProcess } from "../process.js";
import { HUMAN_TEXT } from "./odd.js";

/** The oracle binary (upstream 4.6.0, older than the 08317b9 sources the journeys were ported from). Override with ODD_BENCH_ORACLE_BIN. */
export const ORACLE_DEFAULT_BINARY = join(homedir(), ".local/share/odd-claude-oracle/gentle-ai-4.6.0/bin/gentle-ai");
export const oracleBinaryPath = (): string => process.env.ODD_BENCH_ORACLE_BIN || ORACLE_DEFAULT_BINARY;
export const oracleAvailable = (): boolean => existsSync(oracleBinaryPath());

const CONTRACT = "gentle-ai.review-integration/v2";
const AGENT = "claude-code";

/**
 * The environment the binary runs in: the sandbox env (built from scratch, own HOME/XDG/CLAUDE_* dirs) plus the product's switches.
 * Where the product keeps its own state: `$HOME/.gentle-ai` (state, stop-hook sessions) and `<repo>/.git/gentle-ai` (review authority),
 * both inside the sandbox. Telemetry: the product sends nothing when DO_NOT_TRACK is set (first kill switch in its precedence order),
 * GENTLE_AI_TELEMETRY=0 is the second, and the collector endpoint is pointed at a closed loopback port as a last guard, so that
 * even a switch that failed could reach no real server. The review commands never contact the network otherwise.
 */
export function oracleEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...base,
    USERPROFILE: base.HOME,
    DO_NOT_TRACK: "1",
    GENTLE_AI_TELEMETRY: "0",
    GENTLE_AI_TELEMETRY_ENDPOINT: "http://127.0.0.1:9/v1/events",
    NO_COLOR: "1",
    TERM: "dumb",
    GIT_TERMINAL_PROMPT: "0",
  };
}

/** `gentle-ai version` printed in an isolated sandbox env, e.g. `4.6.0`. Throws when the binary does not answer. */
export async function captureOracleVersion(binary = oracleBinaryPath()): Promise<string> {
  const sb = await createSandbox();
  try {
    const r = await runProcess(binary, ["version"], { cwd: sb.repo, env: oracleEnv(sb.env), deadlineMs: 20_000 });
    const m = /^gentle-ai (\S+)/.exec(r.stdout.trim());
    if (r.code !== 0 || m === null) throw new Error(`oracle binary did not report a version: exit ${String(r.code)} ${r.stdout}${r.stderr}`);
    return m[1]!;
  } finally {
    sb.cleanup();
  }
}

// ---------------------------------------------------------------------------------------------------------------------------
// Mapping table: upstream vocabulary -> odd vocabulary. One row per upstream value; the comment says why the two are the same thing.
// An upstream value without a row is an error, never a guess (it is how version skew shows up).
// ---------------------------------------------------------------------------------------------------------------------------

export type MappingKind = "risk" | "start" | "capture" | "next" | "refusal" | "gate" | "reminder";
export interface MappingRow { kind: MappingKind; upstream: string; odd: string; comment: string }

export const MAPPING: readonly MappingRow[] = [
  // assess --json `risk`: documentation-only changes are "passive"; odd calls that tier low.
  { kind: "risk", upstream: "passive", odd: "low", comment: "documentation-only change: no lens, closed at start" },
  // assess --json `risk`: any other executable change outside the high-risk paths is the medium tier (one lens), same name as odd's.
  { kind: "risk", upstream: "medium", odd: "medium", comment: "plain executable change: one consolidated lens" },
  // assess --json `risk`: high-risk paths (auth, ...) review with the four-lens group, like odd's high tier.
  { kind: "risk", upstream: "high", odd: "high", comment: "four-lens group" },

  // review start `action` for a consent relay that needs no question: the review was closed on the spot (low risk) and carries its acknowledgement.
  { kind: "start", upstream: "closed", odd: "closed", comment: "closed at start with an acknowledgement" },
  // review start `action` for the blocking consent question the human must answer.
  { kind: "start", upstream: "consent_required", odd: "consent_required", comment: "the human is asked before any reviewer runs" },
  // review start `action` after the human granted: a lineage exists in `reviewing`; odd calls this `consented`.
  { kind: "start", upstream: "created", odd: "consented", comment: "granted consent created the review" },
  // review start `action` after the human declined: nothing is created (the decline binds that one candidate only).
  { kind: "start", upstream: "declined", odd: "declined", comment: "declined consent creates nothing" },

  // last-event closure `state` of the final reviewer or validator capture: approved, with the one-shot acknowledgement.
  { kind: "capture", upstream: "approved", odd: "approved", comment: "the last capture closed the review approved" },
  // last-event closure `state` when a candidate-caused severe finding needs one bounded correction.
  { kind: "capture", upstream: "correction_required", odd: "correction_required", comment: "a severe finding sends the review to correction" },
  // last-event closure `state` when the bounded correction was spent without an approval.
  { kind: "capture", upstream: "escalated", odd: "escalated", comment: "no correction budget left: the human decides" },

  // status next_transition execute review.start: the product offers a (consent-relayed) start, odd's `start`.
  { kind: "next", upstream: "execute:review.start", odd: "start", comment: "fresh candidate ready for review" },
  // status next_transition execute review.acknowledge-approved: the approved review waits for its acknowledgement.
  { kind: "next", upstream: "execute:review.acknowledge-approved", odd: "acknowledge", comment: "approved, acknowledgement pending" },
  // status next_transition execute review.validate: a delivery gate validation is offered.
  { kind: "next", upstream: "execute:review.validate", odd: "validate", comment: "gate validation" },
  // status next_transition collect (reviewer results, correction plan, validator): the product waits for results to be collected.
  { kind: "next", upstream: "collect", odd: "collect", comment: "results to collect" },
  // status next_transition stop: the product offers nothing (an own typed reason says why); odd's `stop`.
  { kind: "next", upstream: "stop", odd: "stop", comment: "nothing to offer" },

  // failure code of a consent answer or a start bound to a candidate that moved since the human saw it: odd's binding drift.
  { kind: "refusal", upstream: "stale_target_identity", odd: "binding_drift", comment: "the answer is bound to the candidate the human saw, not the one on disk now" },
  // stop reason of the correction status when the plan is captured but the candidate did not change: odd refuses the hand-back as an unchanged candidate.
  { kind: "refusal", upstream: "corrected_candidate_unavailable", odd: "unchanged_candidate", comment: "no corrected candidate to validate" },

  // gate result `delivery` while RDD is on: the gate never decides; repository policy does. It never vetoes, so odd's `allow`.
  { kind: "gate", upstream: "unmanaged", odd: "allow", comment: "non-deciding gate: no veto" },
  // gate result `delivery` while RDD is off: same, the kill switch defers to ordinary repository policy.
  { kind: "gate", upstream: "disabled/unmanaged", odd: "allow", comment: "kill switch on: no veto" },

  // stop-hook `decision` block: the agent is reminded to run the status preflight; odd's `remind`.
  { kind: "reminder", upstream: "block", odd: "remind", comment: "unreviewed candidate reminder" },
  // stop-hook empty output: the hook stays silent.
  { kind: "reminder", upstream: "", odd: "silent", comment: "nothing to say" },
];

/** The odd-vocabulary value of an upstream one; throws when the table has no row for it. */
export function mapValue(kind: MappingKind, upstream: string): string {
  const row = MAPPING.find((r) => r.kind === kind && r.upstream === upstream);
  if (row === undefined) throw new Error(`oracle mapping has no ${kind} row for ${JSON.stringify(upstream)} (version skew?)`);
  return row.odd;
}

/** The odd-vocabulary refusal reason of an upstream failure; unknown typed codes keep their own name (prefixed) so they are visible, never silent. */
export function refusalReason(code: string): string {
  const row = MAPPING.find((r) => r.kind === "refusal" && r.upstream === code);
  return row?.odd ?? `oracle:${code}`;
}

// ---------------------------------------------------------------------------------------------------------------------------

/** Why the oracle cannot express a journey at all (undefined: it can). Evidence for each reason is pinned in oracle.spec.ts. */
export function oracleUnsupportedReason(def: JourneyDef): string | undefined {
  if (def.steps.some((s) => s.expect.gate === "deny")) {
    return "4.6.0 `review validate --gate` is non-deciding: for every candidate it reports delivery=unmanaged (allowed=false, repository policy decides), so the product has no delivery denial to compare";
  }
  return undefined;
}

export interface Divergence { journey: string; step: number; facts: NormalizedFacts; comment: string }

/**
 * Where the product legitimately behaves differently from the shared expectation (found by running the journey against the binary and
 * kept as the oracle's own expected step, so a change of the oracle's behavior is still caught). Each is a finding, not a failure.
 */
export const DIVERGENCES: readonly Divergence[] = [
  // The decline binds the one candidate and persists nothing, so the status offers the start again; odd records the decline and offers nothing.
  { journey: "consent-declined-creates-no-review", step: 3, facts: { outcome: "status", next: "start", state: "none" }, comment: "a decline persists nothing" },
  // The product has no pending-correction guard on a direct start: for the changed candidate it asks consent anew (the pending review stays in its inventory).
  { journey: "duplicate-start-guard-during-correction", step: 3, facts: { outcome: "consent_required", risk: "high", state: "none" }, comment: "no duplicate-start guard" },
  // Reviewers read the frozen candidate trees, never the live worktree, so a change after consent does not refuse the run: the review closes on the frozen candidate.
  { journey: "binding-drift-mid-run", step: 2, facts: { outcome: "closed", state: "burned", lenses: 1 }, comment: "frozen candidate review ignores later drift" },
];

/** The oracle's expected projection: the shared one, with the product default RDD mode (on) and the divergences above. */
export function oracleExpected(def: JourneyDef): Projection {
  return {
    steps: def.steps.map((s, i) => {
      const own = DIVERGENCES.find((d) => d.journey === def.id && d.step === i);
      if (own !== undefined) return { step: s.do.kind, ...own.facts };
      // The product starts with receipt-driven development on (odd: off); a journey that neither sets it in the fixture nor switches it keeps the product's default.
      const modeTouched = def.steps.slice(0, i).some((p) => p.do.kind === "modeSet");
      if (s.do.kind === "inspect" && def.fixture.rdd === undefined && !modeTouched && s.expect.mode === "off") return { step: s.do.kind, ...s.expect, mode: "on" };
      return { step: s.do.kind, ...s.expect };
    }),
  };
}

/** Severe finding the `findings` verdict makes the risk lens report (same shape the odd subject uses; it is the reviewer result schema's own). */
const SEVERE = {
  location: "src/auth/login.ts:1",
  severity: "CRITICAL",
  claim: "the login path accepts input it never checked",
  proof_refs: ["src/auth/login.ts:1 reads the user unchecked"],
  evidence_class: "deterministic",
  causal_disposition: "introduced",
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = Record<string, any>;
interface Run { code: number | null; text: string; stderr: string; json: J }

/** Splits a printed shell invocation (`gentle-ai review start --a 'b c'`) into its arguments after the program name. */
export function invocationArgs(invocation: string): string[] {
  const tokens: string[] = [];
  let cur = "", quoted = false, any = false;
  for (let i = 0; i < invocation.length; i++) {
    const ch = invocation[i]!;
    if (quoted) { if (ch === "'") quoted = false; else cur += ch; }
    else if (ch === "'") { quoted = true; any = true; }
    else if (ch === "\\" && invocation[i + 1] !== undefined) cur += invocation[++i];
    else if (ch === " ") { if (cur !== "" || any) tokens.push(cur); cur = ""; any = false; }
    else cur += ch;
  }
  if (cur !== "" || any) tokens.push(cur);
  return tokens.slice(1);
}

/** Why a row whose gate reported `delivery=unmanaged` is excluded from the comparison. */
export const UNMANAGED_GATE_REASON = "the oracle gate reported delivery=unmanaged: it never decides, so its near-zero cost is no win over a gate that does";

const tokenOf = (args: J[] | undefined, name: string): string | undefined => (args ?? []).find((a) => a.name === name)?.value;

class OracleSession implements SubjectSession {
  private events: MetricEvent[] = [];
  private envelope: J | undefined;
  private lineage: string | undefined;
  /** The last status command the product printed for the lineage, verbatim. */
  private statusCommand: string[] | undefined;
  private ack: string[] | undefined;
  private target: TargetKind = "workspace";
  private lenses = 0;

  constructor(private readonly env: JourneyEnv, private readonly fixture: FixtureSpec, private readonly binary: string) {}

  async exec(step: StepSpec): Promise<Observation> {
    this.events = [];
    const facts = await this.dispatch(step);
    return { facts, events: this.events };
  }

  private async cli(args: string[], opts: { stdin?: string } = {}): Promise<Run> {
    const op = args[0] === "review" ? `review_${(args[1] ?? "").replace(/-/g, "_")}` : (args[0] ?? "cli");
    const r = await this.env.runCli(op, this.binary, args, { env: oracleEnv(this.env.sandbox.env), ...opts });
    this.events.push({ kind: "command" });
    let json: J = {};
    try { json = JSON.parse(r.stdout) as J; } catch { /* a text answer */ }
    return { code: r.code, text: r.stdout, stderr: r.stderr, json };
  }

  private block(cls: BlockClass = "in_band"): void { this.events.push({ kind: "block", class: cls }); }

  private refused(reason: string, extra: Partial<NormalizedFacts> = {}): NormalizedFacts {
    this.block();
    return { outcome: "refused", reason, ...extra };
  }

  /** A typed failure of the product (non-zero exit with a failure envelope): the refusal, named in odd's vocabulary. */
  private failed(r: Run, extra: Partial<NormalizedFacts> = {}): NormalizedFacts {
    return this.refused(refusalReason(String(r.json.code ?? `exit_${String(r.code)}`)), extra);
  }

  private targetFlags(t: TargetKind | undefined): string[] {
    return t === "committed" ? ["--base-ref", "origin/main", "--committed-only"] : [];
  }

  private async dispatch(step: StepSpec): Promise<NormalizedFacts> {
    switch (step.kind) {
      case "assess": return this.assess(step.target);
      case "inspect": return this.inspect();
      case "status": return this.status(step.target);
      case "start": return this.start(step);
      case "answerConsent": return this.answer(step.answer);
      case "captureAll": return this.captureAll(step.verdict);
      case "resume": return this.resume();
      case "correct": return this.correct(step.edit);
      case "commit": return this.commit();
      case "acknowledge": return this.acknowledge();
      case "gateCheck": return this.gateCheck(step.command);
      case "stopHook": return this.stopHook(step.session ?? "bench-stop");
      case "modeSet": return this.modeSet(step.mode, step.scope);
    }
  }

  private async assess(target: TargetKind | undefined): Promise<NormalizedFacts> {
    const r = await this.cli(["review", "assess", "--cwd", this.env.sandbox.repo, "--json", ...this.targetFlags(target)]);
    if (r.code !== 0) return this.failed(r);
    if (r.json.changed_paths === 0) return { outcome: "not_due" };
    return { outcome: "assessed", risk: mapValue("risk", String(r.json.risk)) as NormalizedFacts["risk"] };
  }

  private async inspect(): Promise<NormalizedFacts> {
    // The product has no single "inspect" read: the mode and the lineage inventory are two commands.
    const mode = await this.cli(["review", "mode", "status", "--json", "--cwd", this.env.sandbox.repo]);
    const inv = await this.cli(["review", "status", "--cwd", this.env.sandbox.repo]);
    if (mode.code !== 0) return this.failed(mode);
    if (inv.code !== 0) return this.failed(inv);
    return { outcome: "inspected", mode: mode.json.status?.effective, lineages: (inv.json.entries ?? []).length };
  }

  /** The status the agent runs next: the printed command for the lineage when one is in flight, else the selectorless preflight. */
  private async statusRun(target: TargetKind | undefined, lenses?: string[]): Promise<Run> {
    const printed = this.statusCommand;
    if (printed !== undefined && this.lineage !== undefined) {
      const hasAgent = printed.some((a) => a.startsWith("--agent"));
      return this.cli([...printed, ...(hasAgent ? [] : [`--agent=${AGENT}`])]);
    }
    const lens = lenses !== undefined ? ["--lenses", lenses.join(","), "--lenses-reason", "bench: explicit lens selection"] : [];
    return this.cli(["review", "status", "--cwd", this.env.sandbox.repo, "--contract", CONTRACT, "--agent", AGENT, "--next-transition=true", ...this.targetFlags(target), ...lens]);
  }

  private nextOf(j: J): string {
    const nt: J = j.next_transition ?? {};
    if (nt.kind === "execute") return mapValue("next", `execute:${String(nt.execute?.operation)}`);
    return mapValue("next", String(nt.kind ?? "stop"));
  }

  private async status(target: TargetKind | undefined): Promise<NormalizedFacts> {
    const r = await this.statusRun(target);
    if (r.code !== 0) return this.failed(r);
    return { outcome: "status", next: this.nextOf(r.json) as NormalizedFacts["next"], state: r.json.authority?.state ?? "none" };
  }

  private async start(step: Extract<StepSpec, { kind: "start" }>): Promise<NormalizedFacts> {
    this.target = step.target ?? "workspace";
    // The entry rule: the selectorless status first, then exactly the start it prints (carrying the consent relay).
    this.lineage = undefined;
    this.statusCommand = undefined;
    const st = await this.statusRun(this.target, step.lenses);
    if (st.code !== 0) return this.failed(st);
    const nt: J = st.json.next_transition ?? {};
    if (nt.kind !== "execute" || nt.execute?.operation !== "review.start") return this.refused(refusalReason(String(nt.reason_code ?? nt.kind)), { state: st.json.authority?.state ?? "none" });
    const relay = await this.cli(invocationArgs(String(nt.execute.command)));
    if (relay.code !== 0) return this.failed(relay);
    const j = relay.json;
    if (j.action === "closed") {
      this.lineage = j.lineage_id;
      this.ack = j.acknowledgement?.arguments?.map((a: J) => a.token);
      return { outcome: "closed", risk: j.risk_level, state: "approved", lenses: (j.selected_lenses ?? []).length };
    }
    if (j.action !== "consent_required") return { outcome: mapValue("start", String(j.action)) };
    this.envelope = j;
    if (step.consent === "relay") return { outcome: "consent_required", risk: j.risk_level, state: "none" };
    return this.answer(step.consent);
  }

  /** The human's explicit answer, passed exactly as the question's own invocation gave it. */
  private async answer(answer: "granted" | "declined"): Promise<NormalizedFacts> {
    const envelope = this.envelope;
    if (envelope === undefined) return { outcome: "refused", reason: "no_consent_question" };
    const choice = (envelope.choices as J[]).find((c) => c.answer === answer);
    if (choice === undefined) return { outcome: "refused", reason: "no_such_choice" };
    this.events.push({ kind: "human_prompt", text: HUMAN_TEXT[answer] });
    const r = await this.cli(invocationArgs(String(choice.invocation)));
    if (r.code !== 0) return this.failed(r, { state: "none" });
    this.envelope = undefined;
    const j = r.json;
    if (answer === "declined") return { outcome: mapValue("start", String(j.action)), risk: envelope.risk_level, state: "declined" };
    this.lineage = j.lineage_id;
    this.statusCommand = invocationArgs(String(j.next_transition?.execute?.command));
    return { outcome: mapValue("start", String(j.action)), risk: j.risk_level, state: j.state, lenses: (j.selected_lenses ?? []).length };
  }

  private async captureAll(verdict: "approve" | "findings"): Promise<NormalizedFacts> {
    if (this.lineage === undefined) return { outcome: "refused", reason: "no_lineage" };
    this.env.sandbox.setVerdicts(verdict === "findings" ? { findings: { risk: [SEVERE] }, validatorPasses: false } : {});
    this.lenses = 0;
    for (let round = 0; round < 8; round++) {
      const st = await this.statusRun(this.target);
      if (st.code !== 0) return this.failed(st);
      const nt: J = st.json.next_transition ?? {};
      if (nt.kind === "execute" && nt.execute?.operation === "review.acknowledge-approved") {
        this.ack = invocationArgs(String(nt.execute.command)).slice(2);
        return { outcome: "approved", state: "approved", lenses: this.lenses };
      }
      if (nt.kind !== "collect") return { outcome: "stopped", lenses: this.lenses };
      for (const input of nt.collect.inputs as J[]) {
        const closure = await this.capture(input);
        if (closure.refused) return closure.refused;
        if (closure.settled) return closure.settled;
      }
    }
    return { outcome: "stopped", lenses: this.lenses };
  }

  /** Captures one collect input through the binary (it runs the reviewer through the fake claude on the sandbox PATH). */
  private async capture(input: J): Promise<{ refused?: NormalizedFacts; settled?: NormalizedFacts }> {
    const bound = (...names: string[]): string[] => names.flatMap((n) => [`--${n}`, tokenOf(input.arguments, n) ?? ""]);
    const cwd = ["--cwd", this.env.sandbox.repo, "--agent", AGENT];
    let r: Run;
    if (input.name === "reviewer_result") {
      r = await this.cli(["review", "capture-result", ...cwd, ...bound("repository-context", "expected-revision", "lineage", "target", "lens", "order")]);
      if (r.code !== 0) return { refused: this.failed(r) };
      this.lenses += 1;
    } else if (input.name === "provider_targeted_validator") {
      r = await this.cli(["review", "capture-validation", ...cwd, ...bound("repository-context", "expected-revision", "lineage", "target", "request-hash"), "--execute=true"]);
      if (r.code !== 0) return { refused: this.failed(r) };
    } else if (input.name === "provider_refuter") {
      r = await this.cli(["review", "capture-refuter", ...cwd, ...bound("repository-context", "expected-revision", "lineage", "target"), "--execute=true"]);
      if (r.code !== 0) return { refused: this.failed(r) };
    } else {
      throw new Error(`oracle: unexpected collect input ${String(input.name)} (version skew?)`);
    }
    if (r.json.schema !== "gentle-ai.review-last-event-closure/v1") return {};
    const state = mapValue("capture", String(r.json.state));
    if (state === "approved") this.ack = (r.json.acknowledgement?.arguments ?? []).map((a: J) => a.token);
    if (r.json.status_continuation?.command !== undefined) this.statusCommand = invocationArgs(String(r.json.status_continuation.command));
    return { settled: { outcome: state, state, lenses: this.lenses } };
  }

  /** The oracle never runs reviewers by itself in one go: resuming a consented review is capturing every lens, then acknowledging. */
  private async resume(): Promise<NormalizedFacts> {
    const done = await this.captureAll("approve");
    if (done.outcome !== "approved") return done;
    const ack = await this.acknowledge();
    return ack.outcome === "acknowledged" ? { outcome: "closed", state: "burned", lenses: done.lenses as number } : ack;
  }

  private async correct(edit: "fix" | "noop" | "drift"): Promise<NormalizedFacts> {
    if (edit === "drift") {
      applyEdit(this.env.sandbox, this.fixture, edit);
      return { outcome: "edited" };
    }
    if (this.lineage === undefined) return { outcome: "refused", reason: "no_lineage" };
    // The product wants the size of the correction before it is made: capture the plan, then edit, then ask what to validate.
    const before = await this.statusRun(this.target);
    if (before.code !== 0) return this.failed(before);
    const plan = (before.json.next_transition?.collect?.inputs as J[] | undefined)?.find((i) => i.name === "correction_lines");
    if (plan !== undefined) {
      const bound = ["repository-context", "expected-revision", "lineage", "target", "request-hash"].flatMap((n) => [`--${n}`, tokenOf(plan.arguments, n) ?? ""]);
      const captured = await this.cli(["review", "capture-correction-plan", "--cwd", this.env.sandbox.repo, ...bound, "--correction-lines", "1"]);
      if (captured.code !== 0) return this.failed(captured);
    }
    applyEdit(this.env.sandbox, this.fixture, edit);
    const after = await this.statusRun(this.target);
    if (after.code !== 0) return this.failed(after);
    const nt: J = after.json.next_transition ?? {};
    if (nt.kind === "collect" && (nt.collect.inputs as J[]).some((i) => i.name === "provider_targeted_validator")) return { outcome: "forecast", state: "validating" };
    return this.refused(refusalReason(String(nt.reason_code ?? nt.kind)), { state: after.json.authority?.state ?? "none" });
  }

  private async commit(): Promise<NormalizedFacts> {
    const r = await this.env.runCli("git_commit", "git", ["commit", "-q", "-a", "-m", "bench: commit change"]);
    this.events.push({ kind: "command" });
    return r.code === 0 ? { outcome: "committed" } : this.refused("commit_failed");
  }

  private async acknowledge(): Promise<NormalizedFacts> {
    if (this.ack === undefined) return { outcome: "refused", reason: "no_approved_review" };
    const r = await this.cli(["review", "acknowledge-approved", ...this.ack]);
    if (r.code !== 0) return this.failed(r);
    this.ack = undefined;
    return { outcome: "acknowledged", state: "burned" };
  }

  private async gateCheck(command: "push" | "prOpen"): Promise<NormalizedFacts> {
    // The delivery command itself is never run or shown to the product: the gate validates the lifecycle gate the command belongs to.
    const gate = command === "push" ? "pre-push" : "pre-pr";
    const r = await this.cli(["review", "validate", "--cwd", this.env.sandbox.repo, "--gate", gate]);
    if (r.code !== 0) return this.failed(r);
    const decision = mapValue("gate", String(r.json.delivery));
    // A gate that only reports `unmanaged` never decides, so its near-zero cost is not a measure of how cheaply it protects: the row is not comparable.
    if (/unmanaged/.test(String(r.json.delivery))) this.events.push({ kind: "not_comparable", reason: UNMANAGED_GATE_REASON });
    return { outcome: decision, gate: decision as "allow" | "deny" };
  }

  private async stopHook(session: string): Promise<NormalizedFacts> {
    const payload = JSON.stringify({ session_id: session, cwd: this.env.sandbox.repo, hook_event_name: "Stop", stop_hook_active: false });
    const r = await this.cli(["review", "stop-hook", "--agent", AGENT, "--cwd", this.env.sandbox.repo], { stdin: payload });
    if (r.code !== 0) return this.failed(r);
    const outcome = mapValue("reminder", r.text.trim() === "" ? "" : String(r.json.decision));
    if (outcome === "remind") this.block();
    return { outcome };
  }

  private async modeSet(mode: "on" | "off", scope: "global" | "clone"): Promise<NormalizedFacts> {
    const r = await this.cli(["review", "mode", mode === "on" ? "enable" : "disable", "--scope", scope, "--cwd", this.env.sandbox.repo, "--json"]);
    if (r.code !== 0) return this.refused("mode_error");
    return { outcome: "mode_set", mode: r.json.status?.effective };
  }
}

export const oracleSubject: Subject = {
  name: "oracle",
  unsupported: oracleUnsupportedReason,
  expected: oracleExpected,
  async open(env, fixture) {
    const binary = oracleBinaryPath();
    if (!existsSync(binary)) throw new Error(`oracle binary not found: ${binary} (set ODD_BENCH_ORACLE_BIN)`);
    applyFixture(env.sandbox, fixture);
    // The product starts with receipt-driven development ON and refuses every review while it is off (rdd_disabled), so a fixture that
    // does not say otherwise keeps the product default; one that does is switched, uncounted (setup).
    if (fixture.rdd !== undefined) await env.runCli("review_mode", binary, ["review", "mode", fixture.rdd === "on" ? "enable" : "disable", "--scope", "global", "--cwd", env.sandbox.repo], { env: oracleEnv(env.sandbox.env) });
    return new OracleSession(env, fixture, binary);
  },
};
