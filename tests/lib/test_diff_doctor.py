"""Differential test: Python lib/doctor.py against the compiled v9 lib/doctor.js.

By design (S5) v9 checks `node` (item id `node`, >= 22) and Python checks `python` and `uv`: those runtime items are the only
intended difference. Every other item, the report shape and `renderDoctor` are compared on the same inputs. `nodeSatisfies` /
`python_satisfies` and the runtime-item `missing`/`requiredMissing` entries are skipped for that reason.
"""
import json
import subprocess

from odd_claude.lib import doctor as d

from .v9_oracle import DIST_LIB, needs_v9, v9_many

pytestmark = needs_v9

RUNTIME_IDS = {"node", "python", "uv"}
_JS = r"""
const [url, payload] = process.argv.slice(1);
const esc = (s) => s.replace(/[\u0080-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
const m = await import(url);
const out = JSON.parse(payload).map((c) => {
  const table = c.exec;
  const deps = {
    nodeVersion: c.runtime,
    exec: (cmd, args) => { const k = [cmd, ...args].join(" "); return Object.hasOwn(table, k) ? table[k] ?? undefined : undefined; },
    env: c.env, version: c.version,
    installedPlugins: () => c.plugins ?? undefined, installedVersion: () => c.installed ?? undefined, hooksInstalled: () => c.hooks ?? undefined,
    isWritable: (p) => p.endsWith("w"),
  };
  return m.collectDoctor(deps);
});
process.stdout.write(esc(JSON.stringify(out)));
"""

VERSION_TEXTS = [
    "1.2.3", "v1.2.3", "git version 2.43.0", "engram 0.9.12-beta", "1.2", "1", "", "no digits", "1.2.3.4", "a1.2.3b", " 4.5.6 ", "1.2.x 3.4.5", "10.20.30\n", "\n7.8.9",
    "١.٢.٣", "1.٢.3", "１.２.３", "\U0001f600 1.2.3 \U0001f600", "\ud800 1.2.3", "9" * 400 + ".1.1", "0.0.0", "00.01.02", "1..2.3", "1.2.3 ",
    " 1.2.3﻿", "x" * 5000 + "1.2.3",
]


def v9_collect(cases: list[dict]) -> list[dict]:
    r = subprocess.run(
        ["node", "--input-type=module", "-e", _JS, (DIST_LIB / "doctor.js").as_uri(), json.dumps(cases)],
        capture_output=True, text=True, encoding="ascii", timeout=120,
    )
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout)


def py_collect(c: dict) -> dict:
    table = c["exec"]
    plugins = c["plugins"]
    deps = d.DoctorDeps(
        exec=lambda cmd, args: table.get(" ".join([cmd, *args])),
        env=c["env"],
        python_version="3.14.0",
        version=c["version"],
        installed_plugins=lambda: plugins,
        installed_version=lambda: c["installed"],
        hooks_installed=lambda: c["hooks"],
        is_writable=lambda p: p.endswith("w"),
    )
    return d.collect_doctor(deps).to_json_dict()


def comparable(report: dict) -> dict:
    """Drops the intended runtime items (node | python, uv) and their entries in the summary lists; recomputes nothing else."""
    out = dict(report)
    out["items"] = [i for i in report["items"] if i["id"] not in RUNTIME_IDS]
    out["missing"] = [i for i in report["missing"] if i not in RUNTIME_IDS]
    out["requiredMissing"] = [i for i in report["requiredMissing"] if i not in RUNTIME_IDS]
    out.pop("ok")
    return out


def base(**kw) -> dict:
    c = {"runtime": "v22.0.0", "exec": {"uv --version": "uv 0.5.1", "git --version": "git version 2.43.0", "engram version": "engram 1.2.3", "codegraph --version": "0.4.5"},
         "env": {"ODD_CLAUDE_DATA": "/tmp/data-w"}, "version": "1.0.0", "plugins": ["engram@market"], "installed": "1.0.0", "hooks": True}
    c.update(kw)
    return c


def cases() -> list[dict]:
    out = [base()]
    for k in ("git --version", "engram version", "codegraph --version", "uv --version"):
        out.append(base(exec={**base()["exec"], k: None}))
        out.append(base(exec={x: v for x, v in base()["exec"].items() if x != k}))
        for t in VERSION_TEXTS:
            out.append(base(exec={**base()["exec"], k: t}))
    out.append(base(exec={}))
    for pl in (None, [], ["engram"], ["engram@x"], ["engramx"], ["xengram@x"], ["other", "engram@y"], ["Engram@x"], ["engram@"], ["\U0001f600", "engram\U0001f600"], ["engram @x"], [""]):
        out.append(base(plugins=pl))
        out.append(base(plugins=pl, exec={**base()["exec"], "engram version": None}))
    for inst in (None, "", "1.0.0", "\U0001f600", "x" * 3000, "\ud800", "0 (0)", " "):
        out.append(base(installed=inst))
    for h in (None, True, False):
        out.append(base(hooks=h))
    for env in ({}, {"ODD_CLAUDE_DATA": ""}, {"ODD_CLAUDE_DATA": "/x/w"}, {"ODD_CLAUDE_DATA": "/x/nw"}, {"ODD_CLAUDE_DATA": "/\U0001f600/w"}, {"ODD_CLAUDE_DATA": " w"},
                {"CLAUDE_PLUGIN_DATA": "/legacy/w"}, {"CLAUDE_PLUGIN_DATA": "/legacy"}, {"ODD_CLAUDE_DATA": "/a", "CLAUDE_PLUGIN_DATA": "/b/w"}, {"ODD_CLAUDE_DATA": "", "CLAUDE_PLUGIN_DATA": "/b/w"},
                {"ODD_CLAUDE_HOME": "/h"}, {"ODD_CLAUDE_HOME": "/h/.w"}, {"ODD_CLAUDE_HOME": "", "HOME": "/home/u"}, {"HOME": "/home/u"}, {"HOME": ""}, {"ODD_CLAUDE_HOME": "/é\ud83d"[:3]},
                {"ODD_CLAUDE_DATA": "\ud800w"}, {"ODD_CLAUDE_DATA": "/" + "x" * 3000 + "w"}):
        out.append(base(env=env))
    for v in ("1.0.0", "", "\U0001f600", "\ud800", "v" * 500, "1.0 "):
        out.append(base(version=v))
    return out


def test_collect_doctor_matches_v9_apart_from_the_runtime_items():
    cs = cases()
    got = v9_collect(cs)
    for c, g in zip(cs, got):
        p = py_collect(c)
        assert comparable(g) == comparable(p), c
        assert g["schema"] == p["schema"] == 1 and list(g) == list(p), c


def test_ok_matches_when_the_runtime_items_pass():
    cs = cases()
    got = v9_collect(cs)
    for c, g in zip(cs, got):
        p = py_collect(c)
        uv_ok = next(i for i in p["items"] if i["id"] == "uv")["status"] == "ok"
        if uv_ok:  # v9 has no uv item: `ok` is comparable only when uv is present
            assert g["ok"] == p["ok"], c
        # when uv is missing Python's ok is false by design (uv is required, S5)


def test_item_shape_and_required_semantics_per_id():
    """Same required/optional flag and key order for every id both sides have (node/python are the runtime counterpart)."""
    g = v9_collect([base()])[0]
    p = py_collect(base())
    gi = {i["id"]: i for i in g["items"]}
    pi = {i["id"]: i for i in p["items"]}
    for id_ in set(gi) & set(pi):
        assert gi[id_] == pi[id_], id_
        assert list(gi[id_]) == list(pi[id_])
    assert gi["node"]["required"] is pi["python"]["required"] is pi["uv"]["required"] is True


def test_parse_version():
    got = v9_many("doctor", "parseVersion", [[t] for t in VERSION_TEXTS])
    for t, g in zip(VERSION_TEXTS, got):
        assert g == d.parse_version(t), repr(t)[:60]


def _report(items, missing, version="1.0.0"):
    return {"schema": 1, "version": version, "items": items, "missing": missing, "requiredMissing": [], "ok": True}


def _item(id_, label, required=True, status="ok", detail="d"):
    return {"id": id_, "label": label, "required": required, "status": status, "detail": detail}


RENDER_REPORTS = [
    _report([_item("a", "a")], []),
    _report([_item("a", "short"), _item("b", "a much longer label", False, "missing", "not found")], ["b"]),
    _report([_item("a", "x", True, "missing"), _item("b", "y", False, "missing")], ["a", "b"]),
    _report([_item("a", "\U0001f600"), _item("b", "ab")], []),
    _report([_item("a", "\U0001f600\U0001f600", False, "missing"), _item("b", "abcdef", True)], ["a"]),
    _report([_item("a", "é"), _item("b", "éé")], []),
    _report([_item("a", " ﻿"), _item("b", " x")], ["\U0001f600", "é"]),
    _report([_item("a", "")], []),
    _report([_item("a", "x" * 300), _item("b", "y")], []),
    _report([_item("a", "\ud800"), _item("b", "zz")], []),
    _report([_item("a", "l", detail="\U0001f600\nline2")], []),
    _report([_item("a", "l")], ["a", "b", "c"], version="\U0001f600"),
    _report([], []),
    _report([], ["a"]),
    _report([_item("a", "a", detail="")], [], version=""),
]


def test_render_doctor():
    got = v9_many("doctor", "renderDoctor", [[r] for r in RENDER_REPORTS])
    for r, g in zip(RENDER_REPORTS, got):
        rep = d.DoctorReport(schema_=1, version=r["version"], items=r["items"], missing=r["missing"], requiredMissing=r["requiredMissing"], ok=r["ok"])
        try:
            p = d.render_doctor(rep)
        except Exception as ex:  # noqa: BLE001
            p = {"__error__": str(ex)}
        assert g == p, r
