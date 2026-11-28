"""Port of v9 review/reviewer-model.spec.ts (3 test() cases)."""
from odd_claude.lib.profiles import PRESETS, Profile, default_profile
from odd_claude.review.reviewer_model import profile_role_of, reviewer_route


def test_profile_role_of_maps_every_lens_the_refuter_and_the_validator_unknown_lenses_have_no_row():
    assert profile_role_of("lens", "risk") == "odd-review-risk"
    assert profile_role_of("lens", "resilience") == "odd-review-resilience"
    assert profile_role_of("lens", "readability") == "odd-review-readability"
    assert profile_role_of("lens", "reliability") == "odd-review-reliability"
    assert profile_role_of("refuter") == "review-refuter"
    assert profile_role_of("validator") == "review-validator"
    assert profile_role_of("lens", "toString") is None
    assert profile_role_of("lens") is None


def test_reviewer_route_under_balanced_risk_refuter_validator_opus_other_lenses_sonnet_all_medium():
    p = default_profile()
    assert reviewer_route(p, "lens", "risk") == {"model": "opus", "effort": "medium"}
    assert reviewer_route(p, "lens", "readability") == {"model": "sonnet", "effort": "medium"}
    assert reviewer_route(p, "refuter") == {"model": "opus", "effort": "medium"}
    assert reviewer_route(p, "validator") == {"model": "opus", "effort": "medium"}


def test_reviewer_route_haiku_carries_no_effort_missing_row_unknown_lens_or_unknown_model_gives_no_flag():
    economy = Profile(active="economy", routing={k: v.model_copy() for k, v in PRESETS["economy"].items()})
    assert reviewer_route(economy, "lens", "risk") == {"model": "haiku"}
    assert reviewer_route(economy, "validator") == {"model": "sonnet", "effort": "medium"}
    assert reviewer_route(economy, "lens", "mystery") == {}
    assert reviewer_route(Profile(active="custom", routing={}), "refuter") == {}
    weird = Profile.model_validate({"active": "custom", "routing": {"review-refuter": {"model": "gpt", "effort": "high"}, "review-validator": {"model": "opus"}}})
    assert reviewer_route(weird, "refuter") == {}
    assert reviewer_route(weird, "validator") == {"model": "opus"}
