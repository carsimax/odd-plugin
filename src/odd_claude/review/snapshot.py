"""Git snapshot freezing for the review engine (port of v9 review/snapshot.ts; read that file's header for the rationale).

Turns "what is under review" into immutable git tree ids plus content-addressed identities, without touching the user's
real index or working tree: git runs only through an argument list (never a shell) with a sanitized environment (every
caller GIT_* variable dropped), a bounded timeout (SIGKILL on expiry) and a bounded output buffer; the candidate tree is
built in a private copy of the real index; untracked files enter a candidate only when listed explicitly.

Python port conventions (data crosses the persisted/canonical-hash boundary, so it keeps v9's shapes):
  - `target`, `options`, `Snapshot`, `FreezeResult`, `RepositoryIdentity` are plain dicts with v9's camelCase keys
    (`options` is `{"gitTimeoutMs": n}`; a `Bound` is `{"timeoutMs": n}`; a `Snapshot` has kind, projection, unbornHead, baseTree,
    candidateTree, paths, pathsDigest, intendedUntracked, intendedUntrackedProof, changedLines, identity; a repository is
    `{"root", "gitDir", "commonDir"}`).
  - `run_git(cwd=, args=, timeout_ms=, env=, input=, ok_exit=, limit=)` takes keywords (v9 takes one call object) and returns
    `GitOut(stdout: bytes, exit_code: int)`.
  - Failures raise `SnapshotError(code, message, reason=None, exit_code=None)`; `str(error)` is the v9 message.
Public API: constants (`DEFAULT_GIT_TIMEOUT_MS`, `MAX_GIT_TIMEOUT_MS`, `MAX_INTENDED_UNTRACKED_*`, `OUTPUT_LIMIT`,
`INVENTORY_LIMIT`, `STALE_SCRATCH_MS`), `SnapshotError`, `bound_of`, `run_git`, `decode_name`, `nul_records`,
`normalize_logical_path`, `resolve_repository`, `digest_paths`, `verify_intended_files`, `intended_untracked_proof`,
`snapshot_identity`, `is_generated_golden_path`, `count_changed_lines`, `freeze_snapshot`.
"""
import json
import math
import os
import re
import selectors
import shutil
import signal
import stat
import subprocess
import tempfile
import time
import unicodedata
from dataclasses import dataclass

from ..lib.js import js_json_loads, js_stringify, js_trim, utf16_head
from ..lib.pid import is_pid_alive
from ._paths import js_join
from .canonical import domain_hash

DEFAULT_GIT_TIMEOUT_MS = 30_000
MAX_GIT_TIMEOUT_MS = 5 * 60_000
MAX_INTENDED_UNTRACKED_FILES = 1000
MAX_INTENDED_UNTRACKED_FILE_BYTES = 1024 * 1024
MAX_INTENDED_UNTRACKED_TOTAL_BYTES = 16 * 1024 * 1024
OUTPUT_LIMIT = 8 * 1024 * 1024
INVENTORY_LIMIT = 64 * 1024 * 1024
STALE_SCRATCH_MS = 10 * 60_000
_STDERR_SNIPPET = 2000
_OID_RE = re.compile(r"(?:[0-9a-f]{40}|[0-9a-f]{64})")
_SCRATCH_PREFIX = ".odd-review-index-"
_SCRATCH_ALLOWED = {"index", "index.lock", "owner.json", "git"}
_MAX_SWEEP_ENTRIES = 64
_MISSING = object()


class SnapshotError(Exception):
    def __init__(self, code: str, message: str, reason: str | None = None, exit_code: int | None = None):
        super().__init__(message)
        self.code = code
        self.reason = reason
        self.exit_code = exit_code


def _utf8(s: str) -> bytes:
    """JS `Buffer.from(s, "utf8")`: a lone surrogate becomes U+FFFD."""
    return s.encode("utf-16", "surrogatepass").decode("utf-16", "replace").encode("utf-8")


def _js_str(v: object) -> str:
    """`${JSON.stringify(v)}` (undefined, i.e. a missing key, prints as "undefined")."""
    return "undefined" if v is _MISSING else js_stringify(v)


def bound_of(options: dict | None) -> dict:
    t = (options or {}).get("gitTimeoutMs")
    return {"timeoutMs": DEFAULT_GIT_TIMEOUT_MS if t is None else t}


# ---------------------------------------------------------------------------------------------
# git runner
# ---------------------------------------------------------------------------------------------


def _git_env(extra: dict | None) -> dict:
    """Caller GIT_* variables never reach git (a stray GIT_INDEX_FILE would redirect our writes)."""
    env = {k: v for k, v in os.environ.items() if not (k.upper().startswith("GIT_") or k.upper() == "LC_ALL")}
    env["LC_ALL"] = "C"
    env["GIT_OPTIONAL_LOCKS"] = "0"  # read-only commands must not refresh the real index
    env["GIT_TERMINAL_PROMPT"] = "0"
    return {**env, **(extra or {})}


@dataclass
class GitOut:
    stdout: bytes
    exit_code: int


def _spawn_bounded(argv: list[str], env: dict, data: bytes, timeout_s: float, limit: int) -> tuple[str | None, bytes, bytes, int | None]:
    """`spawnSync` with `timeout` + `maxBuffer`: returns (error, stdout, stderr, returncode); error is "timeout" or "enobufs"."""
    deadline = time.monotonic() + timeout_s
    p = subprocess.Popen(argv, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0)
    sel = selectors.DefaultSelector()
    bufs = {p.stdout: bytearray(), p.stderr: bytearray()}
    for f in bufs:
        os.set_blocking(f.fileno(), False)
        sel.register(f, selectors.EVENT_READ)
    wpos = 0
    if data:
        os.set_blocking(p.stdin.fileno(), False)
        sel.register(p.stdin, selectors.EVENT_WRITE)
    else:
        p.stdin.close()
    error = None
    try:
        while len(sel.get_map()) > 0:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                error = "timeout"
                break
            for key, _ in sel.select(remaining):
                f = key.fileobj
                if f is p.stdin:
                    try:
                        wpos += os.write(f.fileno(), data[wpos : wpos + 65536])
                    except BlockingIOError:
                        continue
                    except OSError:  # EPIPE: git exited without reading its input
                        wpos = len(data)
                    if wpos >= len(data):
                        sel.unregister(f)
                        f.close()
                    continue
                try:
                    chunk = os.read(f.fileno(), 65536)
                except BlockingIOError:
                    continue
                if not chunk:
                    sel.unregister(f)
                    continue
                bufs[f] += chunk
                if len(bufs[f]) > limit:
                    error = "enobufs"
                    break
            if error:
                break
        if error is None:
            try:
                p.wait(max(deadline - time.monotonic(), 0))
            except subprocess.TimeoutExpired:
                error = "timeout"
    finally:
        if error is not None:
            p.kill()
        p.wait()
        sel.close()
        for f in (p.stdin, p.stdout, p.stderr):
            try:
                f.close()
            except OSError:
                pass
    return error, bytes(bufs[p.stdout]), bytes(bufs[p.stderr]), p.returncode


def run_git(cwd: str, args: list[str], timeout_ms: float, env: dict | None = None, input: str | bytes | None = None, ok_exit: list[int] | None = None, limit: int | None = None) -> GitOut:
    timeout = min(max(timeout_ms, 1), MAX_GIT_TIMEOUT_MS)
    label = f"git {args[0] if args else ''}"
    data = b"" if input is None else _utf8(input) if isinstance(input, str) else bytes(input)
    try:
        error, out, err, rc = _spawn_bounded(["git", "--no-replace-objects", "-C", cwd, *args], _git_env(env), data, timeout / 1000, OUTPUT_LIMIT if limit is None else limit)
    except FileNotFoundError:
        raise SnapshotError("git_unavailable", "git executable not found") from None
    except OSError as e:
        raise SnapshotError("git_failed", f"{label} could not run: {e}") from None
    if error == "timeout":
        raise SnapshotError("git_timeout", f"{label} timed out after {math.ceil(timeout)}ms")
    if error == "enobufs":
        raise SnapshotError("git_output_limit", f"{label} output exceeded the deterministic byte limit")
    if rc < 0:
        raise SnapshotError("git_timeout", f"{label} was killed ({signal.Signals(-rc).name})")
    if rc not in ([0] if ok_exit is None else ok_exit):
        snippet = utf16_head(js_trim(err.decode("utf-8", "replace")), _STDERR_SNIPPET)
        raise SnapshotError("git_failed", f"{label} failed with exit code {rc}{': ' + snippet if snippet else ''}", exit_code=rc)
    return GitOut(out, rc)


def _one_line(out: bytes, what: str) -> str:
    text = out.decode("utf-8", "replace")
    if text.endswith("\n"):
        text = text[:-1]
    if text == "" or "\n" in text or "\0" in text:
        raise SnapshotError("corrupt_output", f"{what} is not exactly one record")
    return text


def _oid(out: bytes, what: str) -> str:
    value = _one_line(out, what)
    if not _OID_RE.fullmatch(value):
        raise SnapshotError("corrupt_output", f"{what} is not an object id")
    return value


def _is_oid(v: object) -> bool:
    return isinstance(v, str) and _OID_RE.fullmatch(v) is not None


def decode_name(data: bytes, what: str) -> str:
    """Fail closed on any name that is not valid UTF-8: a lossy decode would hash a different path."""
    try:
        return bytes(data).decode("utf-8")
    except UnicodeDecodeError:
        raise SnapshotError("invalid_encoding", f"{what} is not valid UTF-8") from None


def nul_records(out: bytes) -> list[bytes]:
    records: list[bytes] = []
    start = 0
    for i, b in enumerate(out):
        if b == 0:
            if i > start:
                records.append(out[start:i])
            start = i + 1
    if start < len(out):
        raise SnapshotError("corrupt_output", "unterminated NUL record")
    return records


# ---------------------------------------------------------------------------------------------
# paths
# ---------------------------------------------------------------------------------------------


def normalize_logical_path(value: object) -> str:
    """Canonical repository-relative logical path: '/'-separated, no `.`/`..`/empty segment, no `\\`, no NUL."""
    if not isinstance(value, str) or value == "" or "\0" in value or "\\" in value or value.startswith("/"):
        raise SnapshotError("invalid_path", f"invalid logical path {js_stringify(value)}")
    for segment in value.split("/"):
        if segment in ("", ".", ".."):
            raise SnapshotError("invalid_path", f"logical path is not canonical: {js_stringify(value)}")
    return value


def _canonical_paths(values: list) -> list[str]:
    normalized = sorted((normalize_logical_path(v) for v in values), key=_utf8)
    for i in range(1, len(normalized)):
        if normalized[i] == normalized[i - 1]:
            raise SnapshotError("invalid_path", f"duplicate intended-untracked path {js_stringify(normalized[i])}")
    return normalized


def _refuse(reason: str, path: str, detail: str) -> SnapshotError:
    return SnapshotError("untracked_refused", f"intended-untracked path {js_stringify(path)} {detail}", reason=reason)


def _listdir(path: str) -> list[str]:
    return sorted(os.listdir(path), key=os.fsencode)  # libuv's readdir is sorted


def _stat_no_follow(path: str, logical: str) -> os.stat_result:
    try:
        return os.lstat(path)
    except OSError:
        raise _refuse("missing", logical, "does not exist") from None


def _check_intended_files(root: str, paths: list[str], precompose: bool = False) -> None:
    """Every intended path must be a regular, in-worktree, bounded file reached without a symlink."""
    if len(paths) > MAX_INTENDED_UNTRACKED_FILES:
        raise _refuse("too_many", f"({len(paths)} paths)", f"list exceeds {MAX_INTENDED_UNTRACKED_FILES} files")
    total = 0
    names: dict[str, set[str]] = {}

    def exact(d: str, name: str, logical: str) -> None:
        s = names.get(d)
        if s is None:
            # core.precomposeunicode: git itself reports (and freezes) NFC names, so an NFD name on disk matches its NFC spelling.
            s = {unicodedata.normalize("NFC", n) if precompose else n for n in _listdir(d)}
            names[d] = s
        # Case-insensitive volumes resolve a wrong-case spelling; only the on-disk spelling may be frozen.
        if name not in s:
            raise _refuse("name_mismatch", logical, "does not match the on-disk spelling of its path")

    for path in paths:
        if path != unicodedata.normalize("NFC", path):
            raise SnapshotError("invalid_path", f"intended-untracked path {js_stringify(path)} must use Unicode NFC spelling")
        segments = path.split("/")
        if any(s.lower() == ".git" for s in segments):
            raise SnapshotError("invalid_path", f"intended-untracked path {js_stringify(path)} is inside .git")
        current = root
        for seg in segments[:-1]:
            parent = current
            current = js_join(current, seg)
            info = _stat_no_follow(current, path)
            if stat.S_ISLNK(info.st_mode):
                raise _refuse("symlink", path, "traverses a symbolic link")
            if not stat.S_ISDIR(info.st_mode):
                raise _refuse("not_regular", path, "has a non-directory parent")
            exact(parent, seg, path)
        full = js_join(current, segments[-1])
        info = _stat_no_follow(full, path)
        if stat.S_ISLNK(info.st_mode):
            raise _refuse("symlink", path, "is a symbolic link")
        if not stat.S_ISREG(info.st_mode):
            raise _refuse("not_regular", path, "is not a regular file")
        if info.st_nlink > 1:
            raise _refuse("hardlink", path, "has more than one hard link")
        exact(current, segments[-1], path)
        if info.st_size > MAX_INTENDED_UNTRACKED_FILE_BYTES:
            raise _refuse("too_large", path, f"exceeds {MAX_INTENDED_UNTRACKED_FILE_BYTES} bytes")
        total += info.st_size
        if total > MAX_INTENDED_UNTRACKED_TOTAL_BYTES:
            raise _refuse("too_large", path, f"pushes the list past {MAX_INTENDED_UNTRACKED_TOTAL_BYTES} bytes")
        try:
            real = os.path.realpath(full, strict=True)
        except OSError:
            raise _refuse("missing", path, "does not exist") from None
        if not real.startswith(root + os.sep):
            raise _refuse("outside", path, "resolves outside the worktree")


# ---------------------------------------------------------------------------------------------
# repository identity
# ---------------------------------------------------------------------------------------------


def resolve_repository(cwd: object, options: dict | None = None) -> dict:
    bound = bound_of(options)
    if not isinstance(cwd, str) or cwd == "" or "\0" in cwd:
        raise SnapshotError("invalid_target", "repository path is required")
    try:
        start = os.path.realpath(os.path.abspath(cwd), strict=True)
    except OSError:
        raise SnapshotError("not_a_repository", f"{cwd} does not exist") from None
    try:
        toplevel = _one_line(run_git(cwd=start, args=["rev-parse", "--show-toplevel"], timeout_ms=bound["timeoutMs"]).stdout, "repository root")
    except SnapshotError as error:
        if error.code != "git_failed":
            raise
        # upstream parity (its review-incident classifier): git refuses a repository owned by someone else with exit 128 and
        # a `fatal: detected dubious ownership` (or `unsafe repository`) line AND the safe.directory hint (run_git forces LC_ALL=C,
        # so the text is stable). That is not "no repository": the repository exists but git will not work in it.
        msg = str(error)
        if error.exit_code == 128 and re.search(r"fatal: (?:detected dubious ownership|unsafe repository)", msg, re.I | re.A) and re.search(r"safe\.directory", msg, re.I | re.A):
            raise SnapshotError("untrusted_repository", f"{start} is a repository git does not trust (dubious ownership); add it to safe.directory to use it", exit_code=128) from None
        try:
            bare = _one_line(run_git(cwd=start, args=["rev-parse", "--is-bare-repository"], timeout_ms=bound["timeoutMs"]).stdout, "bare probe") == "true"
        except Exception:  # noqa: BLE001
            bare = False
        if bare:
            raise SnapshotError("bare_repository", f"{start} is a bare repository; a review candidate needs a working tree") from None
        raise SnapshotError("not_a_repository", f"{start} is not inside a git repository") from None
    root = os.path.realpath(toplevel, strict=True)
    git_dir = os.path.realpath(_one_line(run_git(cwd=root, args=["rev-parse", "--absolute-git-dir"], timeout_ms=bound["timeoutMs"]).stdout, "git dir"), strict=True)
    common = _one_line(run_git(cwd=root, args=["rev-parse", "--git-common-dir"], timeout_ms=bound["timeoutMs"]).stdout, "git common dir")
    common_dir = os.path.realpath(common if os.path.isabs(common) else os.path.abspath(js_join(root, common)), strict=True)
    return {"root": root, "gitDir": git_dir, "commonDir": common_dir}


# ---------------------------------------------------------------------------------------------
# trees
# ---------------------------------------------------------------------------------------------

_REF_BAD = re.compile("[\u0000-\u001f\u007f]")


def _validate_ref(ref: object, what: str) -> str:
    if not isinstance(ref, str):
        raise SnapshotError("invalid_target", f"{what} must be a string")
    value = js_trim(ref)
    if value == "" or value.startswith("-") or ".." in value or _REF_BAD.search(value):
        raise SnapshotError("invalid_target", f"{what} must be exactly one revision (not a range or option)")
    return value


def _resolve_tree(repo: dict, rev: str, bound: dict) -> str:
    try:
        return _oid(run_git(cwd=repo["root"], args=["rev-parse", "--verify", f"{rev}^{{tree}}"], timeout_ms=bound["timeoutMs"]).stdout, "tree id")
    except SnapshotError as error:
        if error.code == "git_failed":
            raise SnapshotError("unknown_revision", f"cannot resolve {js_stringify(rev)} to a tree", exit_code=error.exit_code) from None
        raise


def _empty_tree(repo: dict, bound: dict) -> str:
    return _oid(run_git(cwd=repo["root"], args=["mktree"], timeout_ms=bound["timeoutMs"], input="").stdout, "empty tree id")


def _resolve_head_base(repo: dict, bound: dict) -> tuple[str, bool]:
    """HEAD's tree, or the empty tree plus `unborn` when HEAD names a branch that has no commit yet."""
    try:
        return _oid(run_git(cwd=repo["root"], args=["rev-parse", "--verify", "HEAD^{tree}"], timeout_ms=bound["timeoutMs"]).stdout, "tree id"), False
    except SnapshotError as error:
        if error.code != "git_failed":
            raise
    try:
        ref = _one_line(run_git(cwd=repo["root"], args=["symbolic-ref", "--quiet", "HEAD"], timeout_ms=bound["timeoutMs"]).stdout, "HEAD ref")
    except Exception:  # noqa: BLE001
        raise SnapshotError("unknown_revision", "cannot resolve HEAD to a tree") from None
    if not ref.startswith("refs/heads/") or ref == "refs/heads/":
        raise SnapshotError("unknown_revision", "cannot resolve HEAD to a tree")
    exists = run_git(cwd=repo["root"], args=["show-ref", "--verify", "--quiet", "--", ref], timeout_ms=bound["timeoutMs"], ok_exit=[0, 1])
    if exists.exit_code == 0:
        raise SnapshotError("unknown_revision", "cannot resolve HEAD to a tree")
    return _empty_tree(repo, bound), True


def _changed_paths(repo: dict, base_tree: str, candidate_tree: str, bound: dict) -> list[str]:
    out = run_git(
        cwd=repo["root"],
        args=["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", "--no-renames", "--ignore-submodules=none", base_tree, candidate_tree],
        timeout_ms=bound["timeoutMs"],
        limit=INVENTORY_LIMIT,
    ).stdout
    return sorted((normalize_logical_path(decode_name(r, "changed path")) for r in nul_records(out)), key=_utf8)


_TREE_HEADER = re.compile(r"([0-9]{6}) ([A-Za-z0-9_]+) ([0-9a-f]+) +([0-9]+|-)")


def _list_tree_entries(repo: dict, tree: str, bound: dict) -> dict[str, dict]:
    out = run_git(cwd=repo["root"], args=["ls-tree", "-r", "-t", "-l", "-z", tree], timeout_ms=bound["timeoutMs"], limit=INVENTORY_LIMIT).stdout
    entries: dict[str, dict] = {}
    for record in nul_records(out):
        tab = record.find(9)
        header = "" if tab < 0 else record[:tab].decode("utf-8", "replace")
        m = _TREE_HEADER.fullmatch(header)
        if not m:
            raise SnapshotError("corrupt_output", "unexpected tree entry")
        entries[decode_name(record[tab + 1 :], "tree path")] = {"mode": m[1], "type": m[2], "oid": m[3], "size": None if m[4] == "-" else int(m[4])}
    return entries


# ---------------------------------------------------------------------------------------------
# hashes
# ---------------------------------------------------------------------------------------------


def digest_paths(paths: list[str]) -> str:
    return domain_hash("paths", 1, list(paths))


def verify_intended_files(repo: dict, candidate_tree: str, intended: list[str], options: dict | None = None) -> None:
    """Post-build verification (closes the check-then-`git add` window): every intended path must STILL be a regular,
    single-link file whose current content hashes (with the same clean filters `git add` applies) to the blob the
    candidate tree holds. A swap to a hardlink, symlink or different content after the pre-add check is refused."""
    if len(intended) == 0:
        return
    bound = bound_of(options)
    entries = _list_tree_entries(repo, candidate_tree, bound)
    for path in intended:
        entry = entries.get(path)
        if entry is None:
            raise _refuse("missing", path, "is absent from the candidate tree")
        full = js_join(repo["root"], *path.split("/"))
        try:
            info = os.lstat(full)
        except OSError:
            raise _refuse("changed", path, "disappeared after the candidate tree was built") from None
        if stat.S_ISLNK(info.st_mode):
            raise _refuse("symlink", path, "became a symbolic link after the pre-add check")
        if not stat.S_ISREG(info.st_mode):
            raise _refuse("not_regular", path, "is no longer a regular file")
        if info.st_nlink > 1:
            raise _refuse("hardlink", path, "has more than one hard link after the pre-add check")
        actual = _oid(run_git(cwd=repo["root"], args=["hash-object", "--", full], timeout_ms=bound["timeoutMs"]).stdout, "file object id")
        if actual != entry["oid"]:
            raise _refuse("changed", path, "changed after the candidate tree was built")


def intended_untracked_proof(repo: dict, candidate_tree: str, intended: list[str], options: dict | None = None) -> str:
    """Proof that each intended path is a regular blob of the candidate tree (path, mode, object id)."""
    return _untracked_proof(repo, candidate_tree, intended, bound_of(options))


def _untracked_proof(repo: dict, candidate_tree: str, intended: list[str], bound: dict) -> str:
    if len(intended) == 0:
        return domain_hash("intended-untracked", 1, [])
    entries = _list_tree_entries(repo, candidate_tree, bound)
    proof = []
    total = 0
    for path in intended:
        entry = entries.get(path)
        if entry is None:
            raise _refuse("missing", path, "is absent from the candidate tree")
        if entry["type"] != "blob" or entry["mode"] not in ("100644", "100755"):
            raise _refuse("not_regular_in_tree", path, "is not a regular file in the candidate tree")
        # The size limit is re-checked on the frozen blob: the file could have been swapped after the pre-add check.
        size = entry["size"] or 0
        total += size
        if size > MAX_INTENDED_UNTRACKED_FILE_BYTES:
            raise _refuse("too_large", path, f"is {size} bytes in the candidate tree (limit {MAX_INTENDED_UNTRACKED_FILE_BYTES})")
        if total > MAX_INTENDED_UNTRACKED_TOTAL_BYTES:
            raise _refuse("too_large", path, f"pushes the list past {MAX_INTENDED_UNTRACKED_TOTAL_BYTES} bytes in the candidate tree")
        proof.append({"mode": entry["mode"], "oid": entry["oid"], "path": path})
    return domain_hash("intended-untracked", 1, proof)


def snapshot_identity(kind: str, projection: str, base_tree: str, candidate_tree: str, paths_digest: str) -> str:
    """Content-addressed identity. kind and projection stay in the domain on purpose (a current-changes receipt must never
    match an overlay review of identical bytes); the intended-untracked list and its proof describe HOW bytes were declared,
    not WHAT they are, so they stay out of the identity."""
    payload = {"kind": kind, "baseTree": base_tree, "candidateTree": candidate_tree, "pathsDigest": paths_digest}
    if kind == "base-workspace-overlay":
        return domain_hash("review-snapshot-base-workspace-overlay", 2, payload)
    if projection == "staged":
        return domain_hash("review-snapshot", 4, {**payload, "projection": projection})
    return domain_hash("review-snapshot", 3, payload)


# ---------------------------------------------------------------------------------------------
# changed lines
# ---------------------------------------------------------------------------------------------


def is_generated_golden_path(path: str) -> bool:
    return "/testdata/golden/" in f"/{path}" and path.endswith(".golden")


def _digits(s: str) -> bool:
    return s != "" and all("0" <= c <= "9" for c in s)


def count_changed_lines(repo: dict, base_tree: str, candidate_tree: str, options: dict | None = None) -> int:
    """Authored changed lines between two trees: numstat additions + deletions. Binary entries ("-") and generated golden files
    count 0, as does a mode-only change (numstat reports 0/0). Rename-aware credit is not applied (conservative upper bound)."""
    if not _is_oid(base_tree) or not _is_oid(candidate_tree):
        raise SnapshotError("invalid_target", "tree ids must be full hexadecimal object ids")
    bound = bound_of(options)

    def diff(cwd: str, env: dict) -> bytes:
        return run_git(
            cwd=cwd,
            env=env,
            args=["diff", "--numstat", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", "--ignore-submodules=none", base_tree, candidate_tree, "--"],
            timeout_ms=bound["timeoutMs"],
            limit=INVENTORY_LIMIT,
        ).stdout

    out = _with_isolated_git(repo, base_tree, diff)
    seen: set[str] = set()
    total = 0
    for record in nul_records(out):
        text = decode_name(record, "diff stat record")
        first = text.find("\t")
        second = -1 if first < 0 else text.find("\t", first + 1)
        if first < 0 or second < 0:
            raise SnapshotError("corrupt_output", "unexpected diff stat record")
        additions = text[:first]
        deletions = text[first + 1 : second]
        path = normalize_logical_path(text[second + 1 :])
        if path in seen:
            raise SnapshotError("corrupt_output", f"duplicate diff stat path {js_stringify(path)}")
        seen.add(path)
        if additions == "-" and deletions == "-":
            continue
        if not _digits(additions) or not _digits(deletions):
            raise SnapshotError("corrupt_output", "unexpected diff stat counts")
        if is_generated_golden_path(path):
            continue
        total += int(additions) + int(deletions)
    return total


# ---------------------------------------------------------------------------------------------
# candidate from the index / workspace
# ---------------------------------------------------------------------------------------------


def _read_real_index(path: str) -> tuple[bytes, int, int] | None:
    try:
        fd = os.open(path, os.O_RDONLY)
    except FileNotFoundError:
        return None
    try:
        before = os.fstat(fd)
        chunks = []
        while chunk := os.read(fd, 1 << 20):
            chunks.append(chunk)
        content = b"".join(chunks)
        after = os.fstat(fd)
        if before.st_size != after.st_size or before.st_mtime_ns != after.st_mtime_ns or len(content) != after.st_size:
            raise SnapshotError("index_changed", "the real index changed while being copied")
        return content, after.st_atime_ns, after.st_mtime_ns
    finally:
        os.close(fd)


def _tmpdir() -> str:
    """Node's `os.tmpdir()`."""
    p = os.environ.get("TMPDIR") or os.environ.get("TMP") or os.environ.get("TEMP") or "/tmp"
    return p[:-1] if len(p) > 1 and p.endswith("/") else p


def _make_scratch(repo: dict) -> str:
    for base in (_tmpdir(), repo["gitDir"]):
        try:
            d = tempfile.mkdtemp(prefix=_SCRATCH_PREFIX, dir=base)
            fd = os.open(os.path.join(d, "owner.json"), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w") as f:
                f.write(json.dumps({"pid": os.getpid()}, separators=(",", ":")))
            return d
        except OSError:
            continue
    raise SnapshotError("scratch_unavailable", "no writable location for a private review index")


def _sweep_stale_scratch(repo: dict) -> None:
    """Bounded best-effort sweep of private index copies a killed process left behind. Only plain directories we own, named
    like our scratch, older than STALE_SCRATCH_MS, whose recorded owner pid is dead (or unrecorded) and that hold nothing but
    our own files are removed. The real index is never a candidate: it is not a directory with that prefix."""
    uid = os.getuid()
    now = time.time() * 1000
    examined = 0
    for base in dict.fromkeys([_tmpdir(), repo["gitDir"]]):
        try:
            entries = [n for n in _listdir(base) if n.startswith(_SCRATCH_PREFIX)]
        except OSError:
            continue
        for name in entries:
            if examined >= _MAX_SWEEP_ENTRIES:
                return
            examined += 1
            d = os.path.join(base, name)
            try:
                info = os.lstat(d)
                if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
                    continue
                if info.st_uid != uid:
                    continue
                if now - info.st_mtime_ns / 1e6 < STALE_SCRATCH_MS:
                    continue
                if any(n not in _SCRATCH_ALLOWED for n in os.listdir(d)):
                    continue
                try:
                    with open(os.path.join(d, "owner.json"), encoding="utf-8", errors="replace") as f:
                        pid = js_json_loads(f.read()).get("pid")
                except Exception:  # noqa: BLE001
                    pid = None
                if isinstance(pid, (int, float)) and not isinstance(pid, bool) and float(pid).is_integer() and pid > 0 and is_pid_alive(pid):
                    continue
                shutil.rmtree(d, ignore_errors=True)
            except Exception:  # noqa: BLE001
                continue


def _reject_active_graft(repo: dict) -> None:
    """Refuse while a repository-local graft can substitute a commit's true parent (shared across worktrees)."""
    path = js_join(repo["commonDir"], "info", "grafts")
    try:
        with open(path, "rb") as f:
            content = f.read().decode("utf-8", "replace")
    except FileNotFoundError:
        return
    except OSError:
        raise SnapshotError("corrupt_output", f"cannot read repository-local graft file {path}") from None
    for line in content.split("\n"):
        t = js_trim(line[:-1] if line.endswith("\r") else line)
        if t != "" and not t.startswith("#"):
            raise SnapshotError("local_graft_active", f"repository-local graft file {path} is active and can change the base tree; remove it before freezing a snapshot")


def _write(path: str, text: str) -> None:
    with open(path, "w", encoding="utf-8", errors="surrogatepass") as f:
        f.write(text)


def _with_isolated_git(repo: dict, tree_id: str, fn):
    """Runs `fn(cwd, env)` against a scratch bare git dir that borrows the real object store through alternates and carries
    no config, attributes, grafts or index, so results depend only on the trees named."""
    objects = js_join(repo["commonDir"], "objects")
    if "\n" in objects:
        raise SnapshotError("corrupt_output", "object directory path contains a newline")
    scratch = _make_scratch(repo)
    try:
        git_dir = js_join(scratch, "git")
        os.makedirs(js_join(git_dir, "objects", "info"), exist_ok=True)
        os.mkdir(js_join(git_dir, "refs"))
        os.mkdir(js_join(git_dir, "info"))
        _write(js_join(git_dir, "HEAD"), "ref: refs/heads/frozen-context\n")
        _write(js_join(git_dir, "info", "attributes"), "")
        sha256 = len(tree_id) == 64
        _write(
            js_join(git_dir, "config"),
            f"[core]\n\trepositoryformatversion = {1 if sha256 else 0}\n\tbare = true\n\tattributesFile = /dev/null\n{'[extensions]' + chr(10) + chr(9) + 'objectFormat = sha256' + chr(10) if sha256 else ''}",
        )
        _write(js_join(git_dir, "objects", "info", "alternates"), f"{objects}\n")
        return fn(scratch, {"GIT_DIR": git_dir, "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_ATTR_NOSYSTEM": "1"})
    finally:
        shutil.rmtree(scratch, ignore_errors=True)


def _build_index_candidate(repo: dict, projection: str, intended: list[str], bound: dict) -> tuple[str, str]:
    t = bound["timeoutMs"]
    root = repo["root"]
    index_path = os.path.abspath(os.path.join(root, _one_line(run_git(cwd=root, args=["rev-parse", "--git-path", "index"], timeout_ms=t).stdout, "index path")))
    real = _read_real_index(index_path)
    precompose = (
        projection == "workspace"
        and len(intended) > 0
        and js_trim(run_git(cwd=root, args=["config", "--type=bool", "--get", "core.precomposeunicode"], timeout_ms=t, ok_exit=[0, 1]).stdout.decode("utf-8", "replace")) == "true"
    )
    if projection == "workspace":
        _check_intended_files(root, intended, precompose)

    scratch = _make_scratch(repo)
    try:
        temp_index = js_join(scratch, "index")
        env = {"GIT_INDEX_FILE": temp_index}
        if real is None:
            run_git(cwd=root, args=["read-tree", "--empty"], timeout_ms=t, env=env)
        else:
            content, atime_ns, mtime_ns = real
            fd = os.open(temp_index, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "wb") as f:
                f.write(content)
            # Keep the real index timestamp: git's racily-clean check compares entry times with it.
            os.utime(temp_index, ns=(atime_ns, mtime_ns))
        if projection == "workspace":
            cached = run_git(cwd=root, args=["ls-files", "--cached", "-z"], timeout_ms=t, env=env, limit=INVENTORY_LIMIT).stdout
            tracked = {decode_name(r, "index path") for r in nul_records(cached)}
            for path in intended:
                if path in tracked:
                    raise _refuse("tracked", path, "is already tracked")
            if len(intended) > 0:
                ignored = run_git(cwd=root, args=["check-ignore", "-z", "--stdin", "--no-index"], timeout_ms=t, env=env, input="\0".join(intended) + "\0", ok_exit=[0, 1])
                ignored_set = {decode_name(r, "ignored path") for r in nul_records(ignored.stdout)}
                for path in intended:
                    if path in ignored_set:
                        raise _refuse("ignored", path, "is ignored")
            if len(tracked) > 0:
                budget = min(MAX_GIT_TIMEOUT_MS, max(t, len(tracked) * 25))
                run_git(cwd=root, args=["add", "-u", "--", "."], timeout_ms=budget, env=env, limit=INVENTORY_LIMIT)
            if len(intended) > 0:
                specs = "\0".join(f":(literal){p}" for p in intended)
                run_git(cwd=root, args=["add", "--pathspec-from-file=-", "--pathspec-file-nul"], timeout_ms=t, env=env, input=specs)
        candidate_tree = _oid(run_git(cwd=root, args=["write-tree"], timeout_ms=t, env=env).stdout, "candidate tree id")
        proof = _untracked_proof(repo, candidate_tree, intended, bound)
        if projection == "workspace":
            verify_intended_files(repo, candidate_tree, intended, {"gitTimeoutMs": t})
        return candidate_tree, proof
    finally:
        shutil.rmtree(scratch, ignore_errors=True)


# ---------------------------------------------------------------------------------------------
# public entry point
# ---------------------------------------------------------------------------------------------


def _validate_target(target: object) -> tuple[str, list[str], str | None]:
    if not isinstance(target, (dict, list)):
        raise SnapshotError("invalid_target", "target must be an object")
    raw = target if isinstance(target, dict) else {}  # a JS array is an object without these keys
    intended_raw = raw.get("intendedUntracked", _MISSING)
    if intended_raw is not _MISSING and (not isinstance(intended_raw, list) or any(not isinstance(v, str) for v in intended_raw)):
        raise SnapshotError("invalid_target", "intendedUntracked must be a list of strings")
    intended_list = [] if intended_raw is _MISSING else intended_raw
    kind = raw.get("kind", _MISSING)
    if kind == "base-diff" and isinstance(kind, str):
        if len(intended_list) > 0:
            raise SnapshotError("invalid_target", "a committed-only base-diff does not accept intended-untracked paths")
        return "workspace", [], _validate_ref(raw.get("baseRef"), "baseRef")
    if kind == "base-workspace-overlay" and isinstance(kind, str):
        return "workspace", _canonical_paths(intended_list), _validate_ref(raw.get("baseRef"), "baseRef")
    if kind == "current-changes" and isinstance(kind, str):
        projection = raw.get("projection")
        if projection is None:
            projection = "workspace"
        if projection not in ("workspace", "staged") or not isinstance(projection, str):
            raise SnapshotError("invalid_target", f"unsupported projection {_js_str(projection)}")
        intended = _canonical_paths(intended_list)
        if projection == "staged" and len(intended) > 0:
            raise _refuse("staged_projection", intended[0], "is not accepted by the staged projection")
        return projection, intended, None
    raise SnapshotError("invalid_target", f"unsupported target kind {_js_str(kind)}")


def freeze_snapshot(cwd: str, target: dict, options: dict | None = None) -> dict:
    bound = bound_of(options)
    projection, intended, base_ref = _validate_target(target)
    repo = resolve_repository(cwd, options)
    kind = target["kind"]
    _sweep_stale_scratch(repo)
    _reject_active_graft(repo)

    unborn_head = False
    if kind == "base-diff":
        base_tree = _resolve_tree(repo, base_ref, bound)
        head_tree, unborn = _resolve_head_base(repo, bound)
        if unborn:
            raise SnapshotError("unborn_head", "a committed-only base-diff needs a commit at HEAD")
        candidate_tree = head_tree
        proof = domain_hash("intended-untracked", 1, [])
    elif kind == "base-workspace-overlay":
        base_tree = _resolve_tree(repo, base_ref, bound)
        candidate_tree, proof = _build_index_candidate(repo, "workspace", intended, bound)
    else:
        base_tree, unborn_head = _resolve_head_base(repo, bound)
        candidate_tree, proof = _build_index_candidate(repo, projection, intended, bound)

    paths = _changed_paths(repo, base_tree, candidate_tree, bound)
    if len(paths) == 0:
        return {"status": "empty", "repository": repo, "kind": kind, "projection": projection, "baseTree": base_tree, "candidateTree": candidate_tree}
    changed_lines = count_changed_lines(repo, base_tree, candidate_tree, options)
    paths_digest = digest_paths(paths)
    return {
        "status": "frozen",
        "repository": repo,
        "snapshot": {
            "kind": kind,
            "projection": projection,
            "unbornHead": unborn_head,
            "baseTree": base_tree,
            "candidateTree": candidate_tree,
            "paths": paths,
            "pathsDigest": paths_digest,
            "intendedUntracked": intended,
            "intendedUntrackedProof": proof,
            "changedLines": changed_lines,
            "identity": snapshot_identity(kind, projection, base_tree, candidate_tree, paths_digest),
        },
    }
