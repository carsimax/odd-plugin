// Correction loop and drift guards.
import type { JourneyDef } from "../journey.js";
import { step } from "./dsl.js";

export const correctionJourneys: JourneyDef[] = [
  {
    id: "correction-then-validator-approves",
    refId: "j113-correction-removes-candidate-only-path",
    description: "A severe finding sends the review to correction; the corrected candidate goes to one validator, which approves it, and the approval is acknowledged.",
    fixture: { change: "high" },
    steps: [
      step({ kind: "start", consent: "granted" }, { outcome: "consented", risk: "high", state: "reviewing", lenses: 4 }),
      step({ kind: "captureAll", verdict: "findings" }, { outcome: "correction_required", state: "correction_required", lenses: 4 }),
      step({ kind: "correct", edit: "fix" }, { outcome: "forecast", state: "validating" }),
      step({ kind: "captureAll", verdict: "approve" }, { outcome: "approved", state: "approved", lenses: 0 }),
      step({ kind: "acknowledge" }, { outcome: "acknowledged", state: "burned" }),
    ],
  },
  {
    id: "correction-noop-refused",
    refId: "j51-negotiated-status-correction-continuation",
    description: "Handing the review back without changing the code is refused: the review still waits for its correction and no validator runs.",
    fixture: { change: "high" },
    steps: [
      step({ kind: "start", consent: "granted" }, { outcome: "consented", risk: "high", state: "reviewing", lenses: 4 }),
      step({ kind: "captureAll", verdict: "findings" }, { outcome: "correction_required", state: "correction_required", lenses: 4 }),
      step({ kind: "correct", edit: "noop" }, { outcome: "refused", reason: "unchanged_candidate", state: "correction_required" }),
    ],
  },
  {
    id: "duplicate-start-guard-during-correction",
    description: "While a review waits for its correction, a direct start on the corrected code opens no second review: it is refused and names the pending one.",
    fixture: { change: "high" },
    steps: [
      step({ kind: "start", consent: "granted" }, { outcome: "consented", risk: "high", state: "reviewing", lenses: 4 }),
      step({ kind: "captureAll", verdict: "findings" }, { outcome: "correction_required", state: "correction_required", lenses: 4 }),
      step({ kind: "correct", edit: "drift" }, { outcome: "edited" }),
      step({ kind: "start", consent: "relay" }, { outcome: "refused", reason: "correction_pending" }),
      step({ kind: "inspect" }, { outcome: "inspected", mode: "off", lineages: 1 }),
    ],
  },
  {
    id: "binding-drift-mid-run",
    description: "The code changes after consent and before the reviewers run: the run is refused as binding drift and no reviewer starts.",
    fixture: { change: "medium" },
    steps: [
      step({ kind: "start", consent: "granted" }, { outcome: "consented", risk: "medium", state: "reviewing", lenses: 1 }),
      step({ kind: "correct", edit: "drift" }, { outcome: "edited" }),
      step({ kind: "resume" }, { outcome: "refused", reason: "binding_drift" }),
    ],
  },
  {
    id: "binding-drift-after-consent-question",
    description: "The code changes while the consent question is open: the human's answer is bound to the candidate they saw, so it is refused and records nothing.",
    fixture: { change: "medium" },
    steps: [
      step({ kind: "start", consent: "relay" }, { outcome: "consent_required", risk: "medium", state: "none" }),
      step({ kind: "correct", edit: "drift" }, { outcome: "edited" }),
      step({ kind: "answerConsent", answer: "granted" }, { outcome: "refused", reason: "binding_drift", state: "none" }),
      step({ kind: "inspect" }, { outcome: "inspected", mode: "off", lineages: 0 }),
    ],
  },
];
