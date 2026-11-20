import { toJourney, type Journey, type JourneyDef, type Subject } from "../journey.js";
import { correctionJourneys } from "./correction.js";
import { gateJourneys } from "./gate.js";
import { lifecycleJourneys } from "./lifecycle.js";

/** Every journey as subject-neutral data. The same definitions run against odd and, in T3, against the upstream oracle. */
export const JOURNEY_DEFS: readonly JourneyDef[] = [...lifecycleJourneys, ...correctionJourneys, ...gateJourneys];

/** The journeys bound to a subject, ready for `runJourney`. */
export const journeysFor = (subject: Subject): Journey[] => JOURNEY_DEFS.map((d) => toJourney(d, subject));
