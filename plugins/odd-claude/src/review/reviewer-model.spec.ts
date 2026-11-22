import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultProfile, PRESETS, type Profile } from "../lib/profiles.js";
import { profileRoleOf, reviewerRoute } from "./reviewer-model.js";

test("profileRoleOf maps every lens, the refuter and the validator; unknown lenses have no row", () => {
  assert.equal(profileRoleOf("lens", "risk"), "odd-review-risk");
  assert.equal(profileRoleOf("lens", "resilience"), "odd-review-resilience");
  assert.equal(profileRoleOf("lens", "readability"), "odd-review-readability");
  assert.equal(profileRoleOf("lens", "reliability"), "odd-review-reliability");
  assert.equal(profileRoleOf("refuter"), "review-refuter");
  assert.equal(profileRoleOf("validator"), "review-validator");
  assert.equal(profileRoleOf("lens", "toString"), undefined);
  assert.equal(profileRoleOf("lens"), undefined);
});

test("reviewerRoute under balanced: risk/refuter/validator opus, other lenses sonnet, all medium", () => {
  const p = defaultProfile();
  assert.deepEqual(reviewerRoute(p, "lens", "risk"), { model: "opus", effort: "medium" });
  assert.deepEqual(reviewerRoute(p, "lens", "readability"), { model: "sonnet", effort: "medium" });
  assert.deepEqual(reviewerRoute(p, "refuter"), { model: "opus", effort: "medium" });
  assert.deepEqual(reviewerRoute(p, "validator"), { model: "opus", effort: "medium" });
});

test("reviewerRoute: haiku carries no effort; a missing row, an unknown lens or an unknown model gives no flag", () => {
  const economy: Profile = { active: "economy", routing: structuredClone(PRESETS.economy) };
  assert.deepEqual(reviewerRoute(economy, "lens", "risk"), { model: "haiku" });
  assert.deepEqual(reviewerRoute(economy, "validator"), { model: "sonnet", effort: "medium" });
  assert.deepEqual(reviewerRoute(economy, "lens", "mystery"), {});
  assert.deepEqual(reviewerRoute({ active: "custom", routing: {} }, "refuter"), {});
  assert.deepEqual(reviewerRoute({ active: "custom", routing: { "review-refuter": { model: "gpt-9", effort: "high" } } }, "refuter"), {});
  assert.deepEqual(reviewerRoute({ active: "custom", routing: { "review-refuter": { model: "opus" } } }, "refuter"), { model: "opus" });
});
