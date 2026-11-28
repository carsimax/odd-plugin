"""Differential: review/risk against v9 dist/review/risk.js through the oracle. Two angles: (1) real temp repos frozen by the
Python snapshot, both implementations assessing the same snapshot dict and repository; (2) synthetic one-file trees built with
plumbing (a temp index), so thousands of (path, content, mode) combinations reach the path classes and the added-line scanners
without a worktree. The exported surface is `assessRisk`, `assessCandidate` and the three constants."""
import os
import shutil
import subprocess
import tempfile

import pytest

from lib.v9_oracle import DIST, needs_v9
from odd_claude.review import risk as R
from odd_claude.review import snapshot as S
from review.conftest import diff_cases
from review.test_snapshot import CLEAN_ENV, Fixture, _hermetic_git_env, git, write  # noqa: F401

pytestmark = needs_v9
MOD = "review/risk"
V9_ENV = {"GIT_CONFIG_NOSYSTEM": "1"}
T = {"kind": "current-changes"}
EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"


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


def same(fn: str, py_fn, calls: list[list]) -> None:
    diff_cases(MOD, fn, py_fn, calls, env=V9_ENV)


def commit_all(repo: str) -> None:
    git(repo, "add", "-A")
    git(repo, "-c", "user.name=t", "-c", "user.email=t@t.invalid", "commit", "-q", "-m", "c")


def assess_pairs(repo: str, snaps: list[dict]) -> None:
    ident = S.resolve_repository(repo)
    same("assessRisk", R.assess_risk, [[s, ident] for s in snaps])


def freeze(repo: str, target: dict | None = None) -> dict:
    r = S.freeze_snapshot(repo, target or T)
    return r["snapshot"]


# ---- real repositories ----


def test_constants_match_v9():
    text = (DIST / "review" / "risk.js").read_text()  # constants are not callable through the oracle: read the compiled text
    assert f"export const LARGE_CHANGE_LINES = {R.LARGE_CHANGE_LINES};" in text
    assert "export const MAX_BLOB_SCAN_BYTES = 1024 * 1024;" in text and R.MAX_BLOB_SCAN_BYTES == 1024 * 1024
    assert "export const MAX_TOTAL_SCAN_BYTES = 8 * 1024 * 1024;" in text and R.MAX_TOTAL_SCAN_BYTES == 8 * 1024 * 1024


BASE = {"README.md": "hello\n", "src/a.ts": "export const a = 1;\n", "src/run.ts": "export const r = 1;\n", "package.json": "{}\n", "docs/guide.md": "g\n", "conf.yaml": "a: 1\n", "x.sh": "echo 1\n", "bin.dat": b"\0\1\0"}


def seeded_repo(make_repo, files=BASE) -> Fixture:
    f = make_repo()
    for rel, content in files.items():
        write(f.p(rel), content)
    commit_all(f.repo)
    return f


def test_assess_real_repository_edit_sets(make_repo):
    f = seeded_repo(make_repo)
    snaps = []

    def state(edits, chmods=(), deletes=(), intended=None):
        for rel, content in edits.items():
            write(f.p(rel), content)
        for rel, mode in chmods:
            os.chmod(f.p(rel), mode)
        for rel in deletes:
            os.unlink(f.p(rel))
        git(f.repo, "add", "-A")
        snaps.append(freeze(f.repo))
        git(f.repo, "reset", "-q", "--hard")

    state({"README.md": "hello\nworld\n", "docs/guide.md": "# g\n"})
    state({"src/a.ts": "export const a = 2;\n"})
    state({"src/a.ts": 'import { spawn } from "node:child_process";\nspawn("ls");\n'})
    state({"src/a.ts": 'execSync("ls");\n'})
    state({"src/a.spec.ts": 'spawn("ls");\n'})
    state({"src/a.ts": '// child_process.spawn("x")\nexport const a = 2;\n'})
    state({"notes.md": "#!/bin/sh\necho hi\n"})
    state({"scripts/y.sh": "echo hi\n"})
    state({"package.json": '{"name":"x"}\n'})
    state({".github/workflows/ci.yml": "name: ci\n"})
    state({".husky/pre-commit": "npm test\n", "contracts/review/start.schema.json": "{}\n"})
    state({"config/secrets.txt": "x\n", "src/auth/login.ts": "export {};\n"})
    state({"src/a.ts": 'export const g = () => fetch("https://example.com");\n'})
    state({"src/a.ts": 'import { rmSync } from "node:fs";\nrmSync(p, { recursive: true });\n'})
    state({"src/a.ts": "export const f = (s: string) => eval(s);\n"})
    state({}, chmods=[("src/run.ts", 0o755)])
    state({}, chmods=[("x.sh", 0o755)])
    state({}, deletes=["src/a.ts"])
    state({}, deletes=["README.md"])
    state({}, deletes=["docs/guide.md", "src/a.ts", "package.json"])
    state({"assets/blob.dat": bytes([0, 1, 2, 3, 0, 255]), "bin.dat": b"\0\2\0"})
    state({"docs/logo.png": b"\x89PNG\r\n\x1a\n\0\0\0\1"})
    state({"docs/logo.png": b"not a png at all"})
    state({"docs/big.md": "\n".join(f"line {i}" for i in range(500)) + "\n"})
    state({"src/big.ts": "x\n" * 300})
    state({"empty.ts": ""})
    state({"conf.yaml": "a: 2\n"})
    state({"docs/a.mdx": "import x from 'y'\n", "docs/b.mdx": "# hi\n"})
    state({"docs/c.md": b"\xff\xfe binary-ish"})
    state({"docs/d.md": b"#!/bin/sh\n", "docs/e.md": b"\xef\xbb\xbf#!/bin/sh\n"})
    state({"prompts/p.md": "do it\n", "AGENTS.md": "x\n", ".claude/rules/r.md": "r\n", "skills/s/SKILL.md": "s\n"})
    state({"a.txt": "curl http://x\n", "b.txt": "plain\n"})
    state({"Dockerfile": "RUN curl http://x\n", "requirements.txt": "x\n", ".env": "A=1\n", ".env.local": "B=2\n"})
    state({"src/service-token.ts": "export {};\n", "src/service_token.json": "{}\n", "src/auth.ts": "export {};\n", "src/security/x.ts": "x\n", "src/payments/x.ts": "p\n", "src/webhook.ts": "w\n"})
    state({"pkg/testdata/golden/x.golden": "g\n" * 600, "pkg/testdata/golden/y.ts": "x\n"})
    state({"docs/note.md": "x\n", "a b/c d.ts": "export {};\n", "ünï/☃.ts": 'execSync("a");\n', "-dash.ts": "x\n"})
    state({"new\nline.ts": 'execSync("a");\n'})
    state({"tab\there.ts": 'execSync("a");\n', 'quote"s.ts': 'execSync("a");\n'})
    os.symlink("README.md", f.p("link.md"))
    state({})
    assess_pairs(f.repo, snaps)
    # assessCandidate is the freeze + assess composition
    same("assessCandidate", R.assess_candidate, [[f.repo, T], [f.repo, {"kind": "current-changes", "projection": "staged"}], [f.repo, {"kind": "base-diff", "baseRef": "HEAD"}], [f.repo, {"kind": "nope"}], [f.repo, T, {"gitTimeoutMs": 1}], ["/nonexistent", T]])


def test_assess_candidate_over_states(make_repo):
    f = seeded_repo(make_repo)
    calls = [[f.repo, T]]
    write(f.p("src/a.ts"), 'execSync("ls");\n')
    calls += [[f.repo, T], [f.repo, {"kind": "current-changes", "projection": "staged"}]]
    git(f.repo, "add", "-A")
    calls += [[f.repo, {"kind": "current-changes", "projection": "staged"}]]
    commit_all(f.repo)
    write(f.p("README.md"), "docs only\n")
    write(f.p("new.txt"), "n\n")
    calls += [[f.repo, {**T, "intendedUntracked": ["new.txt"]}], [f.repo, {"kind": "base-diff", "baseRef": "HEAD~1"}], [f.repo, {"kind": "base-workspace-overlay", "baseRef": "HEAD~1", "intendedUntracked": ["new.txt"]}]]
    write(f.p("big.ts"), "x\n" * 450)
    calls += [[f.repo, {**T, "intendedUntracked": ["big.ts", "new.txt"]}]]
    same("assessCandidate", R.assess_candidate, calls)


def test_blob_budget_boundaries(make_repo):
    mib = 1024 * 1024
    f = seeded_repo(make_repo)
    snaps = []

    def state(files, deletes=()):
        for rel, content in files.items():
            write(f.p(rel), content)
        for rel in deletes:
            os.unlink(f.p(rel))
        git(f.repo, "add", "-A")
        snaps.append(freeze(f.repo))
        git(f.repo, "reset", "-q", "--hard")
        git(f.repo, "clean", "-qfd")

    state({"src/fits.ts": b"x" * mib})
    state({"src/over.ts": b"x" * (mib + 1)})
    state({"src/a.ts": b"y" * mib})  # old 20 bytes + new 1 MiB: both sides count
    state({f"src/m{i}.ts": bytes([97 + i]) * (mib - 100) for i in range(8)})  # just under 8 MiB total
    state({f"src/m{i}.ts": bytes([97 + i]) * mib for i in range(8)})  # exactly 8 MiB
    state({f"src/m{i}.ts": bytes([97 + i]) * mib for i in range(8)} | {"src/z.ts": "z\n"})  # one byte-ish past the total
    state({"docs/big.md": b"d" * (mib + 1)})  # oversized passive
    state({"docs/ok.md": b"d" * mib, "docs/ok2.md": b"e" * mib})
    state({f"docs/p{i}.md": bytes([97 + i]) * mib for i in range(9)})  # passive total past 8 MiB
    state({f"docs/p{i}.md": bytes([97 + i]) * mib for i in range(4)} | {f"src/s{i}.ts": bytes([97 + i]) * mib for i in range(5)})
    state({"src/blank0.ts": b"\n" * mib} | {f"src/blank{i}.ts": b"\n" * mib for i in range(1, 5)})  # 5 MiB of blank lines: > 8 MiB of diff output
    state({f"src/c{i:03d}.ts": f'execSync("c{i}");\n' for i in range(450)})  # more than one pathspec batch (entry limit)
    state({f"src/{'long' * 40}{i:03d}.ts": f'export const v{i} = 1;\nfetch("u");\n' for i in range(300)})  # batch by characters
    assess_pairs(f.repo, snaps)


# ---- synthetic one-file trees ----


class Trees:
    """Builds trees through a temp index; blobs are cached by content."""

    def __init__(self, repo: str):
        self.repo = repo
        self.dir = tempfile.mkdtemp(prefix="odd-risk-idx-")
        self.index = os.path.join(self.dir, "index")
        self.blobs: dict[bytes, str] = {}
        self.cache: dict[tuple, str] = {(): EMPTY_TREE}

    def run(self, *args: str, input: bytes | None = None) -> str:
        r = subprocess.run(["git", "-C", self.repo, *args], env={**CLEAN_ENV, "GIT_INDEX_FILE": self.index}, capture_output=True, input=input)
        assert r.returncode == 0, r.stderr
        return r.stdout.decode().strip()

    def blob(self, content: bytes) -> str:
        if content not in self.blobs:
            self.blobs[content] = self.run("hash-object", "-w", "--stdin", input=content)
        return self.blobs[content]

    def tree(self, files: dict[str, tuple[str, bytes]]) -> str:
        key = tuple(sorted((p, m, c) for p, (m, c) in files.items()))
        if key not in self.cache:
            self.run("read-tree", "--empty")
            for p, (mode, content) in files.items():
                oid = content.decode() if mode == "160000" else self.blob(content if mode != "120000" else content)
                self.run("update-index", "--add", "--cacheinfo", f"{mode},{oid},{p}")
            self.cache[key] = self.run("write-tree")
        return self.cache[key]

    def close(self) -> None:
        shutil.rmtree(self.dir, ignore_errors=True)


def snap_of(repo: str, ident: dict, base: str, cand: str, lines: int = 1) -> dict:
    paths = S._changed_paths(ident, base, cand, S.bound_of(None))
    return {"baseTree": base, "candidateTree": cand, "paths": paths, "changedLines": lines}


@pytest.fixture
def trees(make_repo):
    f = make_repo()
    t = Trees(f.repo)
    yield f, t, S.resolve_repository(f.repo)
    t.close()


def run_pairs(f, t, ident, cases: list[tuple[dict, dict, int]]) -> None:
    snaps = [snap_of(f.repo, ident, t.tree(b), t.tree(c), n) for b, c, n in cases]
    same("assessRisk", R.assess_risk, [[s, ident] for s in snaps])


F = ("100644", b"x\n")

PATHS = [
    "README.md", "docs/a.md", "docs/a.mdx", "docs/a.rst", "docs/a.adoc", "docs/a.png", "docs/a.jpg", "docs/a.jpeg", "docs/a.gif", "docs/AGENTS.md", "CLAUDE.md", "gemini.md", "kimi.md", "SKILL.md", "soul.md", "tools.md", ".github/copilot-instructions.md",
    "internal/runtime/x.md", "internal/assets/x.md", "internal/templates/x.md", "internal/other/x.md", ".agents/x.md", ".claude/x.md", ".codex/x.md", ".cursor/x.md", ".opencode/x.md", "openspec/x.md", "runtime/x.md", "x/agent-notes.md", "x/my.prompt.md", "x/Skills_list.md", "x/instruction.md", "x/workflow.md", "x/orchestrator.md", "x/rules.md", "x/command.md", "x/runtimes.md", "docs/notes-skills.md", "docs/rule_x.md", "docs/a b.md",
    "package.json", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "bun.lock", "go.mod", "go.sum", "Cargo.toml", "Cargo.lock", "Pipfile", "Pipfile.lock", "poetry.lock", "pyproject.toml", "Gemfile", "Gemfile.lock", "composer.json", "composer.lock", "pom.xml", "build.gradle", "build.gradle.kts", "gradle.lockfile", "mix.exs", "mix.lock", "uv.lock", "deno.lock", "flake.lock", "requirements.txt", "requirements-dev.txt", "requirements/base.txt", "a/PACKAGE.JSON",
    ".gitlab-ci.yml", "Jenkinsfile", ".travis.yml", "azure-pipelines.yml", "bitbucket-pipelines.yml", "install", "install.sh", "install.ps1", "install.bat", "installer.sh", "release-please-config.json", "release.config.js", "release.config.cjs", ".releaserc", ".releaserc.json", ".releaserc.yml", ".goreleaser.yaml", "installer.rs", "install-deps.sh", ".github/workflows/ci.yml", ".github/workflows/x.sh", ".github/actions/a/action.yml", ".circleci/config.yml", ".GitHub/Workflows/ci.yml",
    "lefthook.yml", ".lefthook.yml", ".pre-commit-config.yaml", "hooks.json", ".husky/pre-commit", ".githooks/x", ".git-hooks/x", "hooks/x", "a/hooks/b/c", "x/hooks", "Hooks/x",
    "a.schema.json", "x.proto", "x.avsc", "openapi.yaml", "swagger.json", "contracts/a.txt", "contract/a.txt", "schemas/a.txt", "schema/a.txt", "docs/contracts/a.txt", "testdata/contracts/a.txt", "fixtures/schema/a.json", "Contracts/a.txt",
    ".env", ".env.local", ".npmrc", ".pypirc", ".netrc", ".htpasswd", "id_rsa", "id_rsa.pub", "id_ed25519", "a/key.pem", "a/x.key", "a/x.p12", "a/x.pfx", "a/x.jks", "config/secrets.txt", "config/secret.yml", "credentials.json", "a/credential_store.ts", "password.txt", "passwd", "apikey.ts", "api-keys.ts", "keystore.go", "src/secrets_test.go", "docs/secrets.md", "README.secrets", "a/readme.password", "fixtures/secrets.txt",
    "permissions.ts", "src/acl.go", "acls.json", "rbac.rs", "sudoers", "iam.tf", "CODEOWNERS", ".github/CODEOWNERS", "permission_test.go", "docs/permissions.md", "src/iam-policy.json",
    "src/auth/login.ts", "auth.go", "a/security.py", "webhook.rb", "payments/x.php", "src/payments.ts", "src/Auth.ts", "src/auth_test.go", "src/auth.spec.ts", "a/authz.ts", "x/authentication.ts", "a-auth-b.js",
    "src/service-token.ts", "src/service_token.json", "src/service-token-helper.py", "src/service.token.ts", "a/service-token/x.txt", "src/servicetoken.ts", "src/service--token.ts", "src/service-token.md", "docs/service-token.ts", "src/service-token.spec.ts", "src/a.sh", "x.bash", "y.zsh", ".github/workflows/z.yml", ".github/workflows/z.yaml", "other/z.yml",
    "a_test.go", "a.test.ts", "a.spec.js", "test_a.py", "a_test.py", "__tests__/a.ts", "pkg/testdata/a.go", "src/test_a.go", "pkg/testdata/golden/a.golden", "testdata/golden/a.golden", "a.golden",
    "Dockerfile", "Makefile", "CMakeLists.txt", "a.json", "a.yaml", "a.yml", "a.toml", "a.ini", "a.env", "a.txt", "a.c", "a.cc", "a.cpp", "a.cs", "a.go", "a.h", "a.hpp", "a.java", "a.js", "a.jsx", "a.kt", "a.kts", "a.php", "a.py", "a.rb", "a.rs", "a.ts", "a.tsx", "a.mjs", "a.cjs", "a.mts", "a.cts", "a.swift", "a.lua", "a.sql", "a", "a.", ".a", "a/.b", "a.TXT", "a.TS",
    "ünï/☃.ts", "日本語.md", "a b/c d.ts", "\U0001f600/x.ts", "～.ts", "x/﻿.md", "a.ts ", "İ.md", "ſ/x.sh", "a.K.ts",
]

MODES = [("100644", "100644"), ("100644", "100755"), ("100755", "100644"), ("100755", "100755"), ("100644", None), (None, "100755"), ("100644", "120000"), ("120000", "100644"), ("100644", "160000"), ("160000", "100644"), ("120000", "120000")]


def test_path_classes_over_a_path_corpus(trees):
    f, t, ident = trees
    cases = []
    for p in PATHS:
        cases.append(({}, {p: F}, 1))
        cases.append(({p: ("100644", b"y\n")}, {p: F}, 2))
        cases.append(({p: F}, {}, 1))
        cases.append(({}, {p: F}, 500))
    run_pairs(f, t, ident, cases)


def test_modes_over_a_path_corpus(trees):
    f, t, ident = trees
    cases = []
    paths = ["a.ts", "run.sh", "docs/a.md", "docs/a.png", "conf.yaml", "src/auth/x.ts", "pkg/testdata/golden/x.golden", "vendor/lib"]
    for p in paths:
        for old, new in MODES:
            def entry(mode, tag):
                if mode is None:
                    return None
                if mode == "160000":
                    return (mode, ident_oid(f).encode())
                return (mode, b"target.txt" if mode == "120000" else f"{tag}\n".encode())

            b = entry(old, "old")
            c = entry(new, "old" if old == new else "new")
            cases.append(({p: b} if b else {}, {p: c} if c else {}, 0 if old == new else 1))
    run_pairs(f, t, ident, cases)


def ident_oid(f) -> str:
    return git(f.repo, "rev-parse", "HEAD").strip()


LINES = [
    "", "x = 1", "subprocess.run(x)", "import subprocess", "from subprocess import run", "x = exec(y)", "myexec(y)", "exec", " exec ", "child_process", "execute_process(x)", "my_subprocess", "a.subprocess", "EXEC(x)", "SubProcess.run()", "execSync(x)", "Runtime.getRuntime().exec(c)",
    "new ProcessBuilder(a)", "os.system('ls')", "os.execv('a', b)", "os.execlp('a')", "os.execvpe(a)", "posix_spawn(a)", "proc_open(a)", "shell_exec(a)", "passthru(a)", "popen(a)", "Process.Start(a)", "spawn('a')", "spawn ('a')", "respawn('a')", "cp.spawn('a')", "x.spawnSync('a')", "execFile('a')", "x.execFileSync ( 'a' )", "Bun.spawn(['a'])", "Deno.Command('a')", "spawn ('a')", "ſubprocess", "ＳＵＢprocess",
    "fetch('x')", "obj.fetch('x')", "x = fetch  (u)", "afetch(u)", "axios(u)", "axios.get(u)", "axios.create(u)", "axios.foo", "http.request(o)", "https.get(u)", "net.connect(p)", "tls.connect(p)", "dgram.createSocket('udp4')", "net.Socket()", "from 'node:http'", "from \"node:net\"", "require('http')", "require( \"node:dns\" )", "new WebSocket(u)", "new XMLHttpRequest()", "new EventSource(u)",
    "requests.get(u)", "requests.head (u)", "urllib.request.urlopen(u)", "urlopen(u)", "httpx.get(u)", "socket.socket()", "http.Get(u)", "http.ListenAndServe(a, b)", "net.Dial(a, b)", "net.ListenTCP(a)", "curl http://x", "wget -q x", "curl", "curl  ", "xcurl http://x",
    "rmSync(p)", "rmdirSync(p)", "unlinkSync(p)", "fs.rm(p)", "fs.promises.unlink(p)", "fs.rmdir (p)", "rm -rf /", "rm -f x", "a; rm -rf x", "a && rm -r x", "echo | rm -rf y", "(rm -rf z)", "arm -rf x", "rm x", "rm -i x", "shutil.rmtree(p)", "os.remove(p)", "os.unlink(p)", "os.rmdir(p)", "os.removedirs(p)", "os.RemoveAll(p)", "Files.delete(p)", "Files.deleteIfExists(p)", "remove_dir_all(p)", "FileUtils.rm_rf(p)", "FileUtils.remove_entry_secure(p)", "unlink(p)", "x.unlink(p)", "$unlink(p)",
    "InsecureSkipVerify: true", "InsecureSkipVerify : true", "rejectUnauthorized: false", "NODE_TLS_REJECT_UNAUTHORIZED=0", "NODE_TLS_REJECT_UNAUTHORIZED = '0'", "verify=False", "verify = False", "CERT_NONE", "check_hostname = False", ".danger_accept_invalid_certs(true)", "curl -k https://x", "curl --insecure https://x", "curl -sSk https://x", "curl https://x --insecure", "curl -k",
    "pickle.loads(x)", "pickle.load(x)", "yaml.unsafe_load(x)", "marshal.loads(x)", "new ObjectInputStream(x)", "Marshal.load(x)", "YAML.load(x)", "eval(x)", "x = eval (y)", "x.eval(y)", "evaluate(x)", "new Function('a')", "vm.runInNewContext(c)",
    "subprocess.run(x, shell=True)", "subprocess.Popen(a, shell = True)", "subprocess.run(a); shell=True", "sh('-c')", "[\"sh\", \"-c\", cmd]", "['bash', '-c', 'echo ' + x]", "[\"sh\",\"-c\",f\"x\"]", "'sh', '-c', `x`", "Access-Control-Allow-Origin: *; Access-Control-Allow-Credentials: true", "access-control-allow-origin: *; access-control-allow-credentials: TRUE",
    "chmod(p, 0o777)", "os.chmod(p, 0777)", "mkdirSync(p, 0666)", "WriteFile(p, d, 0666)", "umask(0)", "umask( 0 )", "chmod 777 x", "chmod -R 777 x", "chmod o+w x", "chmod 755 x", "jwt.decode(t, verify=False)", "jwt.decode(t, options={'verify_signature': False})", "jwt.ParseUnverified(t, c)", "x.ParseUnverified(t)", "@csrf_exempt", "WTF_CSRF_ENABLED = False", "csrf: false", "csrf => false",
    "// spawn('a')", "# spawn('a')", "-- spawn('a')", "/* spawn('a') */", "/* spawn('a')", "*/", " * spawn('a')", "* spawn('a')", "*spawn('a')", "\t// x", " // x", "x(); // spawn('a')", "'#' spawn('a')", "#!/bin/sh", "﻿#!/bin/sh",
    "é" * 3000 + " spawn('a')", "a" * 5000 + " spawn('a')", "a" * 4090 + " spawn('a')", "\U0001f600" * 2100 + "spawn('a')", "x" * 4090 + "\U0001f600fetch('a')",
]

LINE_PATHS = ["a.ts", "a.py", "a.sh", "a.go"]
LINE_PATHS_EXTRA = ["a.js", "a.rs", "a.java", "a.rb", "a.php", "a.cs", "a.c", "a.kt", "a.yaml", "Dockerfile", "a.txt", "a.md", "a.sql", "a.json", ".env", "a.lua", "a.mts", "a.bash"]


def test_added_line_scanners_over_a_line_corpus(trees):
    f, t, ident = trees
    cases = []
    for line in LINES:
        for p in LINE_PATHS:
            cases.append(({}, {p: ("100644", (line + "\n").encode("utf-8", "surrogatepass"))}, 1))
    run_pairs(f, t, ident, cases)


def test_added_line_scanners_over_extension_variety(trees):
    f, t, ident = trees
    picks = ["spawn('a')", "fetch(u)", "rm -rf x", "eval(x)", "InsecureSkipVerify: true", "verify=False", "curl -k https://x", "x = 1", "# c", "// c", "-- c", "pickle.load(f)", "new ObjectInputStream(x)", "Marshal.load(x)", "@csrf_exempt", "chmod 777 x", "csrf: false"]
    cases = []
    for line in picks:
        for p in LINE_PATHS_EXTRA:
            cases.append(({}, {p: ("100644", (line + "\n").encode())}, 1))
    run_pairs(f, t, ident, cases)


def test_multi_line_files_hunks_removals_and_context(trees):
    f, t, ident = trees
    old = "".join(f"line {i}\n" for i in range(20)).encode()
    cands = {
        "removal": b"".join(f"line {i}\n".encode() for i in range(20) if i % 3),
        "spawn added mid": old.replace(b"line 5\n", b"line 5\nspawn('a')\nfetch(u)\n"),
        "only removed spawn": b"line 0\n",
        "added line that looks like a diff header": b"+++ b/other.ts\n--- a/x\n@@ -1 +1 @@\nspawn('a')\n",
        "added diff --git": b"diff --git a/z b/z\n+fetch(u)\n",
        "CRLF": b"a\r\nspawn('a')\r\n",
        "no newline at eof": b"spawn('a')",
        "NUL in file": b"spawn('a')\n\0\n",
        "invalid utf8 line": b"\xffspawn('a')\n\xfe\n",
        "bom": b"\xef\xbb\xbfspawn('a')\n",
        "lone cr": b"a\rspawn('a')\n",
        "ls": " spawn('a')\n".encode(),
    }
    cases = []
    for name, content in cands.items():
        for p in ("a.ts", "a.py", "a.sh"):
            cases.append(({p: ("100644", old)}, {p: ("100644", content)}, 7))
    run_pairs(f, t, ident, cases)


def test_multi_file_snapshots_dedupe_and_sort(trees):
    f, t, ident = trees
    files = {f"{d}/x.ts": ("100644", b"spawn('a')\nfetch(u)\neval(x)\nrm -rf y\n") for d in ("b", "a", "\U0001f600", "～", "é", "Z", "z", "a b", "-")}
    files |= {"w/y.sh": ("100644", b"echo\n"), "w/package.json": F, ".github/workflows/a.yml": F, "contracts/x.json": F, "src/auth/a.ts": F}
    cases = [({}, files, 3), ({}, files, 400), ({k: ("100644", b"old\n") for k in files}, files, 12)]
    sub = {k: v for k, v in files.items() if k.endswith(".ts")}
    cases += [({}, dict(list(sub.items())[:i]), 1) for i in range(1, len(sub) + 1)]
    run_pairs(f, t, ident, cases)


def test_snapshot_field_variants_and_errors(make_repo):
    f = make_repo()
    ident = S.resolve_repository(f.repo)
    write(f.p("a.txt"), "changed\n")
    snap = freeze(f.repo)
    other = dict(snap)
    calls = [[snap, ident], [{**snap, "changedLines": 399}, ident], [{**snap, "changedLines": 400}, ident], [{**snap, "paths": []}, ident], [{**snap, "paths": ["nope"]}, ident], [{**snap, "baseTree": "x"}, ident], [{**snap, "candidateTree": "x"}, ident],
             [{**snap, "baseTree": snap["candidateTree"]}, ident], [snap, ident, {"gitTimeoutMs": 1}], [snap, ident, {"gitTimeoutMs": 60000}], [snap, {**ident, "root": "/nonexistent"}], [snap, {**ident, "root": os.path.join(f.dir, "none")}], [other, ident]]
    same("assessRisk", R.assess_risk, calls)
