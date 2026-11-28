"""Real-process races across v9 and Python: lock exclusivity, kill -9 takeover, revision CAS."""
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

import pytest
from lib.v9_oracle import DIST, needs_v9
from odd_claude.review import state as S
from odd_claude.review import store as st

pytestmark = needs_v9
SRC = str(Path(__file__).resolve().parents[2] / "src")
NODE_LOOP = r"""
const [dist, root, n, marker, counter, barrier] = process.argv.slice(1);
const L = await import(dist + "/review/lock.js"); const fs = await import("node:fs");
while (!fs.existsSync(barrier)) await new Promise(r => setTimeout(r, 2));
let dbl = 0;
for (let i = 0; i < +n; i++) {
  const h = await L.acquireStoreLock(root, { timeoutMs: 60000 });
  try { fs.writeFileSync(marker, "x", { flag: "wx" }); } catch { dbl++; }
  const c = +fs.readFileSync(counter, "utf8"); await new Promise(r => setTimeout(r, 1)); fs.writeFileSync(counter, String(c + 1));
  fs.rmSync(marker, { force: true }); if (h.release().status !== "released") dbl += 1000;
}
console.log(dbl);
"""
PY_LOOP = f"""
import os, sys, time; sys.path.insert(0, {SRC!r})
from odd_claude.review.lock import acquire_store_lock, StoreLockOptions
root, n, marker, counter, barrier = sys.argv[1:]
while not os.path.exists(barrier): time.sleep(0.002)
dbl = 0
for _ in range(int(n)):
    h = acquire_store_lock(root, StoreLockOptions(timeout_ms=60000))
    try: os.close(os.open(marker, os.O_CREAT | os.O_EXCL | os.O_WRONLY))
    except FileExistsError: dbl += 1
    c = int(open(counter).read()); time.sleep(0.001); open(counter, "w").write(str(c + 1))
    if os.path.exists(marker): os.unlink(marker)
    if h.release().status != "released": dbl += 1000
print(dbl)
"""
HOLD = {"py": lambda root: [sys.executable, "-c", f"import sys,time; sys.path.insert(0,{SRC!r})\nfrom odd_claude.review.lock import acquire_store_lock\nacquire_store_lock(sys.argv[1]); print('held',flush=True); time.sleep(600)", root],
        "node": lambda root: ["node", "--input-type=module", "-e", "const L=await import(process.argv[1]+'/review/lock.js'); await L.acquireStoreLock(process.argv[2]); console.log('held'); setTimeout(()=>{},600000);", DIST.as_uri(), root]}

NODE_CAS = r"""
const [dist, cd, lineage, rev, tag, barrier] = process.argv.slice(1);
const store = await import(dist + "/review/store.js"); const state = await import(dist + "/review/state.js"); const fs = await import("node:fs");
while (!fs.existsSync(barrier)) await new Promise(r => setTimeout(r, 2));
try { await store.updateState(cd, lineage, rev, (r) => state.invalidate(r, { reason: "r", now: tag })); console.log("WIN"); }
catch (e) { console.log(e.code); }
"""
PY_CAS = f"""
import os, sys, time; sys.path.insert(0, {SRC!r})
from odd_claude.review import state, store
cd, lineage, rev, tag, barrier = sys.argv[1:]
while not os.path.exists(barrier): time.sleep(0.002)
try:
    store.update_state(cd, lineage, rev, lambda r: state.invalidate(r, {{"reason": "r", "now": tag}})); print("WIN")
except Exception as e: print(getattr(e, "code", repr(e)))
"""


def _contend(root, n_each, n):
    marker, counter, barrier = root + ".m", root + ".c", root + ".go"
    Path(counter).write_text("0")
    ps = [subprocess.Popen([sys.executable, "-c", PY_LOOP, root, str(n), marker, counter, barrier], stdout=subprocess.PIPE, text=True) for _ in range(n_each)]
    ps += [subprocess.Popen(["node", "--input-type=module", "-e", NODE_LOOP, DIST.as_uri(), root, str(n), marker, counter, barrier], stdout=subprocess.PIPE, text=True) for _ in range(n_each)]
    time.sleep(0.5)
    Path(barrier).touch()
    outs = [p.communicate(timeout=300)[0] for p in ps]
    assert [p.returncode for p in ps] == [0] * len(ps)
    assert sum(int(o.strip()) for o in outs) == 0
    assert int(Path(counter).read_text()) == 2 * n_each * n
    assert os.listdir(root) == []


def test_mixed_v9_and_python_lock_contenders_never_hold_together(tmp_path):
    os.mkdir(tmp_path / "v2")
    _contend(str(tmp_path / "v2"), 4, 15)


@pytest.mark.parametrize("holder", ["py", "node"])
def test_kill_9_holder_then_mixed_contenders_take_over(tmp_path, holder):
    root = str(tmp_path / "v2")
    os.mkdir(root)
    p = subprocess.Popen(HOLD[holder](root), stdout=subprocess.PIPE, text=True)
    assert p.stdout.readline().strip() == "held"
    os.kill(p.pid, signal.SIGKILL)
    p.wait()
    _contend(root, 3, 5)


def test_same_expected_revision_from_v9_and_python_processes_exactly_one_wins(tmp_path):
    cd, lineage = str(tmp_path), "review-" + "a" * 16
    rec = S.start({"lineageId": lineage, "targetIdentity": "sha256:" + "0" * 64, "projection": "workspace", "baseTree": "b" * 40, "candidateTree": "c" * 40,
                   "riskLevel": "medium", "selectedLenses": ["reliability"], "originalChangedLines": 8, "now": "2026-11-19T10:00:00.000Z"})["record"]
    rev = st.create_state(cd, rec)["revision"]
    barrier = str(tmp_path / "go")
    tags = [f"2026-11-19T10:05:00.{i:03d}Z" for i in range(10)]
    ps = [subprocess.Popen([sys.executable, "-c", PY_CAS, cd, lineage, rev, t, barrier], stdout=subprocess.PIPE, text=True) for t in tags[:5]]
    ps += [subprocess.Popen(["node", "--input-type=module", "-e", NODE_CAS, DIST.as_uri(), cd, lineage, rev, t, barrier], stdout=subprocess.PIPE, text=True) for t in tags[5:]]
    time.sleep(0.5)
    Path(barrier).touch()
    outs = [p.communicate(timeout=120)[0].strip() for p in ps]
    assert [p.returncode for p in ps] == [0] * 10
    wins = [i for i, o in enumerate(outs) if o == "WIN"]
    assert len(wins) == 1
    assert all(o == "STORE_CONCURRENT_UPDATE" for i, o in enumerate(outs) if i != wins[0])
    stored = st.read_state(cd, lineage)
    assert stored["state"] == "invalidated" and stored["updated_at"] == tags[wins[0]]
