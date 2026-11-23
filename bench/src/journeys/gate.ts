// RDD delivery check (PreToolUse: never blocks, at most one advisory notice), Stop reminder and the RDD mode switch. Delivery commands are presented to the gate as data only.
import type { JourneyDef } from "../journey.js";
import { step } from "./dsl.js";

// Journey ids keep their historical names (the committed baselines under docs/bench key rows by id); since the delivery check
// only warns, every gate step expects an allow.
const committedHigh = { change: "high", placement: "committed", origin: true } as const;

export const gateJourneys: JourneyDef[] = [
  {
    id: "gate-push-denied-unreviewed-high-risk",
    refId: "j05-gate-without-any-review",
    description: "With RDD on, pushing a committed high-risk range nobody reviewed is never blocked: the command runs (the hook only adds an advisory notice).",
    fixture: { ...committedHigh, rdd: "on" },
    steps: [step({ kind: "gateCheck", command: "push" }, { outcome: "allow", gate: "allow" })],
  },
  {
    id: "gate-push-allowed-after-receipt",
    description: "The push runs before the review (never blocked); the committed range is then reviewed with consent, approved and acknowledged, and the push still runs.",
    fixture: { ...committedHigh, rdd: "on" },
    steps: [
      step({ kind: "gateCheck", command: "push" }, { outcome: "allow", gate: "allow" }),
      step({ kind: "start", consent: "granted", target: "committed" }, { outcome: "consented", risk: "high", state: "reviewing", lenses: 4 }),
      step({ kind: "captureAll", verdict: "approve" }, { outcome: "approved", state: "approved", lenses: 4 }),
      step({ kind: "acknowledge" }, { outcome: "acknowledged", state: "burned" }),
      step({ kind: "gateCheck", command: "push" }, { outcome: "allow", gate: "allow" }),
    ],
  },
  {
    id: "gate-push-allowed-when-declined",
    description: "The push runs; the human then declines the review of the committed range, and the push still runs.",
    fixture: { ...committedHigh, rdd: "on" },
    steps: [
      step({ kind: "gateCheck", command: "push" }, { outcome: "allow", gate: "allow" }),
      step({ kind: "start", consent: "declined", target: "committed" }, { outcome: "declined", risk: "high", state: "declined" }),
      step({ kind: "gateCheck", command: "push" }, { outcome: "allow", gate: "allow" }),
    ],
  },
  {
    id: "gate-silent-with-rdd-off",
    description: "With RDD off the hook never blocks, even for an unreviewed high-risk range.",
    fixture: { ...committedHigh, rdd: "off" },
    steps: [step({ kind: "gateCheck", command: "push" }, { outcome: "allow", gate: "allow" })],
  },
  {
    id: "gate-push-allowed-for-medium-risk-range",
    description: "With RDD on, only a high-risk range is due: a committed medium-risk range is delivered without a review (and without a notice).",
    fixture: { change: "medium", placement: "committed", origin: true, rdd: "on" },
    steps: [step({ kind: "gateCheck", command: "push" }, { outcome: "allow", gate: "allow" })],
  },
  {
    id: "gate-pr-open-denied-unreviewed",
    description: "Opening a pull request for a committed high-risk range nobody reviewed is never blocked, like a push.",
    fixture: { ...committedHigh, rdd: "on" },
    steps: [step({ kind: "gateCheck", command: "prOpen" }, { outcome: "allow", gate: "allow" })],
  },
  {
    id: "gate-pr-open-allowed-after-receipt",
    description: "Opening the pull request runs before and after the committed range is reviewed, approved and acknowledged.",
    fixture: { ...committedHigh, rdd: "on" },
    steps: [
      step({ kind: "gateCheck", command: "prOpen" }, { outcome: "allow", gate: "allow" }),
      step({ kind: "start", consent: "granted", target: "committed" }, { outcome: "consented", risk: "high", state: "reviewing", lenses: 4 }),
      step({ kind: "captureAll", verdict: "approve" }, { outcome: "approved", state: "approved", lenses: 4 }),
      step({ kind: "acknowledge" }, { outcome: "acknowledged", state: "burned" }),
      step({ kind: "gateCheck", command: "prOpen" }, { outcome: "allow", gate: "allow" }),
    ],
  },
  {
    id: "workspace-review-does-not-authorize-committed-range",
    description: "Reviewing a different working-tree change does not review the committed range, and the push runs regardless (never blocked).",
    fixture: { ...committedHigh, extraWorkspace: true, rdd: "on" },
    steps: [
      step({ kind: "start", consent: "granted" }, { outcome: "consented", risk: "high", state: "reviewing", lenses: 4 }),
      step({ kind: "captureAll", verdict: "approve" }, { outcome: "approved", state: "approved", lenses: 4 }),
      step({ kind: "acknowledge" }, { outcome: "acknowledged", state: "burned" }),
      step({ kind: "gateCheck", command: "push" }, { outcome: "allow", gate: "allow" }),
    ],
  },
  {
    id: "stop-reminds-once-per-session-and-candidate",
    refId: "j125-claude-code-stop-hook-reminds-once-per-candidate",
    description: "With RDD on, the Stop event reminds once for an unreviewed high-risk candidate; a repeat is silent until the candidate changes.",
    fixture: { change: "high", rdd: "on" },
    steps: [
      step({ kind: "stopHook" }, { outcome: "remind" }),
      step({ kind: "stopHook" }, { outcome: "silent" }),
      step({ kind: "correct", edit: "drift" }, { outcome: "edited" }),
      step({ kind: "stopHook" }, { outcome: "remind" }),
      step({ kind: "stopHook", session: "bench-other-session" }, { outcome: "remind" }),
    ],
  },
  {
    id: "stop-silent-with-rdd-off",
    description: "With RDD off the Stop event never reminds, even for an unreviewed high-risk candidate.",
    fixture: { change: "high", rdd: "off" },
    steps: [step({ kind: "stopHook" }, { outcome: "silent" })],
  },
  {
    id: "rdd-mode-global-and-clone-scopes",
    refId: "j119-global-review-mode-status-reports-persisted-source",
    description: "RDD is switched on user-wide, switched off for this repository only (an off wins), then the repository opinion is cleared so the user-wide switch decides again.",
    fixture: { change: "none" },
    steps: [
      step({ kind: "modeSet", mode: "on", scope: "global" }, { outcome: "mode_set", mode: "on" }),
      step({ kind: "modeSet", mode: "off", scope: "clone" }, { outcome: "mode_set", mode: "off" }),
      step({ kind: "inspect" }, { outcome: "inspected", mode: "off", lineages: 0 }),
      step({ kind: "modeSet", mode: "on", scope: "clone" }, { outcome: "mode_set", mode: "on" }),
      step({ kind: "inspect" }, { outcome: "inspected", mode: "on", lineages: 0 }),
    ],
  },
];
