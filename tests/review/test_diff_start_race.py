"""Start race (T5 verifier probe): 4 v9 node processes and 4 Python processes released together by a time barrier call startReview on
one dirty repo with consent granted. Exactly one review transaction must exist and exactly one caller creates it; the rest replay it.
A `refused`/`authority_error` is tolerated (known v9 race, advisory A1: find_lineage sees the lineage dir before its state file) but
must not be the majority. HOME and data dirs are sandboxed."""
import json
import os
import subprocess
import sys
import time
from collections import Counter

import pytest
from lib.v9_oracle import DIST, needs_v9

from review.test_start import git

pytestmark = needs_v9
N = 4
HIGH = {"level": "high", "reasons": [{"code": "x"}], "evidence": ["e"]}
NODE = """
const { startReview } = await import(process.argv[1] + "/review/start.js");
const [repo, go] = [process.argv[2], Number(process.argv[3])];
while (Date.now() < go * 1000) {}
const o = await startReview({cwd: repo, target: {kind: "current-changes"}, consent: "granted", riskAssessor: () => (%s)});
console.log(JSON.stringify({impl: "v9", status: o.status, action: o.result?.action, code: o.code}));
""" % json.dumps(HIGH)
PY = """
import json, sys, time
from odd_claude.review.start import start_review
repo, go = sys.argv[1], float(sys.argv[2])
while time.time() < go: pass
o = start_review({"cwd": repo, "target": {"kind": "current-changes"}, "consent": "granted", "riskAssessor": lambda s, r: %r})
r = o.get("result") or {}
print(json.dumps({"impl": "py", "status": o["status"], "action": r.get("action"), "code": o.get("code")}))
""" % HIGH


def test_concurrent_starts_create_one_transaction(tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()
    git(repo, "init", "-q", "-b", "main")
    (repo / "a.txt").write_text("one\n")
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "i")
    (repo / "a.txt").write_text("one\ntwo\n")
    home = tmp_path / "home"
    home.mkdir()
    env = {**{k: v for k, v in os.environ.items() if not k.upper().startswith(("GIT_", "CLAUDE", "ODD_"))}, "HOME": str(home), "GIT_CONFIG_NOSYSTEM": "1"}
    go = str(time.time() + 3)
    ps = [subprocess.Popen(["node", "--input-type=module", "-e", NODE, DIST.as_uri(), str(repo), go], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for _ in range(N)]
    ps += [subprocess.Popen([sys.executable, "-c", PY, str(repo), go], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for _ in range(N)]
    outs = [p.communicate(timeout=60) for p in ps]
    assert all(p.returncode == 0 for p in ps), [e[-300:] for _, e in outs]
    res = [json.loads(o) for o, _ in outs]

    dirs = [d for d in (repo / ".git" / "odd-plugin" / "review-transactions" / "v2").iterdir() if d.name.startswith("review-")]
    assert len(dirs) == 1, dirs
    created = [r for r in res if r.get("action") == "created"]
    assert len(created) == 1, res
    refused = [r for r in res if r["status"] == "refused"]
    assert all(r.get("code") == "authority_error" for r in refused), res
    assert len(refused) < N, res
    others = [r for r in res if r.get("action") != "created" and r["status"] != "refused"]
    assert all(r["status"] == "started" and r["action"] == "replayed" for r in others), res
    assert Counter(r["impl"] for r in res) == {"v9": N, "py": N}
