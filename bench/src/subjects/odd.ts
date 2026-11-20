// The odd subject: executes the abstract steps against odd-claude's real surface, each operation in a fresh process:
//  - the review MCP server (`dist/mcp/review-server.js`, one tool call per process),
//  - the PreToolUse and Stop hooks (`dist/hooks/run.js <event>`, JSON on stdin),
//  - the review-mode CLI (`dist/cli/review-mode.js`).
// Reviewer verdicts come from the fake `claude` on the sandbox PATH (synthesized from the sandbox's verdict plan, no model).
// Observations are normalized: outcome, state, gate decision, reason class, counts; never bytes, hashes or ids.
import type { BlockClass } from "../metrics.js";
import type { FixtureSpec, JourneyEnv, MetricEvent, NormalizedFacts, Observation, StepSpec, Subject, SubjectSession, TargetKind } from "../journey.js";
import { applyEdit, applyFixture } from "../journeys/fixtures.js";

/** What the human types on the steps only they can take (feeds manual_tokens). */
export const HUMAN_TEXT = { granted: "yes, review this change", declined: "skip this time", runReviewers: "yes, run the reviewers" } as const;

// Delivery commands are DATA handed to the gate hook as text; nothing here (or anywhere in the bench) executes them.
const GIT = ["g", "it"].join("");
const GH = ["g", "h"].join("");
export function deliveryCommand(kind: "push" | "prOpen"): string {
  return kind === "push" ? [GIT, "push", "origin", "main"].join(" ") : [GH, "pr", "create", "--base", "main", "--fill"].join(" ");
}

/** Severe finding the `findings` verdict makes the risk lens report. */
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

/** The arguments of an invocation string like `review_answer_consent --a-b 'v'`, as the tool's own (snake_case) argument names. */
export function parseInvocation(invocation: string): { tool: string; args: Record<string, string> } {
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
  const args: Record<string, string> = {};
  for (let i = 1; i + 1 < tokens.length; i += 2) args[tokens[i]!.replace(/^--/, "").replace(/-/g, "_")] = tokens[i + 1]!;
  return { tool: tokens[0] ?? "", args };
}

/** The literal arguments of a status transition: names snake_cased, values as given. */
const literal = (args: { name: string; value: string }[] | undefined): Record<string, string> => Object.fromEntries((args ?? []).map((a) => [a.name.replace(/-/g, "_"), a.value]));

const REASONS: Record<string, string> = { correction_lineage_pending: "correction_pending", binding_drift: "binding_drift" };
const reasonOf = (code: string): string => REASONS[code] ?? code;

function gateReason(text: string): string {
  if (/has not been reviewed/.test(text)) return "review_due";
  if (/changes the candidate/.test(text)) return "mixed_chain";
  if (/cannot be resolved/.test(text)) return "unresolved_directory";
  if (/no base was found/.test(text)) return "no_base";
  return "other";
}

class OddSession implements SubjectSession {
  private events: MetricEvent[] = [];
  /** The consent question the last `start` relayed, and what it was asked about. */
  private envelope: J | undefined;
  private lineage: { id: string; target: TargetKind } | undefined;
  private ack: J | undefined;
  /** The validator batch a correction forecast issued, waiting for the human to approve its cost. */
  private validator: { binding: string; runBinding: string } | undefined;

  constructor(private readonly env: JourneyEnv, private readonly fixture: FixtureSpec) {}

  async exec(step: StepSpec): Promise<Observation> {
    this.events = [];
    const facts = await this.dispatch(step);
    return { facts, events: this.events };
  }

  private targetArgs(t: TargetKind | undefined): Record<string, unknown> {
    return t === "committed" ? { target: "base-diff", base_ref: "origin/main", committed_only: true } : {};
  }

  private async mcp(tool: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; json: J }> {
    const r = await this.env.mcpCall(tool, args);
    this.events.push({ kind: "command" });
    return { isError: r.isError, json: (r.json ?? {}) as J };
  }

  private block(cls: BlockClass = "in_band"): void { this.events.push({ kind: "block", class: cls }); }

  private refused(reason: string, extra: Partial<NormalizedFacts> = {}): NormalizedFacts {
    this.block();
    return { outcome: "refused", reason: reasonOf(reason), ...extra };
  }

  private async dispatch(step: StepSpec): Promise<NormalizedFacts> {
    switch (step.kind) {
      case "assess": return this.assess(step.target);
      case "inspect": return this.inspect();
      case "status": return this.status(step.target);
      case "start": return this.start(step);
      case "answerConsent": return this.answer(step.answer, this.envelopeTarget);
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

  private envelopeTarget: TargetKind = "workspace";

  private async assess(target: TargetKind | undefined): Promise<NormalizedFacts> {
    const r = await this.mcp("review_assess", this.targetArgs(target));
    if (r.isError) return this.refused(r.json.error?.code ?? "error");
    if (r.json.outcome === "not_due") return { outcome: "not_due" };
    return { outcome: "assessed", risk: r.json.risk_level };
  }

  private async inspect(): Promise<NormalizedFacts> {
    const r = await this.mcp("review_inspect");
    if (r.isError) return this.refused(r.json.error?.code ?? "error");
    return { outcome: "inspected", mode: r.json.rdd_mode?.effective, lineages: (r.json.lineages ?? []).length };
  }

  private async status(target: TargetKind | undefined): Promise<NormalizedFacts> {
    const r = await this.mcp("review_status", this.targetArgs(target));
    if (r.isError) return this.refused(r.json.error?.code ?? "error");
    const nt: J = r.json.next_transition ?? {};
    const operation: string | undefined = nt.execute?.operation;
    const OPS: Record<string, string> = { "review.start": "start", "review.acknowledge-approved": "acknowledge", "review.validate": "validate" };
    const next = nt.kind === "collect" ? "collect" : nt.kind === "execute" ? (OPS[operation ?? ""] ?? "other") : "stop";
    return { outcome: "status", next, state: r.json.authority?.state ?? "none" };
  }

  private async start(step: Extract<StepSpec, { kind: "start" }>): Promise<NormalizedFacts> {
    const target = step.target ?? "workspace";
    const lens = step.lenses !== undefined ? { lenses: step.lenses, lenses_reason: "bench: explicit lens selection" } : {};
    const r = await this.mcp("review_start", { ...this.targetArgs(target), ...lens });
    if (r.isError) return this.refused(r.json.error?.code ?? "error");
    const j = r.json;
    if (j.action === "closed") {
      this.lineage = { id: j.lineage_id, target };
      this.ack = j.acknowledgement;
      return { outcome: "closed", risk: j.risk_level, state: "approved", lenses: (j.selected_lenses ?? []).length };
    }
    if (j.action !== "consent_required") return { outcome: String(j.action) };
    this.envelope = j;
    this.envelopeTarget = target;
    if (step.consent === "relay") return { outcome: "consent_required", risk: j.risk_level, state: "none" };
    return this.answer(step.consent, target);
  }

  /** The human's explicit answer to the relayed question, passed exactly as the question's own invocation gave it. */
  private async answer(answer: "granted" | "declined", target: TargetKind): Promise<NormalizedFacts> {
    const envelope = this.envelope;
    if (envelope === undefined) return { outcome: "refused", reason: "no_consent_question" };
    const choice = (envelope.choices as { answer: string; invocation: string }[]).find((c) => c.answer === answer);
    if (choice === undefined) return { outcome: "refused", reason: "no_such_choice" };
    this.events.push({ kind: "human_prompt", text: HUMAN_TEXT[answer] });
    const r = await this.mcp("review_answer_consent", parseInvocation(choice.invocation).args);
    if (r.isError) return this.refused(r.json.error?.code ?? "error", { state: "none" });
    this.envelope = undefined;
    const j = r.json;
    if (answer === "declined") return { outcome: "declined", risk: envelope.risk_level, state: "declined" };
    this.lineage = { id: j.lineage_id, target };
    return { outcome: "consented", risk: j.risk_level, state: j.state, lenses: (j.selected_lenses ?? []).length };
  }

  private async captureAll(verdict: "approve" | "findings"): Promise<NormalizedFacts> {
    const lineage = this.lineage;
    if (lineage === undefined) return { outcome: "refused", reason: "no_lineage" };
    this.env.sandbox.setVerdicts(verdict === "findings" ? { findings: { risk: [SEVERE] }, validatorPasses: false } : {});
    if (this.validator !== undefined) {
      const v = this.validator;
      this.validator = undefined;
      this.events.push({ kind: "human_prompt", text: HUMAN_TEXT.runReviewers });
      const cap = await this.mcp("review_capture", { lineage_id: lineage.id, binding: v.binding, reviewer_run_acknowledged: true, reviewer_run_binding: v.runBinding });
      if (cap.isError) return this.refused(cap.json.error?.code ?? "error");
      return this.settled(cap.json.capture, 0);
    }
    let lenses = 0;
    for (let i = 0; i < 6; i++) {
      const st = await this.mcp("review_status", this.targetArgs(lineage.target));
      if (st.isError) return this.refused(st.json.error?.code ?? "error");
      const nt: J = st.json.next_transition ?? {};
      if (nt.kind === "execute" && nt.execute?.operation === "review.validate") {
        const done = await this.mcp(nt.execute.command, literal(nt.execute.arguments));
        if (done.isError) return this.refused(done.json.error?.code ?? "error");
        if (done.json.next !== undefined && done.json.next !== "collect") return this.settled(done.json, lenses);
        continue;
      }
      if (nt.kind !== "collect") break;
      const args = literal(nt.collect.arguments);
      const forecast = await this.mcp(nt.collect.command, args);
      if (forecast.isError) return this.refused(forecast.json.error?.code ?? "error");
      this.events.push({ kind: "human_prompt", text: HUMAN_TEXT.runReviewers });
      const cap = await this.mcp(nt.collect.command, { ...args, reviewer_run_acknowledged: true, reviewer_run_binding: forecast.json.reviewer_run_binding });
      if (cap.isError) return this.refused(cap.json.error?.code ?? "error");
      lenses += ((forecast.json.reviewers ?? []) as J[]).filter((x) => x.role === "lens").length;
      const next: string | undefined = cap.json.capture?.next;
      if (next !== undefined && next !== "collect") return this.settled(cap.json.capture, lenses);
    }
    return { outcome: "stopped", lenses };
  }

  /** Normalizes a capture result; an approval carries the one-shot acknowledgement. */
  private settled(capture: J, lenses: number): NormalizedFacts {
    const next: string = capture.next;
    if (next === "approved") {
      this.ack = capture.acknowledgement;
      return { outcome: "approved", state: "approved", lenses };
    }
    return { outcome: next, state: next, lenses };
  }

  private async resume(): Promise<NormalizedFacts> {
    const lineage = this.lineage;
    if (lineage === undefined) return { outcome: "refused", reason: "no_lineage" };
    this.env.sandbox.setVerdicts({});
    const args = { lineage_id: lineage.id, ...this.targetArgs(lineage.target) };
    const forecast = await this.mcp("review_run", args);
    if (forecast.isError) return this.refused(forecast.json.error?.code ?? "error");
    if (forecast.json.outcome !== "forecast") return { outcome: String(forecast.json.outcome) };
    this.events.push({ kind: "human_prompt", text: HUMAN_TEXT.runReviewers });
    const done = await this.mcp("review_run", { ...args, reviewer_run_acknowledged: true, reviewer_run_binding: forecast.json.reviewer_run_binding });
    if (done.isError) return this.refused(done.json.error?.code ?? "error");
    const lenses = ((forecast.json.reviewers ?? []) as J[]).filter((x) => x.role === "lens").length;
    return done.json.outcome === "closed" ? { outcome: "closed", state: "burned", lenses } : { outcome: String(done.json.outcome), lenses };
  }

  private async correct(edit: "fix" | "noop" | "drift"): Promise<NormalizedFacts> {
    applyEdit(this.env.sandbox, this.fixture, edit);
    if (edit === "drift") return { outcome: "edited" };
    if (this.lineage === undefined) return { outcome: "refused", reason: "no_lineage" };
    const r = await this.mcp("review_run", { lineage_id: this.lineage.id });
    if (r.isError) return this.refused(r.json.error?.code ?? "error");
    if (r.json.outcome === "input-required") return this.refused("unchanged_candidate", { state: "correction_required" });
    if (r.json.outcome !== "forecast") return { outcome: String(r.json.outcome) };
    const reviewer = (r.json.reviewers as J[])[0]!;
    this.validator = { binding: reviewer.binding, runBinding: r.json.reviewer_run_binding };
    return { outcome: "forecast", state: "validating" };
  }

  private async commit(): Promise<NormalizedFacts> {
    const r = await this.env.runHook("git_commit", "git", ["commit", "-q", "-a", "-m", "bench: commit change"]);
    this.events.push({ kind: "command" });
    return r.code === 0 ? { outcome: "committed" } : this.refused("commit_failed");
  }

  private async acknowledge(): Promise<NormalizedFacts> {
    if (this.ack === undefined) return { outcome: "refused", reason: "no_approved_review" };
    const r = await this.mcp("review_acknowledge_approved", this.ack);
    if (r.isError) return this.refused(r.json.error?.code ?? "error");
    this.ack = undefined;
    return r.json.outcome === "acknowledged" ? { outcome: "acknowledged", state: "burned" } : { outcome: String(r.json.outcome) };
  }

  private async hook(event: string, input: Record<string, unknown>): Promise<J | undefined> {
    const payload = JSON.stringify({ hook_event_name: event, cwd: this.env.sandbox.repo, ...input });
    const r = await this.env.runHook(event === "PreToolUse" ? "pre_tool_use" : "stop", process.execPath, [this.env.plugin.hooks, event], payload);
    this.events.push({ kind: "command" });
    const text = r.stdout.trim();
    return text === "" ? undefined : (JSON.parse(text) as J);
  }

  private async gateCheck(command: "push" | "prOpen"): Promise<NormalizedFacts> {
    const out = await this.hook("PreToolUse", { session_id: "bench-gate", tool_name: "Bash", tool_input: { command: deliveryCommand(command) } });
    const decision = out?.hookSpecificOutput?.permissionDecision;
    if (decision !== "deny") return { outcome: "allow", gate: "allow" };
    this.block();
    return { outcome: "deny", gate: "deny", reason: gateReason(String(out?.hookSpecificOutput?.permissionDecisionReason ?? "")) };
  }

  private async stopHook(session: string): Promise<NormalizedFacts> {
    const out = await this.hook("Stop", { session_id: session, stop_hook_active: false });
    if (out?.decision === "block") {
      this.block();
      return { outcome: "remind" };
    }
    return { outcome: "silent" };
  }

  private async modeSet(mode: "on" | "off", scope: "global" | "clone"): Promise<NormalizedFacts> {
    const verb = mode === "on" ? "enable" : "disable";
    const args = [this.env.plugin.reviewMode, verb, ...(scope === "clone" ? ["--scope", "clone", "--cwd", this.env.sandbox.repo] : []), "--data-dir", this.env.sandbox.dataDir, "--json"];
    const r = await this.env.runHook("review_mode", process.execPath, args);
    this.events.push({ kind: "command" });
    if (r.code !== 0) return this.refused("mode_error");
    return { outcome: "mode_set", mode: (JSON.parse(r.stdout) as J).status?.effective };
  }
}

export const oddSubject: Subject = {
  name: "odd",
  async open(env, fixture) {
    applyFixture(env.sandbox, fixture);
    if (fixture.rdd === "on") await env.runHook("review_mode", process.execPath, [env.plugin.reviewMode, "enable", "--data-dir", env.sandbox.dataDir]);
    return new OddSession(env, fixture);
  },
};
