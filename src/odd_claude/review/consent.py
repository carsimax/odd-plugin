"""Consent v3 envelope and candidate-scoped decline records (port of v9 review/consent.ts; its header holds the rationale).

The envelope is a blocking question for ONE frozen candidate: nothing is persisted when it is returned. A decline is recorded as a
tiny atomic file under `<git-common-dir>/odd-plugin/declines/<target hash>.json`, scoped to that candidate only.

Port differences: records and the envelope are plain dicts in v9's JSON shape (the input keys are v9's camelCase: `cwd`,
`targetIdentity`, `projection`, `riskLevel`, `changedFiles`, `changedLines`, `riskEvidence`, `targetArgs`, optional `agent`,
`lenses` = `{"names", "reason"}`, `locale`); the plugin root is `lib/root.py`'s. `RangeError` is the v9 `RangeError` for a malformed identity.
"""
import os
import re
from typing import Any, Mapping

from ..lib.js import js_json_loads
from ..lib.root import odd_claude_root
from ._paths import js_join, mkdirp
from .canonical import canonical_json, domain_hash

REVIEW_CONTRACT = "odd-claude.review-integration/v2"
CONSENT_SCHEMA = "odd-claude.review-integration.consent/v3"
DECLINE_SCHEMA = "odd-claude.review-decline/v1"

REVIEW_TOOL_NAMES = (
    "review_assess", "review_inspect", "review_start", "review_status", "review_answer_consent", "review_capture", "review_capture_group",
    "review_acknowledge_approved", "review_complete", "review_run",
)

_VERB_TOOL = {
    "start": "review_start", "capture": "review_capture", "capture-group": "review_capture_group", "run": "review_run",
    "complete": "review_complete", "acknowledge-approved": "review_acknowledge_approved",
}


def review_command(verb: str) -> str:
    """The tool a status transition verb (`execute.command`) names."""
    return _VERB_TOOL[verb]


#: What a consent choice calls (the human's answer is the trailing `--consent granted|declined`).
INVOCATION_PREFIX = "review_answer_consent"


class RangeError(ValueError):
    pass


def plugin_root_dir(env: Mapping[str, str | None] | None = None) -> str:
    return odd_claude_root(env)


def off_path_command(env: Mapping[str, str | None] | None = None) -> str:
    """The real off switch (user-wide)."""
    return f"node {shell_quote(js_join(plugin_root_dir(env), 'dist', 'cli', 'review-mode.js'))} disable"


_SAFE_RE = re.compile(r"[A-Za-z0-9_@%+=:,./-]+", re.ASCII)
_SHA_RE = re.compile(r"sha256:([0-9a-f]{64})")
_ES_RE = re.compile(r"es(?:[-_]|\Z)", re.ASCII | re.IGNORECASE)

_TEXT = {
    "en": {
        "headline": "A review can check this change before you call it done.",
        "reason": "Review can help detect execution issues in these changes.",
        "value": "Reviewing takes a little longer and makes the result safer.",
        "grantedLabel": "Review this change",
        "grantedEffect": "Reviews only this change; later medium- or high-risk changes ask again, and delivery needs separate approval.",
        "declinedLabel": "Skip this time",
        "declinedEffect": "Skips only this change; no review record is created, and future reviews stay enabled.",
        "offPath": lambda c: f"To turn reviews off for good, run '{c}'.",
    },
    "es": {
        "headline": "Una revisión puede comprobar este cambio antes de darlo por terminado.",
        "reason": "La revisión puede ayudar a detectar problemas de ejecución en estos cambios.",
        "value": "Revisar tarda un poco más y hace el resultado más seguro.",
        "grantedLabel": "Revisar este cambio",
        "grantedEffect": "Revisa solo este cambio; los cambios posteriores de riesgo medio o alto preguntan de nuevo, y la entrega necesita aprobación aparte.",
        "declinedLabel": "Omitir esta vez",
        "declinedEffect": "Omite solo este cambio; no se crea ningún registro de revisión y las revisiones futuras siguen activas.",
        "offPath": lambda c: f"Para desactivar las revisiones de forma permanente, ejecuta '{c}'.",
    },
}


def shell_quote(value: str) -> str:
    """POSIX single-quote escaping, so every value survives a shell untouched."""
    return value if _SAFE_RE.fullmatch(value) else "'" + value.replace("'", "'\\''") + "'"


def consent_binding(target_identity: str, lenses: Mapping[str, Any] | None = None) -> str:
    """What the human's answer is bound to: the candidate and the lens selection the question showed (lens names compared without `review-`)."""
    return domain_hash("consent-binding", 1, {
        "target_identity": target_identity,
        "lenses": None if lenses is None else [re.sub(r"^review-", "", n) for n in lenses["names"]],
        "lenses_reason": None if lenses is None else lenses["reason"],
    })


def build_consent_envelope(input: Mapping[str, Any]) -> dict:
    locale = input.get("locale")
    lenses = input.get("lenses")
    target_args = input["targetArgs"]
    t = _TEXT["es" if locale is not None and _ES_RE.match(locale) else "en"]
    base = " ".join([
        INVOCATION_PREFIX, "--contract", REVIEW_CONTRACT, "--cwd", shell_quote(input["cwd"]), "--target-identity", input["targetIdentity"], *target_args,
        # projection is a property of current-changes only (a base-diff candidate has none)
        *([] if "base-diff" in target_args else ["--projection", input["projection"]]),
        *(["--lenses", shell_quote(",".join(lenses["names"])), "--lenses-reason", shell_quote(lenses["reason"])] if lenses is not None else []),
        *(["--locale", shell_quote(locale)] if locale is not None else []),
        "--consent-binding", consent_binding(input["targetIdentity"], lenses),
    ])
    return {
        "schema": CONSENT_SCHEMA, "contract": REVIEW_CONTRACT, "operation": "review.start", "action": "consent_required",
        "agent": "claude-code" if input.get("agent") is None else input["agent"], "blocking": True, "target_identity": input["targetIdentity"], "projection": input["projection"],
        "risk_level": input["riskLevel"], "changed_files": input["changedFiles"], "changed_lines": input["changedLines"],
        "headline": t["headline"], "reason": t["reason"], "value": t["value"], "risk_evidence": list(input["riskEvidence"]),
        "choices": [
            {"answer": "granted", "label": t["grantedLabel"], "effect": t["grantedEffect"], "invocation": f"{base} --consent granted"},
            {"answer": "declined", "label": t["declinedLabel"], "effect": t["declinedEffect"], "invocation": f"{base} --consent declined"},
        ],
        "off_path": {"note": t["offPath"](off_path_command()), "command": off_path_command()},
    }


# ---- candidate-scoped decline records ----


def declines_dir_for(common_dir: str) -> str:
    return js_join(common_dir, "odd-plugin", "declines")


def decline_path_for(common_dir: str, target_identity: str) -> str:
    m = _SHA_RE.fullmatch(target_identity) if isinstance(target_identity, str) else None
    if not m:
        raise RangeError("target identity must be sha256:<64 hex>")
    return js_join(declines_dir_for(common_dir), f"{m.group(1)}.json")


def _ensure_declines_dir(common_dir: str) -> None:
    mkdirp(js_join(common_dir, "odd-plugin"), 0o700)
    d = declines_dir_for(common_dir)
    mkdirp(d, 0o700)
    if not os.path.isdir(d) or os.path.islink(d):
        raise OSError(f"declines path is not a real directory: {d}")


def record_decline(common_dir: str, record: Mapping[str, Any]) -> dict:
    """Atomically records a decline for one candidate. The first record wins: re-declining leaves it untouched."""
    import time

    path = decline_path_for(common_dir, record["target_identity"])
    _ensure_declines_dir(common_dir)
    tmp = f"{path}.{os.getpid()}.{int(time.time() * 1000)}.tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write((canonical_json({"schema": DECLINE_SCHEMA, **record}) + "\n").encode("utf-8"))
        try:
            os.link(tmp, path)  # create-only and atomic: EEXIST means another record already won
            return {"path": path, "created": True}
        except FileExistsError:
            if read_decline(common_dir, record["target_identity"]):
                return {"path": path, "created": False}
            os.rename(tmp, path)  # the existing file is malformed (reads as absent): the first VALID record replaces it atomically
            return {"path": path, "created": True}
    finally:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass


def read_decline(common_dir: str, target_identity: str) -> dict | None:
    """The decline recorded for this exact candidate, or None. A malformed file reads as absent."""
    path = decline_path_for(common_dir, target_identity)
    try:
        if not os.path.isfile(path) or os.path.islink(path):
            return None
        with open(path, encoding="utf-8", errors="replace") as f:
            raw = f.read()
    except OSError:
        return None
    try:
        v = js_json_loads(raw)
    except (ValueError, RecursionError):
        return None
    return v if isinstance(v, dict) and v.get("schema") == DECLINE_SCHEMA and v.get("target_identity") == target_identity else None
