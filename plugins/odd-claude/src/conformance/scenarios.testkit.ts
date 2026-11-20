// Test-only: the lifecycle steps of a review as a MCP client takes them, shared by the conformance specs. Every step goes through the
// real stdio server, follows only what the previous envelope told the client to do (consent choices, status transitions, forecasts)
// and returns the raw bodies so a spec can assert on them.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { consentArgs, errorCode, git, good, lit, RANGE, type McpClient, type World } from "./harness.testkit.js";

export interface Ack {
  lineage_id: string;
  target_identity: string;
  expected_revision: string;
  token: string;
}

/** review_start on the committed range: the consent envelope for medium/high, the closed start for low. */
export const relay = async (c: McpClient, extra: Record<string, unknown> = {}): Promise<any> => good(await c.call("review_start", { ...RANGE, ...extra }));

/** The human's `granted` answer to a consent envelope, exactly as its choice invocation spells it. */
export async function grant(c: McpClient, w: World, consent: any): Promise<any> {
  return good(await c.call("review_answer_consent", { cwd: w.repo, ...RANGE, ...consentArgs(consent, "granted") }));
}

export async function decline(c: McpClient, w: World, consent: any): Promise<any> {
  return good(await c.call("review_answer_consent", { cwd: w.repo, ...RANGE, ...consentArgs(consent, "declined") }));
}

export const status = async (c: McpClient, extra: Record<string, unknown> = {}): Promise<any> => good(await c.call("review_status", { ...RANGE, ...extra }));

/**
 * Takes the `collect` transition status offers: the first call returns the forecast (nothing ran), the second acknowledges exactly that
 * forecast. Returns both bodies.
 */
export async function takeCollect(c: McpClient, transition: any): Promise<{ forecast: any; captured: any }> {
  assert.equal(transition.kind, "collect", JSON.stringify(transition).slice(0, 300));
  const args = lit(transition.collect.arguments);
  const forecast = good(await c.call(transition.collect.command, args));
  assert.equal(forecast.outcome, "forecast");
  const captured = good(await c.call(transition.collect.command, { ...args, reviewer_run_acknowledged: true, reviewer_run_binding: forecast.reviewer_run_binding }));
  return { forecast, captured };
}

export const acknowledge = async (c: McpClient, w: World, ack: Ack): Promise<any> => good(await c.call("review_acknowledge_approved", { cwd: w.repo, ...ack }));

/** review_run until it stops asking for the forecast acknowledgement (at most 6 rounds); returns the first other outcome. */
export async function runToOutcome(c: McpClient, args: Record<string, unknown>): Promise<any> {
  for (let i = 0; i < 6; i++) {
    const r = good(await c.call("review_run", { ...RANGE, ...args }));
    if (r.outcome !== "forecast") return r;
    const again = good(await c.call("review_run", { ...RANGE, ...args, reviewer_run_acknowledged: true, reviewer_run_binding: r.reviewer_run_binding }));
    if (again.outcome !== "forecast") return again;
  }
  throw new Error("review_run kept forecasting");
}

/** Edits a.txt as the correction of a CRITICAL finding on it and commits (the corrected range is the new candidate). */
export function correctAndCommit(w: World, text = "ONE\ntwo\nthree\n"): void {
  writeFileSync(join(w.repo, "a.txt"), text);
  git(w.repo, "commit", "-q", "-am", "fix the finding");
}

/** consent -> granted -> collect -> capture -> approved; returns everything a later step needs. */
export async function approveThroughCapture(c: McpClient, w: World): Promise<{ consent: any; started: any; collect: any; captured: any; ack: Ack }> {
  const consent = await relay(c);
  assert.equal(consent.action, "consent_required");
  const started = await grant(c, w, consent);
  const st = await status(c);
  const { captured } = await takeCollect(c, st.next_transition);
  assert.equal(captured.outcome, "captured");
  assert.equal(captured.capture.state, "approved");
  return { consent, started, collect: st.next_transition, captured, ack: captured.capture.acknowledgement };
}

export { errorCode };
