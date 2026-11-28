"""Boot / pid-namespace identity for the review store lock (port of v9 review/boot-id.ts).

`kill(pid, 0)` only means something inside the pid namespace (and boot) that owns the pid, and a machine id file can be
shared (container mounting ~/.local/state, NFS home). So a lock may be judged dead by pid only when the owner recorded the
SAME machine id AND the SAME boot identity.
  Linux: /proc/sys/kernel/random/boot_id + the pid namespace link of /proc/self/ns/pid, e.g. "<uuid>/pid:[4026531836]".
  macOS: `kern.bootsessionuuid` via one cached `/usr/sbin/sysctl -n` call (absolute path, 1 s timeout).
Anything else, or any failure, is None (callers use the hostname rule). Nothing here raises.
Public API: `is_boot_id`, `parse_linux_boot`, `parse_mac_boot`, `BootReaders`, `SYSCTL_PATH`, `real_readers`, `read_boot_id`, `boot_id`.
"""
import os
import re
import stat
import subprocess
import sys
from dataclasses import dataclass
from typing import Callable

from ..lib.js import js_trim

_UUID_RE = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
_NS_RE = re.compile(r"pid:\[[0-9]{1,20}\]")
_BOOT_RE = re.compile(r"[0-9A-Za-z:\[\]/_.-]{1,128}")


def is_boot_id(v: object) -> bool:
    return isinstance(v, str) and _BOOT_RE.fullmatch(v) is not None


def parse_linux_boot(boot_id_text: str | None, pid_ns_link: str | None) -> str | None:
    """Joins the boot_id file text and the pid namespace link text. None unless both are strictly valid."""
    if boot_id_text is None or pid_ns_link is None:
        return None
    id_, ns = js_trim(boot_id_text), js_trim(pid_ns_link)
    if not _UUID_RE.fullmatch(id_) or not _NS_RE.fullmatch(ns):
        return None
    return f"{id_.lower()}/{ns}"


def parse_mac_boot(out: str | None) -> str | None:
    """The `kern.bootsessionuuid` output."""
    if out is None:
        return None
    id_ = js_trim(out)
    return f"mac:{id_.lower()}" if _UUID_RE.fullmatch(id_) else None


@dataclass
class BootReaders:
    platform: str  # `sys.platform` names, as Node's process.platform: "linux", "darwin", "win32"...
    #: Bounded text of a file (<= 128 bytes) or None.
    read_text: Callable[[str], str | None]
    read_link: Callable[[str], str | None]
    sysctl: Callable[[str], str | None]


def _bounded_read(path: str) -> str | None:
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
    except OSError:
        return None
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):  # /proc files report size 0: only the type is checked
            return None
        buf = b""
        while True:
            chunk = os.read(fd, 129 - len(buf))
            if not chunk:
                break
            buf += chunk
            if len(buf) > 128:
                return None
        return buf.decode("utf-8", "replace")
    except OSError:
        return None
    finally:
        os.close(fd)


#: Absolute path: no PATH lookup that a shadowing binary could answer.
SYSCTL_PATH = "/usr/sbin/sysctl"


def _read_link(path: str) -> str | None:
    try:
        return os.readlink(path)
    except OSError:
        return None


def _sysctl(name: str) -> str | None:
    try:
        r = subprocess.run([SYSCTL_PATH, "-n", name], timeout=1, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        return r.stdout.decode("utf-8", "replace") if r.returncode == 0 and len(r.stdout) <= 4096 else None
    except Exception:
        return None


real_readers = BootReaders(platform=sys.platform, read_text=_bounded_read, read_link=_read_link, sysctl=_sysctl)


def read_boot_id(readers: BootReaders | None = None) -> str | None:
    readers = readers or real_readers
    try:
        if readers.platform == "linux":
            return parse_linux_boot(readers.read_text("/proc/sys/kernel/random/boot_id"), readers.read_link("/proc/self/ns/pid"))
        if readers.platform == "darwin":
            return parse_mac_boot(readers.sysctl("kern.bootsessionuuid"))
    except Exception:
        pass
    return None


_cached: tuple[str | None] | None = None


def boot_id() -> str | None:
    """The boot identity of this process, resolved once (a failure is cached: hostname rule for the whole process)."""
    global _cached
    if _cached is None:
        _cached = (read_boot_id(),)
    return _cached[0]
