import math
import os

from odd_claude.lib.pid import is_pid_alive, pid_state

from .conftest import dead_pid


def test_own_pid_is_alive():
    assert pid_state(os.getpid()) == "alive"
    assert is_pid_alive(os.getpid()) is True


def test_exited_child_is_dead_esrch():
    pid = dead_pid()
    assert pid_state(pid) == "dead"
    assert is_pid_alive(pid) is False


def test_invalid_pids_are_never_signalled_and_prove_nothing():
    for pid in [0, -1, -os.getpid(), math.nan, math.inf, 1.5, True, "1", None]:
        assert pid_state(pid) == "invalid", repr(pid)
        assert is_pid_alive(pid) is False, repr(pid)


def test_eperm_maps_to_alive():
    # pid 1 exists everywhere; unprivileged users get EPERM, root gets success. Both mean alive.
    assert pid_state(1) == "alive"
