"""Test-only crash injection for the REAL Python MCP server process (the twin of plugins/odd-claude/src/contract/kill-preload.testkit.ts):
`python -P tests/mcp/kill_preload.py` patches `os`/`shutil` in that process only, then runs `odd_claude.mcp.review_server` as `__main__`.
It never patches production code on disk. Environment (all required, otherwise nothing is patched):
  ODD_KILL_CD    <git-common-dir>: only filesystem calls under it are counted (the LOCK directory is excluded)
  ODD_KILL_ARM   a path OUTSIDE ODD_KILL_CD; counting starts when that file exists
  ODD_KILL_LOG   a path OUTSIDE ODD_KILL_CD; after every counted call it is rewritten with {"n":..,"labels":[..]}
  ODD_KILL_AT    k >= 1: SIGKILL this process right before (ODD_KILL_PHASE=before) or right after (=after) the k-th call; 0 only counts
The kill is `os.kill(pid, SIGKILL)`: no handler, no flush, no `finally`, exactly kill -9. Counted calls and labels mirror the node injector:
open/write/fsync/fchmod/close of a tracked fd, rename (`os.replace` counts as a rename), mkdir, unlink, rmdir and a recursive remove (`rm`)."""
import json
import os
import runpy
import shutil
import signal
import time

cd = os.environ.get("ODD_KILL_CD", "")
arm = os.environ.get("ODD_KILL_ARM", "")
log = os.environ.get("ODD_KILL_LOG", "")
kill_at = int(os.environ.get("ODD_KILL_AT", "0") or 0)
phase = os.environ.get("ODD_KILL_PHASE", "before")

if cd and arm and log:
    _o = {k: getattr(os, k) for k in ("open", "write", "fsync", "fchmod", "close", "rename", "replace", "mkdir", "unlink", "remove", "rmdir")}
    _rmtree = shutil.rmtree
    tracked: dict[int, tuple[int, int]] = {}  # fd -> (dev, ino): a descriptor closed behind our back (os.fdopen) must not keep counting once its number is reused
    labels: list[str] = []
    n = 0

    def interesting(p) -> bool:
        try:
            p = os.fspath(p)
        except TypeError:
            return False
        return isinstance(p, str) and p.startswith(cd) and "/LOCK" not in p

    def die():
        os.kill(os.getpid(), signal.SIGKILL)
        # a tool runs in its own thread and the kernel may deliver the signal to another one: this thread must not run a single further call meanwhile
        time.sleep(60)

    def ev(label: str, fn):
        global n
        if not os.path.exists(arm):
            return fn()
        n += 1
        labels.append(label)
        # unpatched primitives, written whole then renamed: a kill never leaves a partial or empty log
        fd = _o["open"](log + ".tmp", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        data = json.dumps({"n": n, "labels": labels}).encode()
        while data:
            data = data[_o["write"](fd, data):]
        _o["close"](fd)
        _o["replace"](log + ".tmp", log)
        if n == kill_at and phase == "before":
            die()
        r = fn()
        if n == kill_at and phase == "after":
            die()
        return r

    def p_open(path, *a, **k):
        if not interesting(path):
            return _o["open"](path, *a, **k)
        fd = ev(f"open {os.fspath(path)[len(cd):]}", lambda: _o["open"](path, *a, **k))
        st = os.fstat(fd)
        tracked[fd] = (st.st_dev, st.st_ino)
        return fd

    def is_tracked(fd) -> bool:
        want = tracked.get(fd)
        if want is None:
            return False
        try:
            st = os.fstat(fd)
        except OSError:
            st = None
        if st is None or (st.st_dev, st.st_ino) != want:
            tracked.pop(fd, None)
            return False
        return True

    def fd_patch(name):
        def patched(fd, *a, **k):
            if is_tracked(fd):
                return ev(name, lambda: _o[name](fd, *a, **k))
            return _o[name](fd, *a, **k)

        return patched

    def p_close(fd):
        if not is_tracked(fd):
            return _o["close"](fd)
        tracked.pop(fd, None)
        return ev("close", lambda: _o["close"](fd))

    def path_patch(name, label):
        def patched(path, *a, **k):
            if interesting(path):
                return ev(f"{label} {os.fspath(path)[len(cd):]}", lambda: _o[name](path, *a, **k))
            return _o[name](path, *a, **k)

        return patched

    os.open = p_open
    os.write, os.fsync, os.fchmod = fd_patch("write"), fd_patch("fsync"), fd_patch("fchmod")
    os.close = p_close
    os.rename, os.replace = path_patch("rename", "rename"), path_patch("replace", "rename")
    os.mkdir = path_patch("mkdir", "mkdir")
    os.unlink, os.remove = path_patch("unlink", "unlink"), path_patch("remove", "unlink")
    os.rmdir = path_patch("rmdir", "rmdir")

    def p_rmtree(path, *a, **k):
        if interesting(path):
            return ev(f"rm {os.fspath(path)[len(cd):]}", lambda: _rmtree(path, *a, **k))
        return _rmtree(path, *a, **k)

    shutil.rmtree = p_rmtree

runpy.run_module("odd_claude.mcp.review_server", run_name="__main__", alter_sys=True)
