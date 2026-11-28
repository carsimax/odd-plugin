"""Port of v9 review/risk.spec.ts (26 tests; the `startReview` lens-count case waits for the `start` port and the type-shape
case has no Python analogue) plus extra cases for the pure path classes and the added-line scanners."""
import os
import shutil
import tempfile

import pytest

from odd_claude.review import risk as R
from odd_claude.review.risk import MAX_BLOB_SCAN_BYTES, assess_candidate, assess_risk
from odd_claude.review.snapshot import freeze_snapshot, resolve_repository
from review.test_snapshot import _hermetic_git_env, git, write  # noqa: F401  (autouse hermetic git env)

BASE = {"README.md": "hello\n", "src/a.ts": "export const a = 1;\n", "src/run.ts": "export const r = 1;\n", "package.json": "{}\n"}


@pytest.fixture
def with_repo():
    dirs: list[str] = []

    def make(files: dict) -> str:
        d = os.path.realpath(tempfile.mkdtemp(prefix="odd-risk-"))
        dirs.append(d)
        repo = os.path.join(d, "repo")
        os.mkdir(repo)
        git(repo, "init", "-q", "-b", "main")
        for rel, content in files.items():
            write(os.path.join(repo, rel), content)
        git(repo, "add", "-A")
        git(repo, "-c", "user.name=t", "-c", "user.email=t@t.invalid", "commit", "-q", "-m", "init")
        return repo

    yield make
    for d in dirs:
        shutil.rmtree(d, ignore_errors=True)


def put(repo: str, rel: str, content) -> None:
    write(os.path.join(repo, rel), content)


def assess_workspace(repo: str) -> dict:
    git(repo, "add", "-A")  # new files enter a candidate only when tracked or explicitly intended
    frozen = freeze_snapshot(repo, {"kind": "current-changes", "projection": "workspace"})
    assert frozen["status"] == "frozen"
    return assess_risk(frozen["snapshot"], frozen["repository"])


def codes(a: dict) -> list[str]:
    return [r["code"] for r in a["reasons"]]


def find(a: dict, code: str):
    return next((r for r in a["reasons"] if r["code"] == code), None)


def test_docs_only_change_is_low_non_executable_only(with_repo):
    repo = with_repo(BASE)
    put(repo, "README.md", "hello\nworld\n")
    put(repo, "docs/guide.md", "# guide\n")
    a = assess_workspace(repo)
    assert a["risk_level"] == "low"
    assert a["level"] == "low"
    assert a["reasons"] == [{"code": "non_executable_only"}]
    assert a["evidence"] == ["documentation or other non-executable files only"]
    assert "focusLens" not in a


def test_a_ts_change_is_medium_executable_change_with_the_default_risk_lens(with_repo):
    repo = with_repo(BASE)
    put(repo, "src/a.ts", "export const a = 2;\n")
    a = assess_workspace(repo)
    assert a["risk_level"] == "medium"
    assert a["reasons"] == [{"code": "executable_change", "path": "src/a.ts"}]
    assert a["focusLens"] == "risk"
    assert a["evidence"] == ["executable_change: src/a.ts"]


def test_child_process_spawn_and_exec_sync_are_high_process_boundary(with_repo):
    repo = with_repo(BASE)
    put(repo, "src/a.ts", 'import { spawn } from "node:child_process";\nspawn("ls");\n')
    a = assess_workspace(repo)
    assert a["risk_level"] == "high"
    assert find(a, "process_boundary") == {"code": "process_boundary", "signal": "shell_process", "path": "src/a.ts"}
    repo = with_repo(BASE)
    put(repo, "src/a.ts", 'execSync("ls");\n')
    a = assess_workspace(repo)
    assert a["risk_level"] == "high"
    assert "process_boundary" in codes(a)


def test_a_spawn_in_a_test_file_is_not_process_evidence(with_repo):
    repo = with_repo(BASE)
    put(repo, "src/a.spec.ts", 'import { spawn } from "node:child_process";\nspawn("ls");\n')
    assert assess_workspace(repo)["risk_level"] == "medium"


def test_a_commented_out_spawn_is_not_process_evidence(with_repo):
    repo = with_repo(BASE)
    put(repo, "src/a.ts", '// child_process.spawn("x")\nexport const a = 2;\n')
    assert assess_workspace(repo)["risk_level"] == "medium"


def test_a_shebang_makes_a_doc_named_file_a_process_boundary(with_repo):
    repo = with_repo(BASE)
    put(repo, "notes.md", "#!/bin/sh\necho hi\n")
    a = assess_workspace(repo)
    assert a["risk_level"] == "medium"
    assert "non_executable_only" not in codes(a)


def test_shell_scripts_are_high_shell_source(with_repo):
    repo = with_repo(BASE)
    put(repo, "scripts/x.sh", "echo hi\n")
    a = assess_workspace(repo)
    assert a["risk_level"] == "high"
    assert find(a, "shell_source") == {"code": "shell_source", "signal": "shell_process", "path": "scripts/x.sh"}


def test_package_json_and_lockfiles_are_high_dependency_change(with_repo):
    repo = with_repo(BASE)
    put(repo, "package.json", '{"name":"x"}\n')
    a = assess_workspace(repo)
    assert a["risk_level"] == "high"
    assert find(a, "dependency_change") == {"code": "dependency_change", "signal": "dependency", "path": "package.json"}
    repo = with_repo({**BASE, "package-lock.json": "{}\n"})
    put(repo, "package-lock.json", '{"lockfileVersion":3}\n')
    a = assess_workspace(repo)
    assert a["risk_level"] == "high"
    assert "dependency_change" in codes(a)


def test_github_workflows_is_high_ci_release_change(with_repo):
    repo = with_repo(BASE)
    put(repo, ".github/workflows/ci.yml", "name: ci\n")
    a = assess_workspace(repo)
    assert a["risk_level"] == "high"
    assert "ci_release_change" in codes(a)


def test_hooks_and_contracts_schemas_are_high_with_their_own_codes(with_repo):
    repo = with_repo(BASE)
    put(repo, ".husky/pre-commit", "npm test\n")
    a = assess_workspace(repo)
    assert a["risk_level"] == "high"
    assert "hook_change" in codes(a)
    repo = with_repo(BASE)
    put(repo, "contracts/review/start.schema.json", "{}\n")
    a = assess_workspace(repo)
    assert a["risk_level"] == "high"
    assert "contract_change" in codes(a)


def test_credential_permission_and_auth_paths_are_high(with_repo):
    repo = with_repo(BASE)
    put(repo, "config/secrets.txt", "x\n")
    a = assess_workspace(repo)
    assert a["risk_level"] == "high"
    assert "credential_path" in codes(a)
    repo = with_repo(BASE)
    put(repo, "src/auth/login.ts", "export {};\n")
    a = assess_workspace(repo)
    assert a["risk_level"] == "high"
    assert find(a, "hot_path") == {"code": "hot_path", "signal": "auth", "path": "src/auth/login.ts"}


def test_network_and_filesystem_deletion_in_added_lines_are_high(with_repo):
    repo = with_repo(BASE)
    put(repo, "src/a.ts", 'export const g = () => fetch("https://example.com");\n')
    a = assess_workspace(repo)
    assert a["risk_level"] == "high"
    assert "network_access" in codes(a)
    repo = with_repo(BASE)
    put(repo, "src/a.ts", 'import { rmSync } from "node:fs";\nrmSync(p, { recursive: true });\n')
    a = assess_workspace(repo)
    assert a["risk_level"] == "high"
    assert "filesystem_deletion" in codes(a)


def test_a_dangerous_sink_is_high_dangerous_sink(with_repo):
    repo = with_repo(BASE)
    put(repo, "src/a.ts", "export const f = (s: string) => eval(s);\n")
    a = assess_workspace(repo)
    assert a["risk_level"] == "high"
    assert "dangerous_sink" in codes(a)


def test_chmod_plus_x_reports_executable_mode_with_both_modes(with_repo):
    repo = with_repo(BASE)
    os.chmod(os.path.join(repo, "src/run.ts"), 0o755)
    a = assess_workspace(repo)
    assert a["risk_level"] == "high"
    assert a["reasons"] == [{"code": "executable_mode", "signal": "permissions", "path": "src/run.ts", "old_mode": "100644", "new_mode": "100755"}]


def test_deleting_source_is_medium_file_deletion_deleting_docs_stays_low(with_repo):
    repo = with_repo(BASE)
    os.unlink(os.path.join(repo, "src/a.ts"))
    a = assess_workspace(repo)
    assert a["risk_level"] == "medium"
    assert find(a, "file_deletion") == {"code": "file_deletion", "path": "src/a.ts"}
    assert a["focusLens"] == "resilience"
    repo = with_repo(BASE)
    os.unlink(os.path.join(repo, "README.md"))
    assert assess_workspace(repo)["risk_level"] == "low"


def test_a_binary_file_is_medium_binary_change(with_repo):
    repo = with_repo(BASE)
    put(repo, "assets/blob.dat", bytes([0, 1, 2, 3, 0, 255]))
    a = assess_workspace(repo)
    assert a["risk_level"] == "medium"
    assert a["reasons"] == [{"code": "binary_change", "path": "assets/blob.dat"}]


def test_a_passive_image_stays_low(with_repo):
    repo = with_repo(BASE)
    put(repo, "docs/logo.png", b"\x89PNG\r\n\x1a\n" + bytes([0, 0, 0, 1]))
    assert assess_workspace(repo)["risk_level"] == "low"


def test_a_huge_change_is_medium_large_change_even_for_docs(with_repo):
    repo = with_repo(BASE)
    put(repo, "docs/big.md", "\n".join(f"line {i}" for i in range(500)) + "\n")
    a = assess_workspace(repo)
    assert a["risk_level"] == "medium"
    assert a["reasons"] == [{"code": "large_change"}]
    assert a["focusLens"] == "readability"


def test_a_symlink_is_medium_symlink_change(with_repo):
    repo = with_repo(BASE)
    os.symlink("README.md", os.path.join(repo, "link.md"))
    a = assess_workspace(repo)
    assert a["risk_level"] == "medium"
    assert "symlink_change" in codes(a)


def test_oversized_blobs_fail_closed_into_process_scan_limit_bounded_scan(with_repo):
    repo = with_repo(BASE)
    put(repo, "src/big.ts", "// x\n" + "export const v = 1;\n" * (-(-MAX_BLOB_SCAN_BYTES // 19) + 10))
    a = assess_workspace(repo)
    assert a["risk_level"] == "high"
    assert find(a, "process_scan_limit") == {"code": "process_scan_limit", "signal": "shell_process", "path": "src/big.ts"}


def test_results_are_deterministic(with_repo):
    repo = with_repo(BASE)
    put(repo, "src/a.ts", 'import { spawn } from "node:child_process";\nspawn("ls");\n')
    put(repo, "package.json", '{"a":1}\n')
    put(repo, "README.md", "changed\n")
    assert assess_workspace(repo) == assess_workspace(repo)


def test_only_frozen_trees_are_read_editing_the_worktree_after_freeze_changes_nothing(with_repo):
    repo = with_repo(BASE)
    put(repo, "src/a.ts", 'execSync("ls");\n')
    frozen = freeze_snapshot(repo, {"kind": "current-changes", "projection": "workspace"})
    before = assess_risk(frozen["snapshot"], frozen["repository"])
    put(repo, "src/a.ts", "export const harmless = 1;\n")
    put(repo, "README.md", "x\n")
    os.unlink(os.path.join(repo, "package.json"))
    os.chmod(os.path.join(repo, "src/run.ts"), 0o755)
    after = assess_risk(frozen["snapshot"], frozen["repository"])
    assert after == before
    assert after["risk_level"] == "high"


def test_assess_risk_accepts_a_separately_resolved_repository(with_repo):
    repo = with_repo(BASE)
    put(repo, "src/a.ts", "export const a = 3;\n")
    frozen = freeze_snapshot(repo, {"kind": "current-changes", "projection": "workspace"})
    assert assess_risk(frozen["snapshot"], resolve_repository(repo)) == assess_risk(frozen["snapshot"], frozen["repository"])


def test_assess_candidate_plan_shaped_read_only_due_equals_high(with_repo):
    repo = with_repo(BASE)
    put(repo, "src/a.ts", 'execSync("ls");\n')
    before = git(repo, "status", "--porcelain=v1")
    high = assess_candidate(repo, {"kind": "current-changes", "projection": "workspace"})
    assert high["status"] == "assessed"
    assert high["risk"] == "high"
    assert high["reviewDue"] is True
    assert high["changedPaths"] == ["src/a.ts"]
    assert high["changedLines"] == 2
    assert len(high["reasons"]) > 0
    assert "focusLens" not in high
    assert git(repo, "status", "--porcelain=v1") == before
    repo = with_repo(BASE)
    put(repo, "src/a.ts", "export const a = 9;\n")
    medium = assess_candidate(repo, {"kind": "current-changes", "projection": "workspace"})
    assert medium["status"] == "assessed" and medium["reviewDue"] is False and medium["focusLens"] == "risk"
    repo = with_repo(BASE)
    assert assess_candidate(repo, {"kind": "current-changes", "projection": "workspace"}) == {"status": "not_due", "reason": "no_changes", "reviewDue": False, "kind": "current-changes", "projection": "workspace"}


# ---- extra cases ----


def test_constants_match_v9():
    assert (R.LARGE_CHANGE_LINES, R.MAX_BLOB_SCAN_BYTES, R.MAX_TOTAL_SCAN_BYTES) == (400, 1024 * 1024, 8 * 1024 * 1024)


@pytest.mark.parametrize(
    "path,expected",
    [
        ("a.txt", ".txt"), (".env", ""), ("a/.env", ""), ("a.b.c", ".c"), ("a.", "."), (".", ""), ("..", ""), ("a/b.TS", ".ts"), ("a/b", ""), (".a.b", ".b"), ("x/..a", ".a"), ("a.b/c", ""),
    ],
)
def test_ext_follows_node_posix_extname(path, expected):
    assert R._ext(path) == expected


@pytest.mark.parametrize(
    "path,test_path",
    [("a_test.go", True), ("a.test.ts", True), ("a.spec.ts", True), ("test_x.py", True), ("x_test.py", True), ("__tests__/x.ts", True), ("pkg/testdata/x.go", True), ("src/test_x.go", False), ("src/attest.ts", False), ("tests/x.ts", False)],
)
def test_is_test_path(path, test_path):
    assert R._is_test_path(path) is test_path


@pytest.mark.parametrize(
    "path,code",
    [
        (".gitlab-ci.yml", "ci"), ("Jenkinsfile", "ci"), ("install.sh", "ci"), ("installer.rs", "ci"), (".circleci/config.yml", "ci"), ("src/install-x.sh", "ci"),
        ("requirements-dev.txt", "dep"), ("go.sum", "dep"), ("uv.lock", "dep"), ("lefthook.yml", "hook"), ("a/hooks/x", "hook"), ("hooks.json", "hook"),
        ("api/openapi.yaml", "contract"), ("a/schema/x.json", "contract"), ("docs/schemas/x.json", None), ("id_rsa.pub", "cred"), ("a/.npmrc", "cred"),
        ("src/api_key.ts", None), ("src/apikey.ts", "cred"), ("src/password-reset.ts", "cred"), ("README.secrets", None), ("src/rbac.go", "perm"), ("CODEOWNERS", "perm"),
    ],
)
def test_path_classes(path, code):
    got = {
        "ci": R._is_ci_release_path(path), "dep": R._is_dependency_path(path), "hook": R._is_hook_path(path),
        "contract": R._is_contract_path(path), "cred": R._is_credential_path(path), "perm": R._is_permission_path(path),
    }
    hit = [k for k, v in got.items() if v]
    assert hit == ([code] if code else [])


@pytest.mark.parametrize(
    "line,process,network,fsdelete",
    [
        ("subprocess.run(x)", True, False, False), ("import subprocess", True, False, False), ("x = exec(y)", True, False, False), ("myexec(y)", False, False, False),
        ("os.system('ls')", True, False, False), ("cp.spawn('a')", True, False, False), ("spawn ('a')", True, False, False), ("respawn('a')", False, False, False),
        ("fetch('x')", False, True, False), ("obj.fetch('x')", False, False, False), ("requests.get(u)", False, True, False), ("curl http://x", False, True, False),
        ("rm -rf /", False, False, True), ("a; rm -f x", False, False, True), ("shutil.rmtree(p)", False, False, True), ("unlink(p)", False, False, True), ("fs.unlink(p)", False, False, True),
        ("nbsp fetch(x)", False, True, False), ("fetch (x)", False, True, False), ("EXEC(x)", True, False, False), ("ſubprocess", False, False, False),
    ],
)
def test_added_line_patterns(line, process, network, fsdelete):
    assert bool(R._PROCESS_LINE.search(line)) is process
    assert any(r.search(line) for r in R._NETWORK_LINES) is network
    assert any(r.search(line) for r in R._FS_DELETE_LINES) is fsdelete


def test_sink_lines_depend_on_the_file_extension():
    assert R._sink_line("a.ts", "x = eval(y)")
    assert not R._sink_line("a.go", "x = eval(y)")
    assert R._sink_line("a.py", "requests.get(u, verify=False)")
    assert R._sink_line("a.sh", "curl -k https://x")
    assert not R._sink_line("a.sh", "curl https://x")
    assert R._sink_line("a.go", "&tls.Config{InsecureSkipVerify: true}")
    assert R._sink_line("a.go", "x := Access-Control-Allow-Origin: *; Access-control-allow-credentials: TRUE")
    assert not R._sink_line("README", "eval(x)")


@pytest.mark.parametrize(
    "path,line,expected",
    [
        ("a.py", "  # x", True), ("a.py", "x # y", False), ("a.ts", "// x", True), ("a.ts", "/* x */", True), ("a.ts", "/* x */ y()", False), ("a.ts", "/* open", True), ("a.ts", " * body", True),
        ("a.ts", "*/", True), ("a.ts", "*/ y", False), ("a.ts", "*", True), ("a.ts", "*x", False), ("a.sql", "-- x", True), ("a.sql", "# x", False), ("a.bin", "# x", False), ("Dockerfile", "# x", True),
        ("a.ts", " // x", True),
    ],
)
def test_is_comment_only(path, line, expected):
    assert R._is_comment_only(path, line) is expected


def test_passive_content_and_signatures():
    assert R._is_passive_content("a.md", b"hello\n")
    assert not R._is_passive_content("a.md", b"hel\0lo")
    assert not R._is_passive_content("a.md", b"\xff\xfe")
    assert not R._is_passive_content("a.md", b"#!/bin/sh\n")
    assert not R._is_passive_content("a.md", b"\xef\xbb\xbf#!/bin/sh\n")
    assert R._is_passive_content("a.mdx", b"# hi\n")
    assert not R._is_passive_content("a.mdx", b"# hi\nimport x from 'y'\n")
    assert not R._is_passive_content("a.mdx", "\u00a0export const a = 1\n".encode())
    assert R._is_passive_content("a.mdx", b"importer\n")
    assert R._is_passive_content("a.png", b"\x89PNG\r\n\x1a\nxx")
    assert R._is_passive_content("a.jpg", b"\xff\xd8\xffxx")
    assert R._is_passive_content("a.gif", b"GIF89a..")
    assert not R._is_passive_content("a.png", b"GIF8")
    assert not R._is_passive_content("a.png", b"")


def test_canonical_reasons_sort_by_utf16_code_unit_and_dedupe_by_code_and_signal():
    a = {"code": "x", "signal": "s", "path": "～"}
    b = {"code": "x", "signal": "s", "path": "\U0001f600"}
    c = {"code": "x", "signal": "s", "path": "a"}
    assert R._canonical_reasons([a, b, c]) == [c]
    assert R._canonical_reasons([{"code": "x", "path": "b"}, {"code": "x", "path": "a"}, {"code": "w"}]) == [{"code": "w"}, {"code": "x", "path": "a"}]
    # the UTF-16 order puts an astral character (D83D) before U+FF5E
    assert R._canonical_reasons([{"code": "x", "signal": "1", "path": "～"}, {"code": "x", "signal": "2", "path": "\U0001f600"}])[0]["signal"] == "1"
    assert R._u16("\U0001f600") < R._u16("～")


def test_evidence_is_capped_with_a_more_line():
    reasons = [{"code": f"c{i:02d}", "signal": "s", "path": f"p{i}"} for i in range(15)]
    ev = R._evidence_for("high", reasons)
    assert len(ev) == 13 and ev[0] == "c00 [s]: p0" and ev[-1] == "… 3 more"
    assert R._evidence_for("medium", [{"code": "large_change"}]) == ["large_change"]


def test_hostile_names_through_the_whole_pipeline(with_repo):
    repo = with_repo(BASE)
    for name in ["sp ace.ts", "ünï ☃.ts", "-dash.ts"]:
        put(repo, f"src/{name}", 'execSync("ls");\n')
    a = assess_workspace(repo)
    assert a["risk_level"] == "high"
    assert find(a, "process_boundary") == {"code": "process_boundary", "signal": "shell_process", "path": "src/-dash.ts"}  # one reason per code+signal, first path in byte order
    assert find(a, "process_scan_limit") is None
    # git quotes a control character or quote in the diff header even with core.quotePath=false: fail closed
    for name in ["new\nline.ts", "tab\there.ts", 'quote"s.ts']:
        repo = with_repo(BASE)
        put(repo, f"src/{name}", 'execSync("ls");\n')
        a = assess_workspace(repo)
        assert find(a, "process_scan_limit") == {"code": "process_scan_limit", "signal": "shell_process", "path": f"src/{name}"}


def test_non_utf8_added_path_in_the_diff_fails_closed(with_repo):
    repo = with_repo(BASE)
    base_tree = git(repo, "rev-parse", "HEAD^{tree}").strip()
    blob = git(repo, "hash-object", "-w", "--stdin", input=b"execSync('x')\n").strip()
    from review.test_snapshot import plumb_tree  # noqa: PLC0415

    bad = plumb_tree(repo, [{"mode": "100644", "type": "blob", "oid": blob, "name": b"b\xff.ts"}])
    snap = {"baseTree": base_tree, "candidateTree": bad, "paths": [], "changedLines": 0}
    from odd_claude.review.snapshot import SnapshotError

    with pytest.raises(SnapshotError) as ei:
        assess_risk(snap, resolve_repository(repo))
    assert ei.value.code == "invalid_encoding"


def test_submodule_change(with_repo):
    repo = with_repo(BASE)
    nested = os.path.join(repo, "vendor", "lib")
    os.makedirs(nested)
    git(nested, "init", "-q", "-b", "main")
    write(os.path.join(nested, "x.txt"), "x\n")
    git(nested, "add", "-A")
    git(nested, "-c", "user.name=t", "-c", "user.email=t@t.invalid", "commit", "-q", "-m", "n")
    a = assess_workspace(repo)
    assert a["risk_level"] == "medium"
    assert a["reasons"] == [{"code": "submodule_change", "path": "vendor/lib"}]


def test_non_regular_inputs_empty_content_and_configuration_change(with_repo):
    repo = with_repo(BASE)
    put(repo, "empty.ts", "")
    a = assess_workspace(repo)
    assert a["reasons"] == [{"code": "empty_content", "path": "empty.ts"}]
    repo = with_repo({**BASE, "conf.yaml": "a: 1\n"})
    put(repo, "conf.yaml", "a: 2\n")
    a = assess_workspace(repo)
    assert a["risk_level"] == "medium" and a["reasons"] == [{"code": "configuration_change", "path": "conf.yaml"}]
