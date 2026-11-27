"""Model profiles (port of v9 lib/profiles.ts). Plugin state `profiles` maps each odd-claude agent to {model, effort};
`balanced` is the default (absent, corrupt or unknown state reads as it); `clear` returns to it."""
from typing import Any

from pydantic import BaseModel

from .background_subagents import js_stringify as _js
from .state import StateOptions, read_plugin_state, write_plugin_state

#: Agents the profile routes, i.e. every agent file shipped in agents/.
PROFILE_ROLES = (
    "odd-explore", "odd-verify", "odd-plan-check", "odd-worker", "odd-jd-fix", "odd-jd-judge-a", "odd-jd-judge-b",
    "odd-review-readability", "odd-review-reliability", "odd-review-resilience", "odd-review-risk",
)  # fmt: skip
#: Aliases the Agent tool's `model` parameter accepts.
PROFILE_MODELS = ("haiku", "sonnet", "opus")
PROFILE_EFFORTS = ("low", "medium", "high", "xhigh", "max")
#: Routable roles that are not agent files: the RDD native review's refuter and targeted validator.
NATIVE_REVIEW_ROLES = ("review-refuter", "review-validator")
PRESET_NAMES = ("balanced", "economy", "max")
CUSTOM_PROFILE = "custom"
DEFAULT_PROFILE = "balanced"
_ALL_ROLES = (*PROFILE_ROLES, *NATIVE_REVIEW_ROLES)


class RoleRoute(BaseModel):
    model: str
    effort: str | None = None

    def stored(self) -> dict[str, str]:
        return self.model_dump(exclude_none=True)


Routing = dict[str, RoleRoute]


class Profile(BaseModel):
    active: str
    routing: Routing


def _r(model: str, effort: str) -> RoleRoute:
    return RoleRoute(model=model, effort=effort)


def _reviews(model: str, effort: str) -> Routing:
    return {f"odd-review-{x}": _r(model, effort) for x in ("readability", "reliability", "resilience", "risk")}


def _natives(model: str, effort: str) -> Routing:
    return {"review-refuter": _r(model, effort), "review-validator": _r(model, effort)}


#: `balanced` is the user's table (all effort medium) and the default; economy/max mirror their judges for the native roles.
PRESETS: dict[str, Routing] = {
    "balanced": {
        "odd-explore": _r("haiku", "medium"),
        "odd-worker": _r("sonnet", "medium"),
        "odd-verify": _r("opus", "medium"),
        "odd-plan-check": _r("sonnet", "medium"),
        "odd-jd-fix": _r("sonnet", "medium"),
        "odd-jd-judge-a": _r("opus", "medium"),
        "odd-jd-judge-b": _r("sonnet", "medium"),
        **_reviews("sonnet", "medium"),
        "odd-review-risk": _r("opus", "medium"),
        **_natives("opus", "medium"),
    },
    "economy": {
        "odd-explore": _r("haiku", "low"),
        "odd-worker": _r("sonnet", "low"),
        "odd-verify": _r("haiku", "medium"),
        "odd-plan-check": _r("haiku", "medium"),
        "odd-jd-fix": _r("sonnet", "low"),
        "odd-jd-judge-a": _r("sonnet", "medium"),
        "odd-jd-judge-b": _r("sonnet", "medium"),
        **_reviews("haiku", "medium"),
        **_natives("sonnet", "medium"),
    },
    "max": {
        "odd-explore": _r("haiku", "medium"),
        "odd-worker": _r("opus", "high"),
        "odd-verify": _r("opus", "high"),
        "odd-plan-check": _r("opus", "high"),
        "odd-jd-fix": _r("opus", "high"),
        "odd-jd-judge-a": _r("opus", "xhigh"),
        "odd-jd-judge-b": _r("opus", "xhigh"),
        **_reviews("opus", "high"),
        **_natives("opus", "xhigh"),
    },
}


def _has(values: tuple[str, ...], v: Any) -> bool:
    return isinstance(v, str) and v in values


def _copy(routing: Routing) -> Routing:
    return {k: v.model_copy() for k, v in routing.items()}


def _store(active: str, routing: Routing, opts: StateOptions | None) -> None:
    write_plugin_state("profiles", {"active": active, "routing": {k: v.stored() for k, v in routing.items()}}, opts)


def default_profile() -> Profile:
    """The default profile: a fresh copy of `balanced`."""
    return Profile(active=DEFAULT_PROFILE, routing=_copy(PRESETS[DEFAULT_PROFILE]))


def read_profile(opts: StateOptions | None = None) -> Profile:
    """Plugin state `profiles`. Absent, corrupt, tampered or unknown state reads as `balanced`. A valid chosen profile wins:
    unknown entries are dropped and a missing or invalid role is filled from the chosen preset (balanced for custom)."""
    try:
        raw = read_plugin_state("profiles", opts)
        active = raw.get("active")
        if not _has((*PRESET_NAMES, CUSTOM_PROFILE), active):
            return default_profile()
        base = PRESETS[DEFAULT_PROFILE if active == CUSTOM_PROFILE else active]
        stored = raw.get("routing")
        routing: Routing = {}
        for role in _ALL_ROLES:
            e = stored.get(role) if isinstance(stored, dict) else None
            if isinstance(e, dict) and _has(PROFILE_MODELS, e.get("model")):
                effort = e.get("effort")
                routing[role] = RoleRoute(model=e["model"], effort=effort if _has(PROFILE_EFFORTS, effort) else None)
            else:
                routing[role] = base[role].model_copy()
        return Profile(active=active, routing=routing)
    except Exception:
        return default_profile()


def use_profile(name: str, opts: StateOptions | None = None) -> Profile:
    """Activates a preset. Raises on any other name without touching the stored profile."""
    if not _has(PRESET_NAMES, name):
        raise ValueError(f"invalid profile {_js(name)}; available profiles: {', '.join(PRESET_NAMES)}")
    routing = _copy(PRESETS[name])
    _store(name, routing, opts)
    return Profile(active=name, routing=routing)


def set_role(role: str, model: str, effort: str | None = None, opts: StateOptions | None = None) -> Profile:
    """Changes one role (starting from the active profile) and marks the result `custom`. Validates before writing."""
    if not _has(PROFILE_ROLES, role):
        raise ValueError(f"invalid role {_js(role)}; available roles: {', '.join(PROFILE_ROLES)}")
    if not _has(PROFILE_MODELS, model):
        raise ValueError(f"invalid model {_js(model)}; available models: {', '.join(PROFILE_MODELS)}")
    if effort is not None and not _has(PROFILE_EFFORTS, effort):
        raise ValueError(f"invalid effort {_js(effort)}; available efforts: {', '.join(PROFILE_EFFORTS)}")
    routing = {**read_profile(opts).routing, role: RoleRoute(model=model, effort=effort)}
    _store(CUSTOM_PROFILE, routing, opts)
    return Profile(active=CUSTOM_PROFILE, routing=routing)


def clear_profile(opts: StateOptions | None = None) -> None:
    """Back to the default profile (balanced)."""
    write_plugin_state("profiles", {}, opts)


def profile_context_line(opts: StateOptions | None = None) -> str:
    """SessionStart context line (the only routing); always present (balanced by default), agent-file roles only."""
    p = read_profile(opts)
    entries = ", ".join(f"{role}={p.routing[role].model}" for role in PROFILE_ROLES if role in p.routing)
    default = " (default)" if p.active == DEFAULT_PROFILE else ""
    return (
        f"Model profile: {p.active}{default}. When you call the Agent tool for one of these odd-claude agents, pass the `model` "
        f"parameter shown (the agent's own frontmatter model is only the default): {entries}. `/odd-profiles` shows or changes it."
    )


def render_profiles(p: Profile) -> str:
    roles = [r for r in _ALL_ROLES if r in p.routing]
    width = max(len(x) for x in roles) + 2
    rows = [f"{r.ljust(width)}{p.routing[r].model.ljust(8)}{p.routing[r].effort or '-'}" for r in roles]
    return "\n".join([f"active: {p.active}", f"{'ROLE'.ljust(width)}{'MODEL'.ljust(8)}EFFORT", *rows])


def render_preset_list(active: str) -> str:
    def row(n: str) -> str:
        t = PRESETS[n]
        return (
            f"{'*' if n == active else ' '} {n.ljust(9)} explore={t['odd-explore'].model} worker={t['odd-worker'].model} "
            f"verify={t['odd-verify'].model} judges={t['odd-jd-judge-a'].model}/{t['odd-jd-judge-b'].model}"
            f"{' (default)' if n == DEFAULT_PROFILE else ''}"
        )

    return "\n".join(row(n) for n in PRESET_NAMES) + ("\n* custom" if active == CUSTOM_PROFILE else "")
