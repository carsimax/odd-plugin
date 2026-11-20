import type { JourneyStepDef, NormalizedFacts, StepSpec } from "../journey.js";

/** One step with the normalized facts it must produce. */
export const step = (action: StepSpec, expect: NormalizedFacts): JourneyStepDef => ({ do: action, expect });
