"""`python -m odd_claude.cli.review_mode <enable|disable|status> [--scope global|clone] [--cwd <repo>] [--data-dir <dir>] [--json]`
(port of v9 cli/review-mode.ts). The RDD mode switch (U13). Review-driven development is OFF until enabled. `global` (default) is the
user-wide switch kept in plugin state; `clone` is an off-only override for one repository under <git-common-dir>/odd-plugin. `status` is
read-only. Exit codes: 0 ok; 1 the switch could not be written; 2 usage error.

The usage line keeps v9's text (`review-mode.js ...`): it is the contract this CLI answers to."""
import os
import sys
from typing import Mapping

from ..lib.js import js_stringify
from ..lib.system import CliResult, env_with_data_dir, run_main
from ..review.mode import MODE_SCHEMA, ModeOptions, ReviewModeError, read_review_mode, set_review_mode

USAGE = "usage: review-mode.js <enable|disable|status> [--scope global|clone] [--cwd <repo>] [--data-dir <dir>] [--json]"
VERBS = ("enable", "disable", "status")


def _usage_error(message: str) -> CliResult:
    return CliResult(2, "", f"error: {message}\n{USAGE}")


def _render(s: dict, note: bool) -> str:
    lines = [
        f"review-driven development: {s['effective']} (decided by {s['source']})",
        f"  global:      {s['global']}",
        f"  clone-local: {s['cloneLocal']}",
        *[f"  problem:     {p}" for p in s["problems"]],
    ]
    if note:
        lines.append("  note:        a clone-local override can only disable, so this cleared the clone's off opinion and the global switch still decides; run `review-mode.js enable` (global scope) to turn it on")
    return "\n".join(lines)


def _json_string(v: str) -> str:
    return js_stringify(v)


def review_mode_cli(argv: list[str], env: Mapping[str, str | None], cwd: str | None = None) -> CliResult:
    verb: str | None = None
    scope: str | None = None
    repo: str | None = None
    as_json = False
    i = 0
    while i < len(argv):
        a = argv[i]
        if a in ("--scope", "--cwd", "--data-dir"):
            v = argv[i + 1] if i + 1 < len(argv) else None
            if v is None or v == "" or v.startswith("--"):
                return _usage_error(f"{a} needs a value")
            if a == "--scope":
                scope = v
            elif a == "--cwd":
                repo = v
            i += 1
        elif a == "--json":
            as_json = True
        elif a.startswith("--"):
            return _usage_error(f"unknown argument {a}")
        elif verb is None:
            verb = a
        else:
            return _usage_error(f"unexpected argument {a}")
        i += 1
    if verb is None or verb not in VERBS:
        return _usage_error("a verb is required" if verb is None else f"unknown verb {_json_string(verb)}")
    if scope is not None and scope != "global" and scope != "clone":
        return _usage_error(f"unknown scope {_json_string(scope)}")
    if verb == "status" and scope is not None:
        return _usage_error("status reads both scopes; do not pass --scope")
    opts = ModeOptions(env=env_with_data_dir(argv, env))
    where = repo if repo is not None else (os.getcwd() if cwd is None else cwd)
    try:
        if verb == "status":
            s = read_review_mode(where, opts)
            text = js_stringify({"schema": MODE_SCHEMA, "operation": "status", "scope": "both", "status": s}) if as_json else _render(s, False)
            return CliResult(0, text, "")
        chosen = "clone" if scope == "clone" else "global"
        s = set_review_mode(verb, chosen, where, opts)
        note = verb == "enable" and chosen == "clone" and s["effective"] == "off" and s["source"] == "global"
        text = js_stringify({"schema": MODE_SCHEMA, "operation": verb, "scope": chosen, "status": s}) if as_json else _render(s, note)
        return CliResult(0, text, "")
    except ReviewModeError as err:
        return CliResult(1, "", f"error: {err}")


def main() -> CliResult:
    return review_mode_cli(sys.argv[1:], os.environ)


if __name__ == "__main__":
    sys.exit(run_main(__name__, main))
