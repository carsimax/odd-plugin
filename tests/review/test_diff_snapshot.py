"""Differential: review/snapshot against v9 dist/review/snapshot.js through the oracle, on real temp git repos shared by both
sides (same cwd, same environment: GIT_CONFIG_NOSYSTEM=1, fixed author/committer). Every exported function is compared; the
byte-level ones (`decodeName`, `nulRecords`, `runGit` output) go through a small node script that loads the same compiled module."""
import json
import os
import random
import shutil
import subprocess
import tempfile

import pytest

from lib.v9_oracle import DIST, needs_v9, v9_many
from odd_claude.review import snapshot as S
from review.conftest import diff_cases, py_oracle_err
from review.test_snapshot import CLEAN_ENV, Fixture, _hermetic_git_env, git, plumb_tree, write  # noqa: F401

pytestmark = needs_v9
MOD = "review/snapshot"
V9_ENV = {"GIT_CONFIG_NOSYSTEM": "1"}


@pytest.fixture(autouse=True)
def _fixed_identity(monkeypatch):
    for k in ("GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_AUTHOR_DATE", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "GIT_COMMITTER_DATE"):
        monkeypatch.setenv(k, CLEAN_ENV[k])  # py side only matters for tests that commit; git() passes its own env


@pytest.fixture
def make_repo():
    made: list[Fixture] = []

    def make(commit: bool = True) -> Fixture:
        f = Fixture(commit)
        made.append(f)
        return f

    yield make
    for f in made:
        f.cleanup()


def py_run_git(call: dict):
    out = S.run_git(cwd=call["cwd"], args=call["args"], timeout_ms=call["timeoutMs"], env=call.get("env"), input=call.get("input"), ok_exit=call.get("okExit"), limit=call.get("limit"))
    return {"stdout": {"type": "Buffer", "data": list(out.stdout)}, "exitCode": out.exit_code}


def same(fn: str, py_fn, calls: list[list], env: dict | None = None) -> None:
    diff_cases(MOD, fn, py_fn, calls, env={**V9_ENV, **(env or {})})


T = {"kind": "current-changes"}
STAGED = {"kind": "current-changes", "projection": "staged"}


def targets(intended: list[str] | None = None) -> list[dict]:
    out = [
        T, STAGED, {**T, "projection": "workspace"}, {**T, "projection": None}, {**T, "projection": "bogus"}, {**T, "projection": 1},
        {"kind": "base-diff", "baseRef": "HEAD"}, {"kind": "base-diff", "baseRef": "HEAD~1"}, {"kind": "base-diff", "baseRef": " HEAD "}, {"kind": "base-diff", "baseRef": "HEAD^{tree}"},
        {"kind": "base-diff", "baseRef": "nope"}, {"kind": "base-diff", "baseRef": "a..b"}, {"kind": "base-diff", "baseRef": "-x"}, {"kind": "base-diff", "baseRef": "a\u0001b"}, {"kind": "base-diff"},
        {"kind": "base-diff", "baseRef": 5}, {"kind": "base-diff", "baseRef": "HEAD", "intendedUntracked": ["x"]}, {"kind": "base-diff", "baseRef": "HEAD", "intendedUntracked": []},
        {"kind": "base-workspace-overlay", "baseRef": "HEAD"}, {"kind": "base-workspace-overlay", "baseRef": "HEAD~1"}, {"kind": "base-workspace-overlay", "baseRef": "nope"},
        {"kind": "base-workspace-overlay"}, {"kind": "nope"}, {}, [], None, "x", 5, {"kind": 5}, {**T, "intendedUntracked": None}, {**T, "intendedUntracked": "a"}, {**T, "intendedUntracked": [1]},
    ]
    if intended:
        out += [
            {**T, "intendedUntracked": intended}, {**T, "intendedUntracked": list(reversed(intended))}, {**STAGED, "intendedUntracked": intended}, {"kind": "base-workspace-overlay", "baseRef": "HEAD", "intendedUntracked": intended},
            {**T, "intendedUntracked": intended[:1]}, {**T, "intendedUntracked": intended + intended[:1]},
        ]
    return out


def freeze_calls(repo: str, intended: list[str] | None = None) -> list[list]:
    return [[repo, t] for t in targets(intended)] + [[repo, T, {"gitTimeoutMs": 60000}], [repo, T, {"gitTimeoutMs": 1}], [repo, T, {"gitTimeoutMs": None}]]


def check_freeze(repo: str, intended: list[str] | None = None) -> None:
    same("freezeSnapshot", S.freeze_snapshot, freeze_calls(repo, intended))


def commit_all(repo: str, msg: str = "c") -> None:
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", msg)


# ---- freezeSnapshot over repository states ----


def test_freeze_clean_and_edited_repository(make_repo):
    f = make_repo()
    check_freeze(f.repo)
    write(f.p("a.txt"), "one\nTWO\nthree\n")
    os.unlink(f.p("b.txt"))
    write(f.p("c.txt"), "new\n")
    git(f.repo, "add", "c.txt")
    write(f.p("listed.txt"), "l\n")
    write(f.p("sub", "deep.txt"), "d\n")
    check_freeze(f.repo, ["sub/deep.txt", "listed.txt"])


def test_freeze_staged_vs_workspace_and_second_commit(make_repo):
    f = make_repo()
    write(f.p("a.txt"), "second\n")
    commit_all(f.repo)
    write(f.p("a.txt"), "staged\n")
    git(f.repo, "add", "a.txt")
    write(f.p("a.txt"), "workspace\n")
    write(f.p("b.txt"), "unstaged\n")
    write(f.p("u.txt"), "u\n")
    check_freeze(f.repo, ["u.txt"])


def test_freeze_unborn_head_and_missing_or_ita_index(make_repo):
    f = make_repo(commit=False)
    check_freeze(f.repo)
    write(f.p("first.txt"), "hello\n")
    git(f.repo, "add", "first.txt")
    write(f.p("loose.txt"), "l\n")
    check_freeze(f.repo, ["loose.txt"])
    g = make_repo()
    os.unlink(g.p(".git", "index"))
    check_freeze(g.repo)
    h = make_repo()
    write(h.p("ita.txt"), "ita\n")
    git(h.repo, "add", "-N", "ita.txt")
    check_freeze(h.repo)


def test_freeze_hostile_and_unicode_names(make_repo):
    f = make_repo()
    names = ["with space.txt", "new\nline.txt", "ünï ☃ 😀.txt", "-dash.txt", ":(top)magic.txt", "glob*.txt", "[br].txt", "tab\there.txt", 'quote"s.txt', "emoji/😀/dir file.txt", "～.txt", "\U0001f600.txt", "﻿bom.txt", "‮RTL.txt", "ﬁ.txt", "back\\slash.txt", "日本語/ファイル.txt"]
    for n in names:
        write(f.p(n), f"{n}\n")
    git(f.repo, "add", "--", names[0], names[1], names[-1])
    git(f.repo, "commit", "-q", "-m", "h")
    for n in (names[0], names[1], names[-1]):
        write(f.p(n), "changed\n")
    untracked = [n for n in names if n not in (names[0], names[1], names[-1])]
    check_freeze(f.repo, untracked)
    # individual refusals on odd names
    odd = ["a\\b", "a//b", "a/./b", "../x", "/abs", ".git/x", "x/.GIT/y", "é.txt", "x\0y", "", "NUL", "a/", "dir", "nope"]
    same("freezeSnapshot", S.freeze_snapshot, [[f.repo, {**T, "intendedUntracked": [o]}] for o in odd])


def test_freeze_symlinks_hardlinks_and_dirlinks(make_repo):
    f = make_repo()
    os.symlink("a.txt", f.p("ln"))
    commit_all(f.repo)
    os.unlink(f.p("ln"))
    os.symlink("b.txt", f.p("ln"))
    outside = os.path.join(f.dir, "outside.txt")
    write(outside, "secret\n")
    os.symlink(outside, f.p("link.txt"))
    write(os.path.join(f.dir, "elsewhere", "f.txt"), "x\n")
    os.symlink(os.path.join(f.dir, "elsewhere"), f.p("dirlink"))
    os.link(outside, f.p("hard.txt"))
    write(f.p("adir", "x.txt"), "x\n")
    for p in (["link.txt"], ["dirlink/f.txt"], ["hard.txt"], ["adir"], ["adir/x.txt"], ["ln"], ["adir/x.txt", "link.txt"]):
        same("freezeSnapshot", S.freeze_snapshot, [[f.repo, {**T, "intendedUntracked": p}]])
    check_freeze(f.repo, ["adir/x.txt"])


def test_freeze_submodule_like_directories(make_repo):
    f = make_repo()
    nested = f.p("vendor", "lib")
    os.makedirs(nested)
    git(nested, "init", "-q", "-b", "main")
    write(os.path.join(nested, "x.txt"), "x\n")
    commit_all(nested)
    check_freeze(f.repo, ["vendor/lib", "vendor/lib/x.txt"])
    git(f.repo, "add", "vendor/lib")
    check_freeze(f.repo, ["vendor/lib/x.txt"])
    commit_all(f.repo)
    write(os.path.join(nested, "y.txt"), "y\n")
    commit_all(nested)
    check_freeze(f.repo, ["vendor/lib/y.txt"])
    # a gitlink recorded with no checked-out directory
    g = make_repo()
    git(g.repo, "update-index", "--add", "--cacheinfo", f"160000,{git(g.repo, 'rev-parse', 'HEAD').strip()},ghost")
    git(g.repo, "commit", "-q", "-m", "ghost")
    check_freeze(g.repo)


def test_freeze_counts_binary_modes_golden_and_attributes(make_repo):
    f = make_repo()
    write(f.p("bin.dat"), bytes([0, 1, 2, 0, 3]))
    write(f.p(".gitattributes"), "*.gen -diff\n")
    commit_all(f.repo)
    write(f.p("bin.dat"), bytes([9, 9, 0, 9]))
    write(f.p("a.txt"), "".join(f"line {i}\n" for i in range(503)))
    os.chmod(f.p("b.txt"), 0o755)
    write(f.p("x.gen"), "g\n" * 20)
    write(f.p("pkg", "testdata", "golden", "x.golden"), "g\n" * 50)
    write(f.p(".git", "info", "attributes"), "*.txt binary\n")
    git(f.repo, "config", "diff.algorithm", "histogram")
    check_freeze(f.repo, ["x.gen", "pkg/testdata/golden/x.golden"])


def test_freeze_refusals_ignored_tracked_size_and_outside(make_repo):
    f = make_repo()
    write(f.p(".gitignore"), "*.log\n")
    commit_all(f.repo)
    write(f.p("x.log"), "log\n")
    write(f.p("big.bin"), b"\x01" * (S.MAX_INTENDED_UNTRACKED_FILE_BYTES + 1))
    write(f.p("fits.bin"), b"\x01" * S.MAX_INTENDED_UNTRACKED_FILE_BYTES)
    write(f.p("Mixed.txt"), "m\n")
    write(f.p("sub", "f.txt"), "f\n")
    for p in (["x.log"], ["a.txt"], ["big.bin"], ["fits.bin"], ["Mixed.txt"], ["mixed.txt"], ["SUB/f.txt"], ["sub/F.TXT"], ["sub"], ["sub/f.txt"], ["fits.bin", "sub/f.txt"]):
        same("freezeSnapshot", S.freeze_snapshot, [[f.repo, {**T, "intendedUntracked": p}], [f.repo, {**STAGED, "intendedUntracked": p}]])


def test_freeze_total_size_and_count_limits(make_repo):
    f = make_repo()
    for i in range(17):
        write(f.p(f"m{i:02d}.bin"), bytes([i + 1]) * S.MAX_INTENDED_UNTRACKED_FILE_BYTES)
    exact = [f"m{i:02d}.bin" for i in range(16)]
    same("freezeSnapshot", S.freeze_snapshot, [[f.repo, {**T, "intendedUntracked": exact}], [f.repo, {**T, "intendedUntracked": exact + ["m16.bin"]}]])
    g = make_repo()
    names = [f"many/f{i:04d}.txt" for i in range(1001)]
    for n in names:
        write(g.p(n), "x\n")
    same("freezeSnapshot", S.freeze_snapshot, [[g.repo, {**T, "intendedUntracked": names[:999]}], [g.repo, {**T, "intendedUntracked": names[:1000]}], [g.repo, {**T, "intendedUntracked": names}]])


def test_freeze_large_tracked_inventory(make_repo):
    f = make_repo()
    for i in range(1500):
        write(f.p("inv", f"d{i % 30}", f"file{i:05d}.txt"), f"v{i}\n")
    commit_all(f.repo)
    for i in range(0, 1500, 2):
        write(f.p("inv", f"d{i % 30}", f"file{i:05d}.txt"), f"w{i}\nmore\n")
    for i in range(1, 1500, 7):
        os.unlink(f.p("inv", f"d{i % 30}", f"file{i:05d}.txt"))
    same("freezeSnapshot", S.freeze_snapshot, [[f.repo, T], [f.repo, STAGED], [f.repo, {"kind": "base-workspace-overlay", "baseRef": "HEAD~1"}]])


def test_freeze_non_utf8_names(make_repo):
    f = make_repo()
    bad = plumb_tree(f.repo, [{"mode": "100644", "type": "blob", "content": b"x\n", "name": bytes([0x62, 0xFF, 0x2E, 0x74])}])
    ok = plumb_tree(f.repo, [{"mode": "100644", "type": "blob", "content": b"x\n", "name": "ok.t".encode()}])
    commit = git(f.repo, "commit-tree", bad, "-m", "bad").strip()
    git(f.repo, "update-ref", "refs/heads/bad", commit)
    same("freezeSnapshot", S.freeze_snapshot, [[f.repo, {"kind": "base-diff", "baseRef": bad}], [f.repo, {"kind": "base-diff", "baseRef": ok}], [f.repo, {"kind": "base-diff", "baseRef": "bad"}], [f.repo, {"kind": "base-workspace-overlay", "baseRef": bad}]])
    git(f.repo, "symbolic-ref", "HEAD", "refs/heads/bad")
    git(f.repo, "read-tree", "HEAD")  # index (and HEAD) hold the non-UTF-8 name, the worktree does not
    same("freezeSnapshot", S.freeze_snapshot, [[f.repo, T], [f.repo, STAGED], [f.repo, {"kind": "base-diff", "baseRef": ok}]])
    # a name of valid but unusual UTF-8 (overlong-looking, noncharacters, max code point)
    g = make_repo()
    odd = plumb_tree(g.repo, [{"mode": "100644", "type": "blob", "content": b"x\n", "name": "﷐\U0010ffff.t".encode()}])
    same("freezeSnapshot", S.freeze_snapshot, [[g.repo, {"kind": "base-diff", "baseRef": odd}], [g.repo, {"kind": "base-workspace-overlay", "baseRef": odd}]])


def test_freeze_grafts_linked_worktree_bare_and_non_repositories(make_repo):
    f = make_repo()
    wt = os.path.join(f.dir, "linked")
    git(f.repo, "worktree", "add", "-q", "-b", "feature", wt)
    write(os.path.join(wt, "a.txt"), "linked\n")
    write(os.path.join(wt, "n.txt"), "n\n")
    git(wt, "add", "b.txt")
    os.makedirs(os.path.join(wt, "sub", "deeper"))
    link = os.path.join(f.dir, "viasym")
    os.symlink(wt, link)
    calls = [[c, t] for c in (wt, os.path.join(wt, "sub", "deeper"), link, f.repo) for t in (T, STAGED, {**T, "intendedUntracked": ["n.txt"]})]
    same("freezeSnapshot", S.freeze_snapshot, calls)
    same("resolveRepository", S.resolve_repository, [[c] for c in (wt, os.path.join(wt, "sub"), link, f.repo, f.p(".git"), f.p(".git", "objects"))])
    bare = os.path.join(f.dir, "bare.git")
    git(f.dir, "init", "-q", "--bare", bare)
    empty = os.path.join(f.dir, "plain")
    os.mkdir(empty)
    afile = os.path.join(f.dir, "afile")
    write(afile, "x")
    same("resolveRepository", S.resolve_repository, [[bare], [empty], [os.path.join(f.dir, "missing")], [afile], [""], [None], [5], ["a\0b"], [[]], [f.repo, {"gitTimeoutMs": 1}]])
    same("freezeSnapshot", S.freeze_snapshot, [[bare, T], [empty, T], [afile, T]])
    head = git(f.repo, "rev-parse", "HEAD").strip()
    write(f.p(".git", "info", "grafts"), "# c\n\r\n  \n")
    write(f.p("a.txt"), "x\n")
    same("freezeSnapshot", S.freeze_snapshot, [[f.repo, T], [wt, T]])
    write(f.p(".git", "info", "grafts"), f"# c\n{head}\r\n")
    same("freezeSnapshot", S.freeze_snapshot, [[f.repo, T], [wt, T], [f.repo, {"kind": "base-diff", "baseRef": "HEAD"}], [f.repo, STAGED]])
    os.unlink(f.p(".git", "info", "grafts"))
    os.mkdir(f.p(".git", "info", "grafts"))  # unreadable as a file
    same("freezeSnapshot", S.freeze_snapshot, [[f.repo, T]])


def test_freeze_scratch_fallback_when_tmpdir_is_unusable_and_stale_sweep(make_repo, monkeypatch):
    f = make_repo()
    write(f.p("a.txt"), "x\n")
    gd = f.p(".git")
    import time

    for name, owner, extra in ((".odd-review-index-s", {"pid": 99999999}, ["index"]), (".odd-review-index-n", None, ["index"]), (".odd-review-index-f", {"pid": 99999999}, ["index", "precious"])):
        d = os.path.join(gd, name)
        os.mkdir(d)
        for n in extra:
            write(os.path.join(d, n), "x")
        if owner:
            write(os.path.join(d, "owner.json"), json.dumps(owner))
        t = time.time() - 3600
        os.utime(d, (t, t))
    monkeypatch.setenv("TMPDIR", "/nonexistent-odd-dir")
    same("freezeSnapshot", S.freeze_snapshot, [[f.repo, T], [f.repo, {**T, "intendedUntracked": []}]], env={"TMPDIR": "/nonexistent-odd-dir"})
    assert os.path.isdir(os.path.join(gd, ".odd-review-index-f")) and not os.path.exists(os.path.join(gd, ".odd-review-index-s"))
    assert not any(n.startswith(".odd-review-index-") and n not in (".odd-review-index-f",) for n in os.listdir(gd))


def test_freeze_with_caller_git_variables_in_the_environment(make_repo, monkeypatch):
    f = make_repo()
    other = make_repo()
    write(f.p("a.txt"), "edited\n")
    env = {"GIT_INDEX_FILE": os.path.join(f.dir, "bogus"), "GIT_DIR": other.p(".git"), "GIT_WORK_TREE": other.repo, "GIT_OBJECT_DIRECTORY": other.p(".git", "objects"), "GIT_NAMESPACE": "x", "LC_ALL": "de_DE.UTF-8"}
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    same("freezeSnapshot", S.freeze_snapshot, [[f.repo, T], [f.repo, STAGED]], env=env)
    same("resolveRepository", S.resolve_repository, [[f.repo]], env=env)
    assert not os.path.exists(env["GIT_INDEX_FILE"])


def test_freeze_sha256_repository(make_repo):
    d = os.path.realpath(tempfile.mkdtemp(prefix="odd-sha256-"))
    try:
        r = subprocess.run(["git", "init", "-q", "--object-format=sha256", "-b", "main", d], env=CLEAN_ENV, capture_output=True)
        if r.returncode != 0:
            pytest.skip("git without sha256 support")
        write(os.path.join(d, "a.txt"), "one\n")
        commit_all(d)
        write(os.path.join(d, "a.txt"), "two\n")
        write(os.path.join(d, "u.txt"), "u\n")
        same("freezeSnapshot", S.freeze_snapshot, [[d, T], [d, {**T, "intendedUntracked": ["u.txt"]}], [d, STAGED], [d, {"kind": "base-diff", "baseRef": "HEAD"}]])
    finally:
        shutil.rmtree(d, ignore_errors=True)


# ---- the remaining exported functions ----


def test_resolve_repository_relative_cwd(make_repo, monkeypatch):
    f = make_repo()
    os.makedirs(f.p("sub", "deeper"))
    for rel in (".", "sub", "sub/deeper", "../repo/sub", "sub/../sub"):
        monkeypatch.chdir(f.repo)
        want = v9_many(MOD, "resolveRepository", [[rel]], env=V9_ENV, cwd=f.repo)[0]
        assert py_oracle_err(S.resolve_repository, rel) == want, rel


def test_normalize_logical_path_over_odd_values():
    values = ["a", "a/b", "a b/c", "new\nline", "é/ü", "\U0001f600", "\ud800", "", "/a", "a/", "a//b", ".", "..", "a/./b", "a/../b", "a\\b", "a\0b", "...", "a/...", " ", "a/ /b", None, 5, 1.5, True, ["a"], {"a": 1}, "x" * 5000, "﻿", "a b"]
    same("normalizeLogicalPath", S.normalize_logical_path, [[v] for v in values])


def test_digest_paths_identity_and_golden_helpers():
    path_lists = [[], ["a"], ["a", "b"], ["b", "a"], ["é", "😀", "～"], ["a\nb"], ["a\"b", "\\"], [""] * 3, ["\ud800"]]
    same("digestPaths", S.digest_paths, [[p] for p in path_lists])
    kinds = ["current-changes", "base-diff", "base-workspace-overlay", "other"]
    projs = ["workspace", "staged", "x"]
    trees = [("a" * 40, "b" * 40, "sha256:" + "c" * 64), ("", "", ""), ("é", "😀", "x")]
    same("snapshotIdentity", S.snapshot_identity, [[k, p, *t] for k in kinds for p in projs for t in trees])
    paths = ["a.golden", "testdata/golden/x.golden", "pkg/testdata/golden/x.golden", "pkg/testdata/golden/x.txt", "mytestdata/golden/x.golden", "testdata/golden/.golden", "/testdata/golden/x.golden", "a/testdata/golden/b/c.golden", "TESTDATA/golden/x.golden", ""]
    same("isGeneratedGoldenPath", S.is_generated_golden_path, [[p] for p in paths])
    same("boundOf", S.bound_of, [[{}], [{"gitTimeoutMs": 5}], [{"gitTimeoutMs": 0}], [{"gitTimeoutMs": None}], [{"gitTimeoutMs": 2.5}], [{"x": 1}]])


def test_tree_functions_count_changed_lines_proof_and_verify(make_repo):
    f = make_repo()
    repo = S.resolve_repository(f.repo)
    base = git(f.repo, "rev-parse", "HEAD^{tree}").strip()
    write(f.p("a.txt"), "".join(f"l{i}\n" for i in range(40)))
    write(f.p("bin.dat"), bytes([0, 1, 0]))
    write(f.p("ok.bin"), b"\x07" * 100)
    write(f.p("fits.bin"), b"\x07" * S.MAX_INTENDED_UNTRACKED_FILE_BYTES)
    write(f.p("pkg", "testdata", "golden", "g.golden"), "g\n" * 9)
    snap = S.freeze_snapshot(f.repo, {**T, "intendedUntracked": ["bin.dat", "ok.bin", "fits.bin", "pkg/testdata/golden/g.golden"]})["snapshot"]
    cand = snap["candidateTree"]
    big = plumb_tree(f.repo, [{"mode": "100644", "type": "blob", "content": b"\x07" * (S.MAX_INTENDED_UNTRACKED_FILE_BYTES + 1), "name": b"big.bin"}])
    link = plumb_tree(f.repo, [{"mode": "120000", "type": "blob", "content": b"/etc/passwd", "name": b"l"}, {"mode": "100755", "type": "blob", "content": b"x", "name": b"x.sh"}])
    empty = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
    sha256_tree = "a" * 64
    lines = [[repo, base, cand], [repo, base, base], [repo, cand, base], [repo, empty, cand], [repo, "HEAD", cand], [repo, base, "x"], [repo, 5, cand], [repo, base, cand, {"gitTimeoutMs": 60000}],
             [repo, base, "b" * 40], [repo, "b" * 40, "c" * 40], [repo, base, sha256_tree], [repo, "A" * 40, cand], [repo, base, cand, {"gitTimeoutMs": 1}]]
    same("countChangedLines", S.count_changed_lines, lines)
    intended_sets = [[], ["ok.bin"], ["fits.bin", "ok.bin"], ["bin.dat"], ["absent"], ["pkg/testdata/golden/g.golden", "ok.bin"], ["ok.bin", "ok.bin"]]
    proofs = [[repo, t, i] for t in (cand, big, link, empty) for i in intended_sets + [["big.bin"], ["l"], ["x.sh"], ["l", "x.sh"], ["a.txt"]]]
    same("intendedUntrackedProof", S.intended_untracked_proof, proofs)
    verifies = [[repo, t, i] for t in (cand, big, link) for i in intended_sets + [["big.bin"], ["l"], ["x.sh"]]]
    same("verifyIntendedFiles", S.verify_intended_files, verifies)
    # post-freeze swaps
    os.unlink(f.p("ok.bin"))
    os.symlink("a.txt", f.p("ok.bin"))
    write(f.p("bin.dat"), "changed")
    os.unlink(f.p("fits.bin"))
    same("verifyIntendedFiles", S.verify_intended_files, [[repo, cand, [p]] for p in ("ok.bin", "bin.dat", "fits.bin", "pkg/testdata/golden/g.golden")])


# ---- byte-level functions and the git runner ----

_BYTES_JS = r"""
const [url, fn, payload] = process.argv.slice(1);
const m = await import(url);
const out = [];
for (const [hex, what] of JSON.parse(payload)) {
  const b = Buffer.from(hex, "hex");
  try {
    const r = fn === "nulRecords" ? m.nulRecords(b).map((x) => Buffer.from(x).toString("hex")) : m.decodeName(new Uint8Array(b), what);
    out.push({ ok: r });
  } catch (e) { out.push({ err: e.message, code: e.code }); }
}
process.stdout.write(JSON.stringify(out));
"""


def v9_bytes(fn: str, cases: list[tuple[bytes, str]]) -> list:
    url = (DIST / "review" / "snapshot.js").as_uri()
    r = subprocess.run(["node", "--input-type=module", "-e", _BYTES_JS, url, fn, json.dumps([[b.hex(), w] for b, w in cases])], capture_output=True, text=True, timeout=120)
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout)


def random_utf8_like(rng: random.Random) -> bytes:
    pool = [b"a", b"\x00", b"\xc3\xa9", b"\xe2\x82\xac", b"\xf0\x9f\x98\x80", b"\xef\xbb\xbf", b"\xff", b"\xc0\x80", b"\xed\xa0\x80", b"\xed\xbf\xbf", b"\xf4\x90\x80\x80", b"\xe2\x82", b"\xf0\x9f\x98", b"\x80", b"\xc3", b"\xf8\x88\x80\x80\x80", b"\xef\xbf\xbe", b"\xef\xbf\xbd", b"\xee\x80\x80", b"\xf4\x8f\xbf\xbf"]
    return b"".join(rng.choice(pool) for _ in range(rng.randint(0, 6)))


def test_decode_name_matches_v9_on_valid_and_invalid_utf8():
    rng = random.Random(7)
    cases = [(bytes([i]), "x") for i in range(256)] + [(random_utf8_like(rng), "changed path") for _ in range(1500)]
    want = v9_bytes("decodeName", cases)
    for (b, what), w in zip(cases, want):
        try:
            got = {"ok": S.decode_name(b, what)}
        except S.SnapshotError as e:
            got = {"err": str(e), "code": e.code}
        assert got == w, f"{b!r}: python={got!r} v9={w!r}"


def test_nul_records_matches_v9():
    rng = random.Random(11)
    cases = [(b"", ""), (b"\0", ""), (b"\0\0", ""), (b"a", ""), (b"a\0", ""), (b"a\0b", ""), (b"a\0\0b\0", ""), (b"\0a\0", ""), (b"\xff\0\xfe\0", "")]
    cases += [(bytes(rng.choice([0, 0, 97, 98, 255, 10]) for _ in range(rng.randint(0, 12))), "") for _ in range(500)]
    want = v9_bytes("nulRecords", cases)
    for (b, _), w in zip(cases, want):
        try:
            got = {"ok": [r.hex() for r in S.nul_records(b)]}
        except S.SnapshotError as e:
            got = {"err": str(e), "code": e.code}
        assert got == w, f"{b!r}: python={got!r} v9={w!r}"


def test_run_git_matches_v9(make_repo):
    f = make_repo()
    write(f.p("a.txt"), "edited\n")
    c = f.repo
    calls = [
        [{"cwd": c, "args": ["rev-parse", "HEAD"], "timeoutMs": 5000}],
        [{"cwd": c, "args": ["rev-parse", "--verify", "nope^{tree}"], "timeoutMs": 5000}],
        [{"cwd": c, "args": ["rev-parse", "--verify", "nope^{tree}"], "timeoutMs": 5000, "okExit": [0, 128]}],
        [{"cwd": c, "args": ["rev-parse", "--verify", "nope^{tree}"], "timeoutMs": 5000, "okExit": []}],
        [{"cwd": c, "args": ["rev-parse", "HEAD"], "timeoutMs": 5000, "okExit": [128]}],
        [{"cwd": c, "args": ["hash-object", "--stdin"], "timeoutMs": 5000, "input": "héllo \U0001f600\n"}],
        [{"cwd": c, "args": ["hash-object", "--stdin"], "timeoutMs": 5000, "input": ""}],
        [{"cwd": c, "args": ["hash-object", "--stdin"], "timeoutMs": 5000, "input": "\ud800"}],
        [{"cwd": c, "args": ["hash-object", "--stdin"], "timeoutMs": 5000, "input": "a😀b\udc00"}],
        [{"cwd": c, "args": ["rev-parse", "HEAD"], "timeoutMs": 5000, "limit": 5}],
        [{"cwd": c, "args": ["rev-parse", "HEAD"], "timeoutMs": 5000, "limit": 40}],
        [{"cwd": c, "args": ["rev-parse", "HEAD"], "timeoutMs": 5000, "limit": 41}],
        [{"cwd": c, "args": ["diff", "--numstat"], "timeoutMs": 5000, "limit": 1}],
        [{"cwd": c, "args": [], "timeoutMs": 5000}],
        [{"cwd": c, "args": ["no-such-command"], "timeoutMs": 5000}],
        [{"cwd": c, "args": ["status", "--porcelain=v1"], "timeoutMs": 0}],
        [{"cwd": c, "args": ["status", "--porcelain=v1"], "timeoutMs": 1}],
        [{"cwd": c, "args": ["rev-parse", "HEAD"], "timeoutMs": 999999999}],
        [{"cwd": c, "args": ["rev-parse", "--git-path", "index"], "timeoutMs": 5000, "env": {"GIT_INDEX_FILE": "/x/y"}}],
        [{"cwd": c, "args": ["rev-parse", "--is-inside-work-tree"], "timeoutMs": 5000, "env": {"GIT_DIR": "/nonexistent"}}],
        [{"cwd": os.path.join(c, "nope"), "args": ["status"], "timeoutMs": 5000}],
        [{"cwd": c, "args": ["config", "--type=bool", "--get", "core.precomposeunicode"], "timeoutMs": 5000, "okExit": [0, 1]}],
        [{"cwd": c, "args": ["cat-file", "--batch-check"], "timeoutMs": 5000, "input": "HEAD\nnope\n"}],
        [{"cwd": c, "args": ["diff-tree", "-p", "HEAD", "HEAD"], "timeoutMs": 5000}],
    ]
    same("runGit", py_run_git, calls)


def test_run_git_with_a_fake_git(tmp_path, monkeypatch):
    d = str(tmp_path)

    def script(name: str, body: str) -> str:
        sub = os.path.join(d, name)
        os.mkdir(sub)
        p = os.path.join(sub, "git")
        with open(p, "w") as fh:
            fh.write("#!/bin/sh\n" + body + "\n")
        os.chmod(p, 0o755)
        return sub

    cases = {
        "sleep": "sleep 5 >/dev/null 2>&1 </dev/null",
        "killed": "kill -9 $$",
        "segv": "kill -11 $$",
        "term": "kill -15 $$",
        "bigerr": "head -c 5000 /dev/zero | tr '\\0' 'e' >&2; exit 3",
        "utf8err": "printf 'x\\303\\251\\377\\360\\237\\230\\200z \\n\\n' >&2; exit 4",
        "spaceerr": "printf '  \\n\\t \\n' >&2; exit 5",
        "bigout": "head -c 100000 /dev/zero",
        "exit0err": "echo warn >&2",
    }
    paths = {k: script(k, v) for k, v in cases.items()}
    base_path = os.environ["PATH"]
    for name, sub in paths.items():
        monkeypatch.setenv("PATH", f"{sub}:{base_path}")
        calls = [[{"cwd": d, "args": ["status"], "timeoutMs": 400}], [{"cwd": d, "args": ["x"], "timeoutMs": 5000, "okExit": [0, 3, 4, 5]}], [{"cwd": d, "args": ["y"], "timeoutMs": 5000, "limit": 1000}]]
        want = v9_many(MOD, "runGit", calls, env={**V9_ENV, "PATH": f"{sub}:{base_path}"})
        for args, w in zip(calls, want):
            got = py_oracle_err(py_run_git, *args)
            if name in ("bigout", "exit0err") and isinstance(w, dict) and "stdout" in w:
                assert got == w, f"{name}: {args}"
            else:
                assert got == w, f"{name}: {args}: python={got!r} v9={w!r}"
    only_node = os.path.join(d, "only-node")  # a PATH with node but without git
    os.mkdir(only_node)
    os.symlink(shutil.which("node"), os.path.join(only_node, "node"))
    monkeypatch.setenv("PATH", only_node)
    want = v9_many(MOD, "runGit", [[{"cwd": d, "args": ["status"], "timeoutMs": 500}]], env={**V9_ENV, "PATH": only_node})
    assert want[0] == {"__error__": "git executable not found"}
    assert py_oracle_err(py_run_git, {"cwd": d, "args": ["status"], "timeoutMs": 500}) == want[0]
