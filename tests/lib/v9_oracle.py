"""Differential oracle: calls the compiled v9 lib (plugins/odd-claude/dist/lib/<module>.js) through node.

Args and results cross as ASCII-only JSON (`\\u` escapes both ways), so astral characters and lone surrogates
round-trip faithfully. Limit: `undefined`, NaN/Infinity and non-JSON values (Map, Date...) do not cross.
A thrown JS error comes back as `{"__error__": message}`; a promise result is awaited.
"""
import json
import shutil
import subprocess
from pathlib import Path
from typing import Any

import pytest

DIST_LIB = Path(__file__).resolve().parents[2] / "plugins" / "odd-claude" / "dist" / "lib"

needs_v9 = pytest.mark.skipif(shutil.which("node") is None or not DIST_LIB.is_dir(), reason="node or plugins/odd-claude/dist/lib missing")

_JS = r"""
const [url, fn, payload] = process.argv.slice(1);
const esc = (s) => s.replace(/[\u0080-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
const m = await import(url);
const out = [];
for (const args of JSON.parse(payload)) {
  try { out.push({ ok: await m[fn](...args) }); } catch (e) { out.push({ err: String(e && e.message !== undefined ? e.message : e) }); }
}
process.stdout.write(esc(JSON.stringify(out.map((r) => ("err" in r ? { __error__: r.err } : r.ok === undefined ? null : r.ok)))));
"""


def v9_many(module: str, fn: str, calls: list[list], env: dict | None = None, cwd: str | None = None) -> list[Any]:
    """Runs `module.fn(*args)` for each args list in one node process; returns the decoded results in order."""
    import os

    url = (DIST_LIB / f"{module}.js").as_uri()
    r = subprocess.run(
        ["node", "--input-type=module", "-e", _JS, url, fn, json.dumps(calls)],
        capture_output=True, text=True, encoding="ascii", env=None if env is None else {**os.environ, **env}, cwd=cwd, timeout=120,
    )
    if r.returncode != 0:
        raise RuntimeError(f"v9 oracle failed ({module}.{fn}): {r.stderr}")
    return json.loads(r.stdout)


def v9(module: str, fn: str, *args, env: dict | None = None, cwd: str | None = None) -> Any:
    """Runs `module.fn(*args)` on v9; result JSON-decoded, or `{"__error__": message}` if it threw."""
    return v9_many(module, fn, [list(args)], env=env, cwd=cwd)[0]
