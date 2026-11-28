"""Port of v9 review/snapshot.spec.ts (38 tests) plus extra cases for the Python-specific git runner."""
import hashlib
import os
import shutil
import stat
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest

from odd_claude.review import snapshot as S
from odd_claude.review.canonical import domain_hash
from odd_claude.review.snapshot import (
    MAX_INTENDED_UNTRACKED_FILE_BYTES,
    SnapshotError,
    count_changed_lines,
    digest_paths,
    freeze_snapshot,
    intended_untracked_proof,
    normalize_logical_path,
    resolve_repository,
    run_git,
    snapshot_identity,
    verify_intended_files,
)

# ---- helpers: real temp git repos, always removed in teardown ----


def clean_env() -> dict:
    env = {k: v for k, v in os.environ.items() if not k.upper().startswith("GIT_")}
    env.update({
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t.invalid", "GIT_AUTHOR_DATE": "2020-01-01T00:00:00Z",
        "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t.invalid", "GIT_COMMITTER_DATE": "2020-01-01T00:00:00Z",
    })
    return env


CLEAN_ENV = clean_env()


def git(cwd, *args: str, input: bytes | None = None) -> str:
    r = subprocess.run(
        ["git", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", "-C", str(cwd), *args],
        env=CLEAN_ENV, capture_output=True, input=input,
    )
    if r.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed: {r.stderr.decode(errors='replace')}")
    return r.stdout.decode("utf-8", "replace")


def write(path, content: str | bytes) -> None:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(content.encode("utf-8") if isinstance(content, str) else content)


@pytest.fixture(autouse=True)
def _hermetic_git_env(monkeypatch):
    for k in [k for k in os.environ if k.upper().startswith("GIT_")]:
        monkeypatch.delenv(k)
    monkeypatch.setenv("GIT_CONFIG_NOSYSTEM", "1")


class Fixture:
    def __init__(self, commit: bool = True):
        self.dir = os.path.realpath(tempfile.mkdtemp(prefix="odd-snapshot-"))
        self.repo = os.path.join(self.dir, "repo")
        os.mkdir(self.repo)
        git(self.repo, "init", "-q", "-b", "main")
        if commit:
            write(os.path.join(self.repo, "a.txt"), "one\ntwo\nthree\n")
            write(os.path.join(self.repo, "b.txt"), "bee\n")
            git(self.repo, "add", "-A")
            git(self.repo, "commit", "-q", "-m", "init")

    def cleanup(self) -> None:
        shutil.rmtree(self.dir, ignore_errors=True)

    def p(self, *parts: str) -> str:
        return os.path.join(self.repo, *parts)


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


@pytest.fixture
def scratch():
    d = os.path.realpath(tempfile.mkdtemp(prefix="odd-snapshot-"))
    yield d
    shutil.rmtree(d, ignore_errors=True)


def frozen(result: dict) -> dict:
    assert result["status"] == "frozen"
    return result["snapshot"]


def sha(path) -> str:
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def user_state(repo: str) -> dict:
    """Hash of the real index, every file in the worktree (not .git) and the raw .git listing."""
    files: dict[str, str] = {}

    def walk(d: str, prefix: str) -> None:
        for name in sorted(os.listdir(d)):
            if name == ".git" and prefix == "":
                continue
            full = os.path.join(d, name)
            if os.path.isdir(full):
                walk(full, prefix + name + "/")
            elif os.path.exists(full):
                files[prefix + name] = sha(full)

    walk(repo, "")
    idx = os.path.join(repo, ".git", "index")
    return {
        "index": sha(idx) if os.path.exists(idx) else "absent",
        "indexMtime": os.stat(idx).st_mtime_ns if os.path.exists(idx) else 0,
        "files": files,
        "gitListing": sorted(os.listdir(os.path.join(repo, ".git"))),
    }


def expect_code(fn, code: str, reason: str | None = None) -> SnapshotError:
    with pytest.raises(SnapshotError) as ei:
        fn()
    assert ei.value.code == code, str(ei.value)
    if reason is not None:
        assert ei.value.reason == reason, str(ei.value)
    return ei.value


def blob(repo, tree: str, path: str) -> str:
    return git(repo, "cat-file", "blob", f"{tree}:{path}")


WORKSPACE = {"kind": "current-changes"}


def u8key(s: str) -> bytes:
    return s.encode("utf-8")


# ---- projections ----


def test_clean_repository_empty_diff_is_a_typed_result_not_a_snapshot(make_repo):
    f = make_repo()
    r = freeze_snapshot(f.repo, WORKSPACE)
    assert r["status"] == "empty"
    assert r["baseTree"] == r["candidateTree"]
    assert r["baseTree"] == git(f.repo, "rev-parse", "HEAD^{tree}").strip()
    assert r["kind"] == "current-changes"
    assert r["projection"] == "workspace"
    assert set(r) == {"status", "repository", "kind", "projection", "baseTree", "candidateTree"}
    assert freeze_snapshot(f.repo, {"kind": "current-changes", "projection": "staged"})["status"] == "empty"


def test_modified_tracked_file_workspace_snapshot_carries_every_mirrored_field(make_repo):
    f = make_repo()
    write(f.p("a.txt"), "one\nTWO\nthree\n")
    s = frozen(freeze_snapshot(f.repo, WORKSPACE))
    assert s["kind"] == "current-changes"
    assert s["projection"] == "workspace"
    assert s["unbornHead"] is False
    assert s["baseTree"] == git(f.repo, "rev-parse", "HEAD^{tree}").strip()
    assert s["candidateTree"] != s["baseTree"]
    assert s["paths"] == ["a.txt"]
    assert s["pathsDigest"] == domain_hash("paths", 1, ["a.txt"])
    assert s["pathsDigest"] == digest_paths(["a.txt"])
    assert s["intendedUntracked"] == []
    assert s["intendedUntrackedProof"] == domain_hash("intended-untracked", 1, [])
    assert s["changedLines"] == 2  # one line replaced = 1 addition + 1 deletion
    assert s["identity"] == domain_hash("review-snapshot", 3, {"kind": "current-changes", "baseTree": s["baseTree"], "candidateTree": s["candidateTree"], "pathsDigest": s["pathsDigest"]})
    assert s["identity"] == snapshot_identity("current-changes", "workspace", s["baseTree"], s["candidateTree"], s["pathsDigest"])
    assert blob(f.repo, s["candidateTree"], "a.txt") == "one\nTWO\nthree\n"
    assert set(s) == {"kind", "projection", "unbornHead", "baseTree", "candidateTree", "paths", "pathsDigest", "intendedUntracked", "intendedUntrackedProof", "changedLines", "identity"}
    r = freeze_snapshot(f.repo, WORKSPACE)
    assert r["status"] == "frozen" and r["repository"]["root"] == f.repo


def test_deletions_and_tracked_file_additions_in_the_index_are_part_of_the_workspace_candidate(make_repo):
    f = make_repo()
    os.unlink(f.p("b.txt"))
    write(f.p("c.txt"), "new\n")
    git(f.repo, "add", "c.txt")
    s = frozen(freeze_snapshot(f.repo, WORKSPACE))
    assert s["paths"] == ["b.txt", "c.txt"]
    assert s["changedLines"] == 2


def test_staged_and_workspace_projections_differ_and_use_distinct_identity_domains(make_repo):
    f = make_repo()
    write(f.p("a.txt"), "staged\n")
    git(f.repo, "add", "a.txt")
    write(f.p("a.txt"), "workspace\n")
    ws = frozen(freeze_snapshot(f.repo, {"kind": "current-changes", "projection": "workspace"}))
    st = frozen(freeze_snapshot(f.repo, {"kind": "current-changes", "projection": "staged"}))
    assert blob(f.repo, st["candidateTree"], "a.txt") == "staged\n"
    assert blob(f.repo, ws["candidateTree"], "a.txt") == "workspace\n"
    assert ws["candidateTree"] != st["candidateTree"]
    assert ws["identity"] != st["identity"]
    assert st["projection"] == "staged"
    assert st["identity"] == domain_hash("review-snapshot", 4, {"kind": "current-changes", "projection": "staged", "baseTree": st["baseTree"], "candidateTree": st["candidateTree"], "pathsDigest": st["pathsDigest"]})
    write(f.p("b.txt"), "unstaged only\n")  # staged ignores unstaged-only edits entirely
    st2 = frozen(freeze_snapshot(f.repo, {"kind": "current-changes", "projection": "staged"}))
    assert st2["paths"] == ["a.txt"]


def test_committed_only_base_diff_compares_base_ref_with_head_and_ignores_dirty_worktree_and_index(make_repo):
    f = make_repo()
    first = git(f.repo, "rev-parse", "HEAD").strip()
    write(f.p("a.txt"), "second\n")
    git(f.repo, "commit", "-q", "-am", "second")
    write(f.p("b.txt"), "dirty\n")
    write(f.p("untracked.txt"), "u\n")
    s = frozen(freeze_snapshot(f.repo, {"kind": "base-diff", "baseRef": first}))
    assert s["kind"] == "base-diff"
    assert s["projection"] == "workspace"
    assert s["baseTree"] == git(f.repo, "rev-parse", f"{first}^{{tree}}").strip()
    assert s["candidateTree"] == git(f.repo, "rev-parse", "HEAD^{tree}").strip()
    assert s["paths"] == ["a.txt"]
    assert s["changedLines"] == 4  # three lines replaced by one: 1 addition + 3 deletions
    assert s["identity"] == snapshot_identity("base-diff", "workspace", s["baseTree"], s["candidateTree"], s["pathsDigest"])
    # a tree id and a branch name resolve to the same base
    assert frozen(freeze_snapshot(f.repo, {"kind": "base-diff", "baseRef": "HEAD~1"}))["identity"] == s["identity"]
    assert frozen(freeze_snapshot(f.repo, {"kind": "base-diff", "baseRef": s["baseTree"]}))["identity"] == s["identity"]
    assert freeze_snapshot(f.repo, {"kind": "base-diff", "baseRef": "HEAD"})["status"] == "empty"


def test_base_diff_refuses_ranges_option_looking_refs_unknown_refs_and_intended_paths(make_repo):
    f = make_repo()
    expect_code(lambda: freeze_snapshot(f.repo, {"kind": "base-diff", "baseRef": "HEAD~1..HEAD"}), "invalid_target")
    expect_code(lambda: freeze_snapshot(f.repo, {"kind": "base-diff", "baseRef": "--output=/tmp/x"}), "invalid_target")
    expect_code(lambda: freeze_snapshot(f.repo, {"kind": "base-diff", "baseRef": "  "}), "invalid_target")
    expect_code(lambda: freeze_snapshot(f.repo, {"kind": "base-diff", "baseRef": "no-such-branch"}), "unknown_revision")
    expect_code(lambda: freeze_snapshot(f.repo, {"kind": "base-diff", "baseRef": "HEAD", "intendedUntracked": ["x"]}), "invalid_target")


def test_base_workspace_overlay_base_ref_vs_workspace_with_its_own_identity_domain(make_repo):
    f = make_repo()
    first = git(f.repo, "rev-parse", "HEAD").strip()
    write(f.p("a.txt"), "second\n")
    git(f.repo, "commit", "-q", "-am", "second")
    write(f.p("b.txt"), "dirty\n")
    o = frozen(freeze_snapshot(f.repo, {"kind": "base-workspace-overlay", "baseRef": first}))
    assert o["paths"] == ["a.txt", "b.txt"]
    assert o["identity"] == domain_hash("review-snapshot-base-workspace-overlay", 2, {"kind": "base-workspace-overlay", "baseTree": o["baseTree"], "candidateTree": o["candidateTree"], "pathsDigest": o["pathsDigest"]})
    cur = frozen(freeze_snapshot(f.repo, WORKSPACE))
    assert cur["identity"] != o["identity"]


def test_unborn_head_staged_files_diff_against_the_empty_tree_nothing_staged_is_empty(make_repo):
    f = make_repo(commit=False)
    assert freeze_snapshot(f.repo, {"kind": "current-changes", "projection": "staged"})["status"] == "empty"
    write(f.p("first.txt"), "hello\n")
    git(f.repo, "add", "first.txt")
    s = frozen(freeze_snapshot(f.repo, {"kind": "current-changes", "projection": "staged"}))
    assert s["unbornHead"] is True
    assert s["baseTree"] == "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
    assert s["paths"] == ["first.txt"]
    expect_code(lambda: freeze_snapshot(f.repo, {"kind": "base-diff", "baseRef": "HEAD"}), "unknown_revision")


# ---- untracked handling ----


def test_intended_untracked_is_included_only_when_listed_unlisted_untracked_files_stay_out(make_repo):
    f = make_repo()
    write(f.p("listed.txt"), "listed\n")
    write(f.p("sub", "deep.txt"), "deep\n")
    write(f.p("unlisted.txt"), "no\n")
    assert freeze_snapshot(f.repo, WORKSPACE)["status"] == "empty"
    s = frozen(freeze_snapshot(f.repo, {"kind": "current-changes", "intendedUntracked": ["sub/deep.txt", "listed.txt"]}))
    assert s["paths"] == ["listed.txt", "sub/deep.txt"]
    assert s["intendedUntracked"] == ["listed.txt", "sub/deep.txt"]
    assert "unlisted.txt" not in s["paths"]
    entries = []
    for p in ["listed.txt", "sub/deep.txt"]:
        line = git(f.repo, "ls-tree", s["candidateTree"], "--", p).strip()
        mode, _, rest = line.partition(" blob ")
        entries.append({"mode": mode, "oid": rest.split("\t")[0], "path": p})
    assert s["intendedUntrackedProof"] == domain_hash("intended-untracked", 1, entries)
    assert s["intendedUntrackedProof"] != domain_hash("intended-untracked", 1, [])
    swapped = frozen(freeze_snapshot(f.repo, {"kind": "current-changes", "intendedUntracked": ["listed.txt", "sub/deep.txt"]}))  # listing order is irrelevant
    assert swapped["identity"] == s["identity"]
    assert swapped["intendedUntrackedProof"] == s["intendedUntrackedProof"]
    write(f.p("a.txt"), "changed\n")  # tracked changes ride along
    both = frozen(freeze_snapshot(f.repo, {"kind": "current-changes", "intendedUntracked": ["listed.txt"]}))
    assert both["paths"] == ["a.txt", "listed.txt"]


def test_untracked_refusals_symlink_symlinked_dir_dotdot_absolute_outside_directory_missing_git_big_ignored_tracked_staged(make_repo):
    f = make_repo()
    outside = os.path.join(f.dir, "outside.txt")
    write(outside, "secret\n")
    os.symlink(outside, f.p("link.txt"))
    write(os.path.join(f.dir, "elsewhere", "f.txt"), "x\n")
    os.symlink(os.path.join(f.dir, "elsewhere"), f.p("dirlink"))
    write(f.p("adir", "x.txt"), "x\n")
    write(f.p("big.bin"), b"\x01" * (MAX_INTENDED_UNTRACKED_FILE_BYTES + 1))
    write(f.p(".gitignore"), "*.log\n")
    git(f.repo, "add", ".gitignore")
    git(f.repo, "commit", "-q", "-m", "ignore")
    write(f.p("x.log"), "log\n")
    before = user_state(f.repo)

    def t(paths):
        return lambda: freeze_snapshot(f.repo, {"kind": "current-changes", "intendedUntracked": paths})

    expect_code(t(["link.txt"]), "untracked_refused", "symlink")
    expect_code(t(["dirlink/f.txt"]), "untracked_refused", "symlink")
    expect_code(t(["../outside.txt"]), "invalid_path")
    expect_code(t(["adir/../adir/x.txt"]), "invalid_path")
    expect_code(t([outside]), "invalid_path")
    expect_code(t(["./adir/x.txt"]), "invalid_path")
    expect_code(t(["adir/"]), "invalid_path")
    expect_code(t(["a\\b"]), "invalid_path")
    expect_code(t(["adir", "adir"]), "invalid_path")
    expect_code(t(["adir"]), "untracked_refused", "not_regular")
    expect_code(t(["nope.txt"]), "untracked_refused", "missing")
    expect_code(t([".git/config"]), "invalid_path")
    expect_code(t(["big.bin"]), "untracked_refused", "too_large")
    expect_code(t(["x.log"]), "untracked_refused", "ignored")
    expect_code(t(["a.txt"]), "untracked_refused", "tracked")
    expect_code(lambda: freeze_snapshot(f.repo, {"kind": "current-changes", "projection": "staged", "intendedUntracked": ["adir/x.txt"]}), "untracked_refused", "staged_projection")
    assert user_state(f.repo) == before, "refusals must not touch the user's index or worktree"
    assert Path(outside).read_text() == "secret\n"


# ---- the user's state is never modified ----


def test_users_index_and_working_tree_are_byte_identical_across_every_projection(make_repo):
    f = make_repo()
    write(f.p("a.txt"), "edited\n")
    write(f.p("new.txt"), "new\n")
    write(f.p("staged.txt"), "s\n")
    git(f.repo, "add", "staged.txt")
    before = user_state(f.repo)
    frozen(freeze_snapshot(f.repo, {"kind": "current-changes", "intendedUntracked": ["new.txt"]}))
    frozen(freeze_snapshot(f.repo, {"kind": "current-changes", "projection": "staged"}))
    frozen(freeze_snapshot(f.repo, {"kind": "base-workspace-overlay", "baseRef": "HEAD", "intendedUntracked": ["new.txt"]}))
    assert freeze_snapshot(f.repo, {"kind": "base-diff", "baseRef": "HEAD"})["status"] == "empty"
    assert user_state(f.repo) == before
    assert not any("odd-review-index" in n for n in os.listdir(f.p(".git")))  # no scratch index left in the git dir


def test_missing_index_file_candidate_is_built_from_an_empty_index_and_no_index_is_created(make_repo):
    f = make_repo()
    os.unlink(f.p(".git", "index"))
    s = frozen(freeze_snapshot(f.repo, {"kind": "current-changes", "projection": "staged"}))
    assert sorted(s["paths"]) == ["a.txt", "b.txt"]  # everything looks deleted from an empty index
    assert not os.path.exists(f.p(".git", "index"))


def test_intent_to_add_entries_workspace_includes_the_content_the_real_index_stays_intact(make_repo):
    f = make_repo()
    write(f.p("ita.txt"), "ita\n")
    git(f.repo, "add", "-N", "ita.txt")
    before = user_state(f.repo)
    s = frozen(freeze_snapshot(f.repo, WORKSPACE))
    assert s["paths"] == ["ita.txt"]
    assert blob(f.repo, s["candidateTree"], "ita.txt") == "ita\n"
    assert user_state(f.repo) == before


# ---- environment hygiene ----


def test_caller_git_variables_do_not_leak_into_git_and_do_not_change_results(make_repo, monkeypatch):
    f = make_repo()
    other = make_repo()
    write(f.p("a.txt"), "edited\n")
    baseline = frozen(freeze_snapshot(f.repo, WORKSPACE))
    baseline_staged = freeze_snapshot(f.repo, {"kind": "current-changes", "projection": "staged"})
    bogus_index = os.path.join(f.dir, "bogus-index")
    monkeypatch.setenv("GIT_INDEX_FILE", bogus_index)
    monkeypatch.setenv("GIT_DIR", os.path.join(other.repo, ".git"))
    monkeypatch.setenv("GIT_WORK_TREE", other.repo)
    monkeypatch.setenv("GIT_OBJECT_DIRECTORY", os.path.join(other.repo, ".git", "objects"))
    monkeypatch.setenv("GIT_COMMON_DIR", os.path.join(other.repo, ".git"))
    monkeypatch.setenv("GIT_CEILING_DIRECTORIES", f.dir)
    monkeypatch.setenv("GIT_NAMESPACE", "x")
    before = user_state(f.repo)
    assert frozen(freeze_snapshot(f.repo, WORKSPACE)) == baseline
    assert freeze_snapshot(f.repo, {"kind": "current-changes", "projection": "staged"}) == baseline_staged
    assert not os.path.exists(bogus_index), "the caller's GIT_INDEX_FILE must never be created or written"
    assert user_state(f.repo) == before
    assert resolve_repository(f.repo)["root"] == f.repo


def test_a_hung_or_slow_git_is_cut_by_the_bounded_timeout_with_a_typed_error(make_repo):
    f = make_repo()
    write(f.p("a.txt"), "edited\n")
    expect_code(lambda: freeze_snapshot(f.repo, WORKSPACE, {"gitTimeoutMs": 1}), "git_timeout")


# ---- repository identity ----


def test_repository_identity_root_git_dir_and_common_dir_subdirectory_cwd_resolves_to_the_root(make_repo):
    f = make_repo()
    os.makedirs(f.p("sub", "deeper"))
    assert resolve_repository(f.p("sub", "deeper")) == {"root": f.repo, "gitDir": f.p(".git"), "commonDir": f.p(".git")}
    write(f.p("a.txt"), "edited\n")
    assert frozen(freeze_snapshot(f.p("sub"), WORKSPACE))["paths"] == ["a.txt"]


def test_not_a_repository_missing_directory_and_bare_repository_are_typed_errors(scratch):
    expect_code(lambda: resolve_repository(scratch), "not_a_repository")
    expect_code(lambda: resolve_repository(os.path.join(scratch, "missing")), "not_a_repository")
    expect_code(lambda: freeze_snapshot(scratch, WORKSPACE), "not_a_repository")
    bare = os.path.join(scratch, "bare.git")
    git(scratch, "init", "-q", "--bare", bare)
    expect_code(lambda: resolve_repository(bare), "bare_repository")
    expect_code(lambda: freeze_snapshot(scratch, {"kind": "nope"}), "invalid_target")
    expect_code(lambda: freeze_snapshot(scratch, {"kind": "current-changes", "projection": "bogus"}), "invalid_target")


def test_linked_worktrees_own_index_and_root_shared_common_dir_main_checkout_untouched(make_repo):
    f = make_repo()
    wt = os.path.join(f.dir, "linked")
    git(f.repo, "worktree", "add", "-q", "-b", "feature", wt)
    ident = resolve_repository(wt)
    assert ident["root"] == wt
    assert ident["commonDir"] == f.p(".git")
    assert ident["gitDir"] != ident["commonDir"]
    write(os.path.join(wt, "a.txt"), "linked edit\n")
    write(os.path.join(wt, "n.txt"), "n\n")
    git(wt, "add", "b.txt")
    main_before = user_state(f.repo)
    s = frozen(freeze_snapshot(wt, {"kind": "current-changes", "intendedUntracked": ["n.txt"]}))
    assert s["paths"] == ["a.txt", "n.txt"]
    assert blob(wt, s["candidateTree"], "a.txt") == "linked edit\n"
    staged = freeze_snapshot(wt, {"kind": "current-changes", "projection": "staged"})
    assert staged["status"] == "empty"  # b.txt staged but unchanged
    assert user_state(f.repo) == main_before
    assert freeze_snapshot(f.repo, WORKSPACE)["status"] == "empty"  # main checkout sees none of the linked edits


# ---- determinism and hostile names ----


def test_same_inputs_give_identical_results_different_content_gives_a_different_identity(make_repo):
    f = make_repo()
    write(f.p("a.txt"), "x\n")
    write(f.p("u.txt"), "u\n")
    target = {"kind": "current-changes", "intendedUntracked": ["u.txt"]}
    one = freeze_snapshot(f.repo, target)
    two = freeze_snapshot(f.repo, target)
    assert one == two
    write(f.p("a.txt"), "y\n")
    three = frozen(freeze_snapshot(f.repo, target))
    assert three["identity"] != frozen(one)["identity"]
    assert three["pathsDigest"] == frozen(one)["pathsDigest"]


def test_hostile_filenames_spaces_newlines_unicode_leading_dash_pathspec_magic_globs_round_trip(make_repo):
    f = make_repo()
    names = ["with space.txt", "new\nline.txt", "ünï ☃ 😀.txt", "-dash.txt", ":(top)magic.txt", "glob*.txt", "[br].txt", "tab\there.txt", 'quote"s.txt', "emoji/😀/dir file.txt"]
    for name in names:
        write(f.p(name), f"{name}\n")
    git(f.repo, "add", "--", "with space.txt", "new\nline.txt")  # two of them tracked first, then modified
    git(f.repo, "commit", "-q", "-m", "hostile")
    write(f.p("with space.txt"), "changed\n")
    write(f.p("new\nline.txt"), "changed\n")
    untracked = [n for n in names if n not in ("with space.txt", "new\nline.txt")]
    s = frozen(freeze_snapshot(f.repo, {"kind": "current-changes", "intendedUntracked": untracked}))
    assert s["paths"] == sorted(names, key=u8key)
    assert s["intendedUntracked"] == sorted(untracked, key=u8key)
    assert blob(f.repo, s["candidateTree"], "new\nline.txt") == "changed\n"
    assert blob(f.repo, s["candidateTree"], "glob*.txt") == "glob*.txt\n"
    assert blob(f.repo, s["candidateTree"], ":(top)magic.txt") == ":(top)magic.txt\n"
    write(f.p("globX.txt"), "no\n")  # an unlisted lookalike of a glob is not swept in
    assert "globX.txt" not in frozen(freeze_snapshot(f.repo, {"kind": "current-changes", "intendedUntracked": untracked}))["paths"]


def test_paths_sort_bytewise_on_utf8_not_by_utf16_code_unit(make_repo):
    f = make_repo()
    # U+FF5E (BMP, UTF-8 EF BD 9E) vs U+1F600 (astral, UTF-8 F0 9F 98 80): bytewise puts the BMP one first.
    bmp, astral = "～.txt", "\U0001f600.txt"
    write(f.p(bmp), "a\n")
    write(f.p(astral), "b\n")
    s = frozen(freeze_snapshot(f.repo, {"kind": "current-changes", "intendedUntracked": [astral, bmp]}))
    assert s["paths"] == [bmp, astral]


# ---- changed lines ----


def test_changed_lines_additions_plus_deletions_binary_and_mode_only_count_zero(make_repo):
    f = make_repo()
    write(f.p("bin.dat"), bytes([0, 1, 2, 0, 3]))
    git(f.repo, "add", "bin.dat")
    git(f.repo, "commit", "-q", "-m", "bin")
    base = frozen(freeze_snapshot(f.repo, {"kind": "base-diff", "baseRef": "HEAD~1"}))
    assert base["changedLines"] == 0, "a lone binary file counts zero lines"
    write(f.p("bin.dat"), bytes([9, 9, 0, 9]))
    write(f.p("a.txt"), "one\ntwo\nthree\nfour\nfive\n")  # +2
    os.chmod(f.p("b.txt"), 0o755)
    s = frozen(freeze_snapshot(f.repo, WORKSPACE))
    assert s["paths"] == ["a.txt", "b.txt", "bin.dat"]
    assert s["changedLines"] == 2
    repo = resolve_repository(f.repo)
    assert count_changed_lines(repo, s["baseTree"], s["candidateTree"]) == 2
    assert count_changed_lines(repo, s["baseTree"], s["baseTree"]) == 0
    expect_code(lambda: count_changed_lines(repo, "HEAD", s["candidateTree"]), "invalid_target")


def test_generated_golden_files_do_not_count_toward_changed_lines(make_repo):
    f = make_repo()
    write(f.p("pkg", "testdata", "golden", "x.golden"), "g\n" * 50)
    write(f.p("real.txt"), "r\n")
    s = frozen(freeze_snapshot(f.repo, {"kind": "current-changes", "intendedUntracked": ["pkg/testdata/golden/x.golden", "real.txt"]}))
    assert s["changedLines"] == 1


def test_normalize_logical_path_accepts_canonical_paths_only():
    assert normalize_logical_path("a/b c/d.txt") == "a/b c/d.txt"
    assert normalize_logical_path("new\nline") == "new\nline"
    for bad in ["", "/a", "a//b", "a/./b", "a/../b", "..", ".", "a/", "a\\b", "a\0b"]:
        expect_code(lambda: normalize_logical_path(bad), "invalid_path")


# ---- verifier findings F1-F7 ----


def lines(n: int) -> str:
    return "".join(f"line {i}\n" for i in range(n))


def test_f1_attributes_outside_the_frozen_trees_never_change_changed_lines_or_identity(make_repo):
    f = make_repo()
    write(f.p("a.txt"), lines(503))
    baseline = frozen(freeze_snapshot(f.repo, WORKSPACE))
    assert baseline["changedLines"] == 503 + 3
    write(f.p(".gitattributes"), "* -diff\n")  # untracked: not part of the candidate
    write(f.p(".git", "info", "attributes"), "*.txt binary\n")
    after = frozen(freeze_snapshot(f.repo, WORKSPACE))
    assert after["identity"] == baseline["identity"]
    assert after["changedLines"] == baseline["changedLines"]
    assert count_changed_lines(resolve_repository(f.repo), after["baseTree"], after["candidateTree"]) == 506


def test_f1_a_candidate_that_adds_txt_minus_diff_cannot_lower_its_own_count(make_repo):
    f = make_repo()
    write(f.p("a.txt"), lines(503))
    write(f.p(".gitattributes"), "*.txt -diff\n")
    git(f.repo, "add", ".gitattributes")
    s = frozen(freeze_snapshot(f.repo, WORKSPACE))
    assert s["paths"] == [".gitattributes", "a.txt"]
    assert s["changedLines"] == 503 + 3 + 1
    git(f.repo, "config", "diff.algorithm", "histogram")  # user config that changes diff behaviour is ignored as well
    assert frozen(freeze_snapshot(f.repo, WORKSPACE))["changedLines"] == 507


def test_f2_an_active_info_grafts_file_is_refused_an_empty_or_comment_only_one_is_not(make_repo):
    f = make_repo()
    write(f.p("a.txt"), "x\n")
    grafts = f.p(".git", "info", "grafts")
    write(grafts, "# nothing\n\n")
    assert frozen(freeze_snapshot(f.repo, WORKSPACE))["paths"][0] == "a.txt"
    head = git(f.repo, "rev-parse", "HEAD").strip()
    write(grafts, f"{head}\n")
    expect_code(lambda: freeze_snapshot(f.repo, WORKSPACE), "local_graft_active")
    expect_code(lambda: freeze_snapshot(f.repo, {"kind": "base-diff", "baseRef": "HEAD"}), "local_graft_active")


def test_f2_grafts_in_the_common_dir_are_refused_from_a_linked_worktree_too(make_repo):
    f = make_repo()
    wt = os.path.join(f.dir, "linked")
    git(f.repo, "worktree", "add", "-q", "-b", "feat", wt)
    write(f.p(".git", "info", "grafts"), git(f.repo, "rev-parse", "HEAD").strip() + "\n")
    write(os.path.join(wt, "a.txt"), "x\n")
    expect_code(lambda: freeze_snapshot(wt, WORKSPACE), "local_graft_active")


def test_f3_an_intended_untracked_hardlink_even_to_a_file_outside_the_repo_is_refused(make_repo):
    f = make_repo()
    outside = os.path.join(f.dir, "outside.txt")
    write(outside, "secret\n")
    os.link(outside, f.p("hard.txt"))
    before = user_state(f.repo)
    expect_code(lambda: freeze_snapshot(f.repo, {"kind": "current-changes", "intendedUntracked": ["hard.txt"]}), "untracked_refused", "hardlink")
    assert user_state(f.repo) == before


def plumb_tree(repo: str, entries: list[dict]) -> str:
    """Builds a tree holding `entries` directly through plumbing (no worktree involved)."""
    chunks = []
    for e in entries:
        oid = e.get("oid") or git(repo, "hash-object", "-w", "--stdin", input=e.get("content", b"")).strip()
        chunks.append(f"{e['mode']} {e['type']} {oid}\t".encode() + e["name"] + b"\0")
    return git(repo, "mktree", "-z", input=b"".join(chunks)).strip()


def test_f4_the_proof_checks_blob_size_and_mode_in_the_candidate_tree_not_the_pre_add_file(make_repo):
    f = make_repo()
    repo = resolve_repository(f.repo)
    big = plumb_tree(f.repo, [{"mode": "100644", "type": "blob", "content": bytes([7]) * (MAX_INTENDED_UNTRACKED_FILE_BYTES + 1), "name": b"big.bin"}])
    expect_code(lambda: intended_untracked_proof(repo, big, ["big.bin"]), "untracked_refused", "too_large")
    ok = plumb_tree(f.repo, [{"mode": "100644", "type": "blob", "content": bytes([7]) * MAX_INTENDED_UNTRACKED_FILE_BYTES, "name": b"fits.bin"}])
    import re

    assert re.fullmatch(r"sha256:[0-9a-f]{64}", intended_untracked_proof(repo, ok, ["fits.bin"]))
    link = plumb_tree(f.repo, [{"mode": "120000", "type": "blob", "content": b"/etc/passwd", "name": b"l"}])
    expect_code(lambda: intended_untracked_proof(repo, link, ["l"]), "untracked_refused", "not_regular_in_tree")
    expect_code(lambda: intended_untracked_proof(repo, ok, ["absent.bin"]), "untracked_refused", "missing")


def dead_pid() -> int:
    p = subprocess.Popen([sys.executable, "-c", "pass"])
    p.wait()
    return p.pid


def seed_scratch(base: str, name: str, owner, age_ms: float, extra=("index",)) -> str:
    import json
    import time

    d = os.path.join(base, name)
    os.mkdir(d)
    for n in extra:
        write(os.path.join(d, n), "x")
    if owner is not None:
        write(os.path.join(d, "owner.json"), json.dumps(owner))
    t = time.time() - age_ms / 1000
    os.utime(d, (t, t))
    return d


def test_f5_stale_private_index_copies_are_swept_live_fresh_and_foreign_ones_are_kept_real_index_untouched(make_repo):
    f = make_repo()
    git_dir = f.p(".git")
    hour = 3_600_000
    stale = seed_scratch(git_dir, ".odd-review-index-stale", {"pid": dead_pid()}, hour)
    no_owner = seed_scratch(git_dir, ".odd-review-index-noowner", None, hour)
    live = seed_scratch(git_dir, ".odd-review-index-live", {"pid": os.getpid()}, hour)
    fresh = seed_scratch(git_dir, ".odd-review-index-fresh", {"pid": dead_pid()}, 1000)
    foreign = seed_scratch(git_dir, ".odd-review-index-foreign", {"pid": dead_pid()}, hour, ["index", "precious.txt"])
    unrelated = seed_scratch(git_dir, "unrelated-dir", {"pid": dead_pid()}, hour)
    index_before = sha(os.path.join(git_dir, "index"))
    write(f.p("a.txt"), "x\n")
    frozen(freeze_snapshot(f.repo, WORKSPACE))
    assert not os.path.exists(stale)
    assert not os.path.exists(no_owner)
    assert os.path.exists(live)
    assert os.path.exists(fresh)
    assert os.path.exists(foreign), "directories with unexpected content are never removed"
    assert os.path.exists(unrelated)
    assert sha(os.path.join(git_dir, "index")) == index_before


def test_f5_a_symlink_named_like_a_scratch_dir_is_never_followed_or_removed(make_repo):
    f = make_repo()
    target = os.path.join(f.dir, "precious")
    os.mkdir(target)
    write(os.path.join(target, "index"), "keep")
    link = f.p(".git", ".odd-review-index-link")
    os.symlink(target, link)
    write(f.p("a.txt"), "x\n")
    frozen(freeze_snapshot(f.repo, WORKSPACE))
    assert Path(target, "index").read_text() == "keep"
    assert os.path.lexists(link)


def test_f6_wrong_case_and_non_nfc_spellings_are_refused_instead_of_frozen_under_the_callers_spelling(make_repo):
    f = make_repo()
    write(f.p("sub", "f.txt"), "f\n")
    write(f.p("Mixed.txt"), "m\n")

    def t(p):
        return lambda: freeze_snapshot(f.repo, {"kind": "current-changes", "intendedUntracked": [p]})

    for wrong in ["SUB/f.txt", "sub/F.TXT", "mixed.txt"]:
        e = expect_code(t(wrong), "untracked_refused")
        assert e.reason in ("name_mismatch", "missing"), f"{wrong}: {e.reason}"
    assert frozen(t("sub/f.txt")())["paths"] == ["sub/f.txt"]
    nfd, nfc = "é.txt", "é.txt"  # NFD spelling is refused outright; the NFC spelling works
    write(f.p(nfc), "e\n")
    expect_code(t(nfd), "invalid_path")
    assert frozen(t(nfc)())["paths"] == [nfc]


def test_f7_a_path_that_is_not_valid_utf8_fails_closed_instead_of_being_hashed_lossily(make_repo):
    f = make_repo()
    bad = plumb_tree(f.repo, [{"mode": "100644", "type": "blob", "content": b"x\n", "name": bytes([0x62, 0xFF, 0x2E, 0x74])}])
    expect_code(lambda: freeze_snapshot(f.repo, {"kind": "base-diff", "baseRef": bad}), "invalid_encoding")
    write(f.p("﻿bom.txt"), "b\n")  # a valid-UTF-8 name that starts with a BOM survives intact
    s = frozen(freeze_snapshot(f.repo, {"kind": "current-changes", "intendedUntracked": ["﻿bom.txt"]}))
    assert s["paths"] == ["﻿bom.txt"]


def test_r1_after_the_tree_is_built_a_file_swapped_for_a_hardlink_or_changed_content_is_refused(make_repo):
    f = make_repo()
    write(f.p("new.txt"), "inside\n")
    s = frozen(freeze_snapshot(f.repo, {"kind": "current-changes", "intendedUntracked": ["new.txt"]}))
    repo = resolve_repository(f.repo)
    verify_intended_files(repo, s["candidateTree"], ["new.txt"])  # unchanged file: verified
    write(f.p("new.txt"), "different\n")  # content changed after the freeze
    expect_code(lambda: verify_intended_files(repo, s["candidateTree"], ["new.txt"]), "untracked_refused", "changed")
    write(f.p("new.txt"), "inside\n")  # swapped for a hardlink to outside content (same bytes: only the link count gives it away)
    outside = os.path.join(f.dir, "outside.txt")
    write(outside, "inside\n")
    os.unlink(f.p("new.txt"))
    os.link(outside, f.p("new.txt"))
    expect_code(lambda: verify_intended_files(repo, s["candidateTree"], ["new.txt"]), "untracked_refused", "hardlink")
    os.unlink(f.p("new.txt"))  # swapped for a symlink
    os.symlink(outside, f.p("new.txt"))
    expect_code(lambda: verify_intended_files(repo, s["candidateTree"], ["new.txt"]), "untracked_refused", "symlink")


@pytest.mark.skipif(sys.platform != "darwin", reason="core.precomposeunicode and NFD/NFC normalization are macOS-only")
def test_r2_with_core_precomposeunicode_an_nfd_name_on_disk_is_frozen_under_its_nfc_path(make_repo):
    f = make_repo()
    git(f.repo, "config", "core.precomposeunicode", "true")  # explicit: the default differs per platform
    nfd, nfc = "café.txt", "café.txt"
    write(f.p(nfd), "c\n")
    if nfd not in os.listdir(f.repo):
        return  # the filesystem normalizes names itself
    s = frozen(freeze_snapshot(f.repo, {"kind": "current-changes", "intendedUntracked": [nfc]}))
    assert s["paths"] == [nfc]
    assert s["intendedUntracked"] == [nfc]
    expect_code(lambda: freeze_snapshot(f.repo, {"kind": "current-changes", "intendedUntracked": [nfd]}), "invalid_path")


def test_r2b_with_core_precomposeunicode_unset_git_exits_1_for_an_absent_key_the_snapshot_still_freezes_on_every_os(make_repo):
    f = make_repo()
    subprocess.run(["git", "-C", f.repo, "config", "--unset-all", "core.precomposeunicode"], env=CLEAN_ENV)  # exit 5 when already absent: fine
    absent = subprocess.run(["git", "-C", f.repo, "config", "--type=bool", "--get", "core.precomposeunicode"], env=CLEAN_ENV, capture_output=True)
    assert absent.returncode == 1
    write(f.p("new.txt"), "n\n")
    s = frozen(freeze_snapshot(f.repo, {"kind": "current-changes", "intendedUntracked": ["new.txt"]}))
    assert s["intendedUntracked"] == ["new.txt"]


def test_a2_a_timed_out_git_call_reports_the_per_call_bound_actually_applied(scratch, monkeypatch):
    bin_dir = os.path.join(scratch, "bin")
    os.mkdir(bin_dir)
    fake = os.path.join(bin_dir, "git")
    Path(fake).write_text("#!/bin/sh\nsleep 5 >/dev/null 2>&1 </dev/null\n")
    os.chmod(fake, 0o755)
    monkeypatch.setenv("PATH", f"{bin_dir}:{os.environ.get('PATH', '')}")
    started = __import__("time").monotonic()
    e = expect_code(lambda: run_git(cwd=scratch, args=["status"], timeout_ms=300), "git_timeout")
    assert str(e) == "git status timed out after 300ms"  # the per-call bound binds: its own value
    assert __import__("time").monotonic() - started < 4, "a timeout must not wait for the orphaned grandchild"


# ---- extra cases: the Python git runner, constants and helpers ----


def test_constants_match_v9():
    assert (S.DEFAULT_GIT_TIMEOUT_MS, S.MAX_GIT_TIMEOUT_MS, S.MAX_INTENDED_UNTRACKED_FILES) == (30_000, 300_000, 1000)
    assert (S.MAX_INTENDED_UNTRACKED_FILE_BYTES, S.MAX_INTENDED_UNTRACKED_TOTAL_BYTES) == (1024 * 1024, 16 * 1024 * 1024)
    assert (S.OUTPUT_LIMIT, S.INVENTORY_LIMIT, S.STALE_SCRATCH_MS) == (8 * 1024 * 1024, 64 * 1024 * 1024, 600_000)
    assert S.bound_of(None) == {"timeoutMs": 30_000} and S.bound_of({}) == {"timeoutMs": 30_000}
    assert S.bound_of({"gitTimeoutMs": 7}) == {"timeoutMs": 7}


def test_run_git_returns_stdout_and_exit_code_and_feeds_input(make_repo):
    f = make_repo()
    out = run_git(cwd=f.repo, args=["hash-object", "--stdin"], timeout_ms=5000, input="hello\n")
    assert out.exit_code == 0
    assert out.stdout.decode().strip() == git(f.repo, "hash-object", "--stdin", input=b"hello\n").strip()
    big = bytes(range(256)) * 1024  # larger than a pipe buffer, both directions
    out = run_git(cwd=f.repo, args=["hash-object", "-w", "--stdin"], timeout_ms=5000, input=big)
    assert len(out.stdout.decode().strip()) == 40
    cat = run_git(cwd=f.repo, args=["cat-file", "blob", out.stdout.decode().strip()], timeout_ms=5000)
    assert cat.stdout == big


def test_run_git_failure_ok_exit_and_stderr_snippet(make_repo):
    f = make_repo()
    e = expect_code(lambda: run_git(cwd=f.repo, args=["rev-parse", "--verify", "nope^{tree}"], timeout_ms=5000), "git_failed")
    assert str(e).startswith("git rev-parse failed with exit code 128: fatal: ")
    assert e.exit_code == 128
    assert run_git(cwd=f.repo, args=["rev-parse", "--verify", "nope^{tree}"], timeout_ms=5000, ok_exit=[0, 128]).exit_code == 128
    expect_code(lambda: run_git(cwd=f.repo, args=["rev-parse", "HEAD"], timeout_ms=5000, ok_exit=[]), "git_failed")


def test_run_git_output_over_the_limit_is_a_typed_error(make_repo):
    f = make_repo()
    e = expect_code(lambda: run_git(cwd=f.repo, args=["rev-parse", "HEAD"], timeout_ms=5000, limit=5), "git_output_limit")
    assert str(e) == "git rev-parse output exceeded the deterministic byte limit"
    assert run_git(cwd=f.repo, args=["rev-parse", "HEAD"], timeout_ms=5000, limit=41).exit_code == 0


def test_run_git_drops_caller_git_variables_and_forces_c_locale(make_repo, monkeypatch):
    f = make_repo()
    monkeypatch.setenv("GIT_DIR", "/nonexistent")
    monkeypatch.setenv("LC_ALL", "de_DE.UTF-8")
    assert run_git(cwd=f.repo, args=["rev-parse", "--show-toplevel"], timeout_ms=5000).stdout.decode().strip() == f.repo
    monkeypatch.undo()
    out = run_git(cwd=f.repo, args=["rev-parse", "--git-path", "x"], timeout_ms=5000, env={"GIT_DIR": f.p(".git")})
    assert out.stdout.decode().strip().endswith("x")


def test_run_git_missing_git_is_git_unavailable_and_killed_is_git_timeout(scratch, monkeypatch):
    monkeypatch.setenv("PATH", scratch)
    e = expect_code(lambda: run_git(cwd=scratch, args=["status"], timeout_ms=1000), "git_unavailable")
    assert str(e) == "git executable not found"
    fake = os.path.join(scratch, "git")
    Path(fake).write_text("#!/bin/sh\nkill -9 $$\n")
    os.chmod(fake, 0o755)
    e = expect_code(lambda: run_git(cwd=scratch, args=["status"], timeout_ms=5000), "git_timeout")
    assert str(e) == "git status was killed (SIGKILL)"


def test_run_git_timeout_is_clamped_to_the_bounds(scratch, monkeypatch):
    fake = os.path.join(scratch, "git")
    Path(fake).write_text("#!/bin/sh\nsleep 5 >/dev/null 2>&1 </dev/null\n")
    os.chmod(fake, 0o755)
    monkeypatch.setenv("PATH", f"{scratch}:{os.environ.get('PATH', '')}")
    assert str(expect_code(lambda: run_git(cwd=scratch, args=["x"], timeout_ms=0), "git_timeout")) == "git x timed out after 1ms"
    assert str(expect_code(lambda: run_git(cwd=scratch, args=["x"], timeout_ms=-50), "git_timeout")) == "git x timed out after 1ms"
    assert str(expect_code(lambda: run_git(cwd=scratch, args=["x"], timeout_ms=0.5), "git_timeout")) == "git x timed out after 1ms"


def test_decode_name_and_nul_records():
    assert S.decode_name("é😀".encode(), "x") == "é😀"
    assert S.decode_name(b"\xef\xbb\xbfa", "x") == "﻿a"
    for bad in [b"b\xff", b"\xed\xa0\x80", b"\xc0\x80", b"\xf4\x90\x80\x80"]:
        e = expect_code(lambda: S.decode_name(bad, "changed path"), "invalid_encoding")
        assert str(e) == "changed path is not valid UTF-8"
    assert S.nul_records(b"") == []
    assert S.nul_records(b"a\0\0bc\0") == [b"a", b"bc"]
    assert str(expect_code(lambda: S.nul_records(b"a\0b"), "corrupt_output")) == "unterminated NUL record"


def test_normalize_logical_path_rejects_non_strings_and_names_the_value():
    for bad, shown in [(None, "null"), (5, "5"), (["a"], '["a"]'), ("", '""'), ("a\\b", '"a\\\\b"')]:
        assert str(expect_code(lambda: normalize_logical_path(bad), "invalid_path")) == f"invalid logical path {shown}"
    assert str(expect_code(lambda: normalize_logical_path("a//b"), "invalid_path")) == 'logical path is not canonical: "a//b"'


def test_golden_path_detection_and_identity_domains():
    assert S.is_generated_golden_path("pkg/testdata/golden/x.golden")
    assert S.is_generated_golden_path("testdata/golden/x.golden")
    assert not S.is_generated_golden_path("pkg/testdata/golden/x.txt")
    assert not S.is_generated_golden_path("mytestdata/golden/x.golden")
    d = {"kind": "base-diff", "baseTree": "a", "candidateTree": "b", "pathsDigest": "c"}
    assert snapshot_identity("base-diff", "workspace", "a", "b", "c") == domain_hash("review-snapshot", 3, d)
    assert snapshot_identity("base-workspace-overlay", "staged", "a", "b", "c") == domain_hash("review-snapshot-base-workspace-overlay", 2, {**d, "kind": "base-workspace-overlay"})


def test_target_validation_messages():
    def msg(target):
        return str(expect_code(lambda: freeze_snapshot("/nonexistent", target), "invalid_target"))

    assert msg(None) == "target must be an object"
    assert msg("x") == "target must be an object"
    assert msg({}) == "unsupported target kind undefined"
    assert msg([]) == "unsupported target kind undefined"
    assert msg({"kind": 5}) == "unsupported target kind 5"
    assert msg({"kind": "nope"}) == 'unsupported target kind "nope"'
    assert msg({"kind": "current-changes", "intendedUntracked": "x"}) == "intendedUntracked must be a list of strings"
    assert msg({"kind": "current-changes", "intendedUntracked": None}) == "intendedUntracked must be a list of strings"
    assert msg({"kind": "current-changes", "intendedUntracked": [1]}) == "intendedUntracked must be a list of strings"
    assert msg({"kind": "current-changes", "projection": "bogus"}) == 'unsupported projection "bogus"'
    assert msg({"kind": "current-changes", "projection": 3}) == "unsupported projection 3"
    assert msg({"kind": "base-diff"}) == "baseRef must be a string"
    assert msg({"kind": "base-diff", "baseRef": 5}) == "baseRef must be a string"
    assert msg({"kind": "base-diff", "baseRef": "a..b"}) == "baseRef must be exactly one revision (not a range or option)"
    assert msg({"kind": "base-diff", "baseRef": "a\nb"}) == "baseRef must be exactly one revision (not a range or option)"
    assert msg({"kind": "base-diff", "baseRef": "x", "intendedUntracked": ["a"]}) == "a committed-only base-diff does not accept intended-untracked paths"
    assert str(expect_code(lambda: freeze_snapshot("/nonexistent", {"kind": "current-changes", "projection": None}), "not_a_repository")) == "/nonexistent does not exist"  # null projection falls back to workspace


def test_resolve_repository_rejects_bad_cwd_and_describes_the_path(scratch):
    for bad in [None, "", 5, "a\0b"]:
        assert str(expect_code(lambda: resolve_repository(bad), "invalid_target")) == "repository path is required"
    e = expect_code(lambda: resolve_repository(scratch), "not_a_repository")
    assert str(e) == f"{os.path.realpath(scratch)} is not inside a git repository"
    bare = os.path.join(scratch, "bare.git")
    git(scratch, "init", "-q", "--bare", bare)
    assert str(expect_code(lambda: resolve_repository(bare), "bare_repository")) == f"{os.path.realpath(bare)} is a bare repository; a review candidate needs a working tree"


def test_symlinked_cwd_resolves_to_the_real_root(make_repo):
    f = make_repo()
    link = os.path.join(f.dir, "lnk")
    os.symlink(f.repo, link)
    assert resolve_repository(link)["root"] == f.repo


def test_intended_untracked_limits_count_and_total_bytes(make_repo):
    f = make_repo()
    names = [f"f{i:04d}.txt" for i in range(1001)]
    for n in names:
        write(f.p("many", n), "x\n")
    e = expect_code(lambda: freeze_snapshot(f.repo, {"kind": "current-changes", "intendedUntracked": [f"many/{n}" for n in names]}), "untracked_refused", "too_many")
    assert str(e) == 'intended-untracked path "(1001 paths)" list exceeds 1000 files'
    ok = freeze_snapshot(f.repo, {"kind": "current-changes", "intendedUntracked": [f"many/{n}" for n in names[:1000]]})
    assert len(frozen(ok)["paths"]) == 1000
    fx = make_repo()
    for i in range(17):
        write(fx.p(f"m{i:02d}.bin"), bytes([i + 1]) * MAX_INTENDED_UNTRACKED_FILE_BYTES)
    exact = [f"m{i:02d}.bin" for i in range(16)]
    assert len(frozen(freeze_snapshot(fx.repo, {"kind": "current-changes", "intendedUntracked": exact}))["paths"]) == 16
    e = expect_code(lambda: freeze_snapshot(fx.repo, {"kind": "current-changes", "intendedUntracked": exact + ["m16.bin"]}), "untracked_refused", "too_large")
    assert str(e) == 'intended-untracked path "m16.bin" pushes the list past 16777216 bytes'
    assert frozen(freeze_snapshot(f.repo, {"kind": "current-changes", "intendedUntracked": ["many/f0000.txt"]}))["paths"] == ["many/f0000.txt"]


def test_file_size_limit_boundary(make_repo):
    f = make_repo()
    write(f.p("fits.bin"), b"\x01" * MAX_INTENDED_UNTRACKED_FILE_BYTES)
    write(f.p("over.bin"), b"\x01" * (MAX_INTENDED_UNTRACKED_FILE_BYTES + 1))
    assert frozen(freeze_snapshot(f.repo, {"kind": "current-changes", "intendedUntracked": ["fits.bin"]}))["paths"] == ["fits.bin"]
    e = expect_code(lambda: freeze_snapshot(f.repo, {"kind": "current-changes", "intendedUntracked": ["over.bin"]}), "untracked_refused", "too_large")
    assert str(e) == 'intended-untracked path "over.bin" exceeds 1048576 bytes'


def test_intended_path_inside_a_dot_git_segment_and_symlinked_parent_and_not_regular_parent(make_repo):
    f = make_repo()
    write(f.p("file.txt"), "x\n")
    for p in ["sub/.GIT/x", ".git"]:
        e = expect_code(lambda: freeze_snapshot(f.repo, {"kind": "current-changes", "intendedUntracked": [p]}), "invalid_path")
        assert str(e) == f'intended-untracked path {S.js_stringify(p)} is inside .git'
    e = expect_code(lambda: freeze_snapshot(f.repo, {"kind": "current-changes", "intendedUntracked": ["file.txt/x"]}), "untracked_refused", "not_regular")
    assert str(e) == 'intended-untracked path "file.txt/x" has a non-directory parent'


def test_submodule_like_directory_is_not_followed_as_a_regular_file(make_repo):
    f = make_repo()
    nested = f.p("vendor", "lib")
    os.makedirs(nested)
    git(nested, "init", "-q", "-b", "main")
    write(os.path.join(nested, "x.txt"), "x\n")
    expect_code(lambda: freeze_snapshot(f.repo, {"kind": "current-changes", "intendedUntracked": ["vendor/lib"]}), "untracked_refused", "not_regular")
    assert freeze_snapshot(f.repo, WORKSPACE)["status"] == "empty"
    git(nested, "add", "-A")
    git(nested, "commit", "-q", "-m", "n")
    git(f.repo, "add", "vendor/lib")
    s = frozen(freeze_snapshot(f.repo, WORKSPACE))
    assert s["paths"] == ["vendor/lib"]
    assert git(f.repo, "ls-tree", s["candidateTree"], "--", "vendor/lib").startswith("160000 commit ")


def test_workspace_candidate_with_a_tracked_symlink_change(make_repo):
    f = make_repo()
    os.symlink("a.txt", f.p("ln"))
    git(f.repo, "add", "ln")
    git(f.repo, "commit", "-q", "-m", "ln")
    os.unlink(f.p("ln"))
    os.symlink("b.txt", f.p("ln"))
    s = frozen(freeze_snapshot(f.repo, WORKSPACE))
    assert s["paths"] == ["ln"]
    assert blob(f.repo, s["candidateTree"], "ln") == "b.txt"
    assert stat.S_ISLNK(os.lstat(f.p("ln")).st_mode)


def test_unicode_tracked_names_and_quoting_round_trip(make_repo):
    f = make_repo()
    names = ["日本語.txt", "é.txt", "a b/ç d.txt", "\U0001f600\U0001f601.txt", "ﬁ.txt"]
    for n in names:
        write(f.p(n), "1\n")
    git(f.repo, "add", "-A")
    git(f.repo, "commit", "-q", "-m", "u")
    for n in names:
        write(f.p(n), "2\n")
    s = frozen(freeze_snapshot(f.repo, WORKSPACE))
    assert s["paths"] == sorted(names, key=u8key)
    assert s["changedLines"] == 2 * len(names)
