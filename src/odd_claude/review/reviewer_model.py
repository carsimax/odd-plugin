"""Reviewer model routing, balanced profile (port of v9 review/reviewer-model.ts): which `model` / `effort` a reviewer child
gets when the caller passed no explicit model. lens risk/resilience/readability/reliability -> `odd-review-<lens>`, refuter ->
`review-refuter`, targeted validator -> `review-validator`. An unknown lens or a route the runner does not know yields no flag
(Claude's own default model). An explicit caller model always wins and is handled by the caller (run).
Public API: `profile_role_of`, `reviewer_route`. A role is "lens" | "refuter" | "validator".
"""
from ..lib.profiles import Profile

_LENS_ROLES = {
    "risk": "odd-review-risk",
    "resilience": "odd-review-resilience",
    "readability": "odd-review-readability",
    "reliability": "odd-review-reliability",
}
_FAMILIES = ("haiku", "sonnet", "opus")


def profile_role_of(role: str, lens: str | None = None) -> str | None:
    """Profile role name of a reviewer child, or None when the profile has no row for it."""
    if role == "refuter":
        return "review-refuter"
    if role == "validator":
        return "review-validator"
    return _LENS_ROLES[lens] if lens is not None and lens in _LENS_ROLES else None


def reviewer_route(profile: Profile, role: str, lens: str | None = None) -> dict[str, str]:
    """Runner model/effort of a reviewer child under `profile`; `{}` (no flag) when unrouted. haiku never carries an effort."""
    name = profile_role_of(role, lens)
    route = None if name is None else profile.routing.get(name)
    if route is None or route.model not in _FAMILIES:
        return {}
    return {"model": route.model} if route.model == "haiku" or route.effort is None else {"model": route.model, "effort": route.effort}
