"""Differential: review/reviewer_model against v9 dist/review/reviewer-model.js through the oracle."""
import pytest

from lib.v9_oracle import needs_v9
from odd_claude.lib.profiles import PRESETS, Profile
from odd_claude.review.reviewer_model import profile_role_of, reviewer_route
from review.conftest import diff_cases

pytestmark = needs_v9

ROLES = ["lens", "refuter", "validator", "other", "", "\U0001f600", None, 5]
LENSES = ["risk", "resilience", "readability", "reliability", "toString", "constructor", "__proto__", "hasOwnProperty", "Risk", "risk ", "", "\U0001f600", None, 5, "mystery"]


def _profiles() -> list[dict]:
    out = [{"active": name, "routing": {k: v.stored() for k, v in PRESETS[name].items()}} for name in PRESETS]
    out += [{"active": "custom", "routing": {}}]
    out += [{"active": "custom", "routing": {"review-refuter": {"model": "gpt-9", "effort": "high"}, "review-validator": {"model": "opus"}, "odd-review-risk": {"model": "haiku", "effort": "max"}, "odd-review-resilience": {"model": "sonnet"}}}]
    out += [{"active": "custom", "routing": {"odd-review-risk": {"model": "Opus", "effort": "low"}, "odd-review-readability": {"model": "haiku"}, "odd-review-reliability": {"model": "opus", "effort": "xhigh"}}}]
    return out


def test_profile_role_of_matches_v9():
    diff_cases("review/reviewer-model", "profileRoleOf", profile_role_of, [[r, lens] for r in ROLES for lens in LENSES] + [[r] for r in ROLES])


def test_reviewer_route_matches_v9_over_presets_and_custom_profiles():
    calls = [[p, r, lens] for p in _profiles() for r in ("lens", "refuter", "validator", "other") for lens in LENSES]
    calls += [[p, r] for p in _profiles() for r in ("lens", "refuter", "validator")]
    diff_cases("review/reviewer-model", "reviewerRoute", lambda p, r, lens=None: reviewer_route(Profile.model_validate(p), r, lens), calls)
