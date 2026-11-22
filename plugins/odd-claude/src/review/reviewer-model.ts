// Reviewer model routing (balanced profile, S3): which `--model` / `--effort` a reviewer child gets when the caller passed no
// explicit model. The role of the child maps to a profile route: lens risk/resilience/readability/reliability ->
// `odd-review-<lens>`, refuter -> `review-refuter`, targeted validator -> `review-validator`. An unknown lens or a route the
// runner does not know yields no flag (Claude's own default model), as before. An explicit caller model always wins and is
// handled by the caller (run.ts); this module only turns a profile into per-role runner options.
import type { Profile } from "../lib/profiles.js";
import type { ReviewerRole, RunReviewerOptions } from "./runner.js";

const LENS_ROLES: Readonly<Record<string, string>> = {
  risk: "odd-review-risk",
  resilience: "odd-review-resilience",
  readability: "odd-review-readability",
  reliability: "odd-review-reliability",
};
const FAMILIES: readonly string[] = ["haiku", "sonnet", "opus"];

/** Profile role name of a reviewer child, or undefined when the profile has no row for it. */
export function profileRoleOf(role: ReviewerRole, lens?: string): string | undefined {
  if (role === "refuter") return "review-refuter";
  if (role === "validator") return "review-validator";
  return lens !== undefined && Object.hasOwn(LENS_ROLES, lens) ? LENS_ROLES[lens] : undefined;
}

/** Runner model/effort of a reviewer child under `profile`; `{}` (no flag) when unrouted. haiku never carries an effort. */
export function reviewerRoute(profile: Profile, role: ReviewerRole, lens?: string): Pick<RunReviewerOptions, "model" | "effort"> {
  const name = profileRoleOf(role, lens);
  const route = name === undefined ? undefined : profile.routing[name];
  if (route === undefined || !FAMILIES.includes(route.model)) return {};
  return route.model === "haiku" || route.effort === undefined ? { model: route.model } : { model: route.model, effort: route.effort };
}
