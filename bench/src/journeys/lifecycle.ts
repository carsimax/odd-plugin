// Review lifecycle by risk tier: low closes at once, medium reviews one lens, high reviews a four-lens group, a decline creates nothing.
import type { JourneyDef } from "../journey.js";
import { step } from "./dsl.js";

export const lifecycleJourneys: JourneyDef[] = [
  {
    id: "low-risk-closes-with-zero-lenses",
    refId: "j111-approved-transaction-burns-and-shipped-gates-are-unmanaged",
    description: "A documentation-only change is low risk: start closes it at once with no lens and no consent question, and one acknowledgement burns it.",
    fixture: { change: "low" },
    steps: [
      step({ kind: "assess" }, { outcome: "assessed", risk: "low" }),
      step({ kind: "start", consent: "relay" }, { outcome: "closed", risk: "low", state: "approved", lenses: 0 }),
      step({ kind: "acknowledge" }, { outcome: "acknowledged", state: "burned" }),
    ],
  },
  {
    id: "medium-risk-one-lens-consent-capture-ack",
    refId: "j114-last-reviewer-capture-closes-and-burns",
    description: "A plain source change is medium risk: consent is asked, the human grants it, one lens runs, the review is approved and acknowledged.",
    fixture: { change: "medium" },
    steps: [
      step({ kind: "assess" }, { outcome: "assessed", risk: "medium" }),
      step({ kind: "start", consent: "relay" }, { outcome: "consent_required", risk: "medium", state: "none" }),
      step({ kind: "answerConsent", answer: "granted" }, { outcome: "consented", risk: "medium", state: "reviewing", lenses: 1 }),
      step({ kind: "captureAll", verdict: "approve" }, { outcome: "approved", state: "approved", lenses: 1 }),
      step({ kind: "acknowledge" }, { outcome: "acknowledged", state: "burned" }),
    ],
  },
  {
    id: "high-risk-four-lens-group",
    refId: "j60-explicit-active-lineage-keeps-four-lens-correction-and-validator-flow",
    description: "An auth-path change is high risk: consent is granted, status routes one four-lens group, all four reviewers are admitted together and the review is approved.",
    fixture: { change: "high" },
    steps: [
      step({ kind: "start", consent: "granted" }, { outcome: "consented", risk: "high", state: "reviewing", lenses: 4 }),
      step({ kind: "status" }, { outcome: "status", next: "collect", state: "reviewing" }),
      step({ kind: "captureAll", verdict: "approve" }, { outcome: "approved", state: "approved", lenses: 4 }),
      step({ kind: "acknowledge" }, { outcome: "acknowledged", state: "burned" }),
    ],
  },
  {
    id: "explicit-lens-selection-narrows-review",
    description: "The agent names two pertinent lenses with a reason: the consent question and the review cover exactly those two instead of the four of the tier.",
    fixture: { change: "high" },
    steps: [
      step({ kind: "start", consent: "granted", lenses: ["risk", "readability"] }, { outcome: "consented", risk: "high", state: "reviewing", lenses: 2 }),
      step({ kind: "captureAll", verdict: "approve" }, { outcome: "approved", state: "approved", lenses: 2 }),
    ],
  },
  {
    id: "consent-declined-creates-no-review",
    description: "The human declines the review: nothing is created, no reviewer runs, and status stops offering the declined candidate.",
    fixture: { change: "medium" },
    steps: [
      step({ kind: "start", consent: "relay" }, { outcome: "consent_required", risk: "medium", state: "none" }),
      step({ kind: "answerConsent", answer: "declined" }, { outcome: "declined", risk: "medium", state: "declined" }),
      step({ kind: "inspect" }, { outcome: "inspected", mode: "off", lineages: 0 }),
      step({ kind: "status" }, { outcome: "status", next: "stop", state: "none" }),
    ],
  },
  {
    id: "consent-never-answered-implicitly",
    refId: "j13-next-transition-runs-verbatim",
    description: "Starting twice only relays the question twice: no lineage exists and status keeps offering the start until the human answers.",
    fixture: { change: "medium" },
    steps: [
      step({ kind: "start", consent: "relay" }, { outcome: "consent_required", risk: "medium", state: "none" }),
      step({ kind: "start", consent: "relay" }, { outcome: "consent_required", risk: "medium", state: "none" }),
      step({ kind: "inspect" }, { outcome: "inspected", mode: "off", lineages: 0 }),
      step({ kind: "status" }, { outcome: "status", next: "start", state: "none" }),
    ],
  },
  {
    id: "resume-after-consent",
    refId: "j126-selected-untracked-terminal-status-resumes-without-flags",
    description: "After consent a fresh process resumes the review by its lineage alone: the reviewers run, the review closes and is acknowledged in one run.",
    fixture: { change: "medium" },
    steps: [
      step({ kind: "start", consent: "granted" }, { outcome: "consented", risk: "medium", state: "reviewing", lenses: 1 }),
      step({ kind: "resume" }, { outcome: "closed", state: "burned", lenses: 1 }),
    ],
  },
];
