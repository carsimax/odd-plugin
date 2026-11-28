"""Risk classification for the review engine (port of v9 review/risk.ts; read that file's header for the tiering rationale).

Reads ONLY the two frozen trees of a snapshot (base vs candidate) through git plumbing, with the same sanitized environment,
timeouts and output bounds as snapshot.py (it reuses `run_git`). Tiering: any reason carrying a `signal` is high; a lone
`non_executable_only` is low; everything else is medium. Bounded: no blob over MAX_BLOB_SCAN_BYTES and no more than
MAX_TOTAL_SCAN_BYTES of blobs are read; exceeding either fails closed to a high `process_scan_limit` reason.

Data keeps v9's shapes (plain dicts with v9 keys): a reason is `{"code", "signal"?, "path"?, "old_mode"?, "new_mode"?}` (absent
keys are omitted, never None); `assess_risk` returns `{"risk_level", "level", "reasons", "evidence", "focusLens"?}`.
Public API: `LARGE_CHANGE_LINES`, `MAX_BLOB_SCAN_BYTES`, `MAX_TOTAL_SCAN_BYTES`, `assess_risk`, `assess_candidate`.
"""
import math
import re
from dataclasses import dataclass

from ..lib.js import js_number, js_trim, utf16_head, utf16_len
from .snapshot import (
    OUTPUT_LIMIT,
    SnapshotError,
    bound_of,
    decode_name,
    freeze_snapshot,
    is_generated_golden_path,
    nul_records,
    run_git,
)

LARGE_CHANGE_LINES = 400
MAX_BLOB_SCAN_BYTES = 1024 * 1024
MAX_TOTAL_SCAN_BYTES = 8 * 1024 * 1024
_MAX_SCAN_LINE_CHARS = 4096
_MAX_EVIDENCE_LINES = 12
_PATHSPEC_BATCH_CHARS = 24_000
_PATHSPEC_BATCH_ENTRIES = 400
_ZERO_OID = re.compile(r"0+")

_SOURCE_EXTENSIONS = {
    ".c", ".cc", ".cpp", ".cs", ".go", ".h", ".hpp", ".java", ".js", ".jsx", ".kt", ".kts", ".php", ".py",
    ".rb", ".rs", ".sh", ".bash", ".zsh", ".ts", ".tsx", ".mjs", ".cjs", ".mts", ".cts",
}

# ---------------------------------------------------------------------------------------------
# JS regex semantics: ASCII \w \d \b, JS `\s`, `$` = end of input, ASCII-only case folding
# ---------------------------------------------------------------------------------------------

_WS = "\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff"


def _js_re(src: str, ignore_case: bool = False) -> re.Pattern:
    """Compiles a JS regex source (no `\\s` inside classes, no multiline) with the JS meaning of `\\s`, `\\S` and `$`."""
    out, i, in_class = [], 0, False
    while i < len(src):
        c = src[i]
        if c == "\\":
            n = src[i + 1]
            out.append(_WS if n == "s" and in_class else f"[{_WS}]" if n == "s" else f"[^{_WS}]" if n == "S" else c + n)
            i += 2
            continue
        if c == "[" and not in_class:
            in_class = True
        elif c == "]" and in_class:
            in_class = False
        elif c == "$" and not in_class:
            out.append("\\Z")
            i += 1
            continue
        out.append(c)
        i += 1
    return re.compile("".join(out), re.A | (re.I if ignore_case else 0))


# ---------------------------------------------------------------------------------------------
# diff stats from the frozen trees
# ---------------------------------------------------------------------------------------------


@dataclass
class _Stat:
    path: str
    old_mode: str
    new_mode: str
    old_oid: str
    new_oid: str
    additions: int
    deletions: int
    binary: bool
    mode_only: bool


def _utf8(s: str) -> bytes:
    return s.encode("utf-16", "surrogatepass").decode("utf-16", "replace").encode("utf-8")


_RAW_META = re.compile(r":([0-9]{6}) ([0-9]{6}) ([0-9a-f]+) ([0-9a-f]+) [A-Z][0-9]*")


def _digits(s: str) -> bool:
    return s != "" and all("0" <= c <= "9" for c in s)


def _collect_stats(snapshot: dict, repo: dict, bound: dict) -> list[_Stat]:
    common = ["--no-renames", "--no-ext-diff", "--no-textconv", "--ignore-submodules=none", snapshot["baseTree"], snapshot["candidateTree"], "--"]
    raw = run_git(cwd=repo["root"], args=["diff", "--raw", "--no-abbrev", "-z", *common], timeout_ms=bound["timeoutMs"], limit=64 * 1024 * 1024).stdout
    numstat = run_git(cwd=repo["root"], args=["diff", "--numstat", "-z", *common], timeout_ms=bound["timeoutMs"], limit=64 * 1024 * 1024).stdout

    counts: dict[str, tuple[int, int, bool]] = {}
    for record in nul_records(numstat):
        text = decode_name(record, "diff stat record")
        first = text.find("\t")
        second = -1 if first < 0 else text.find("\t", first + 1)
        if first < 0 or second < 0:
            raise SnapshotError("corrupt_output", "unexpected diff stat record")
        a, d, path = text[:first], text[first + 1 : second], text[second + 1 :]
        if a == "-" and d == "-":
            counts[path] = (0, 0, True)
        elif _digits(a) and _digits(d):
            counts[path] = (int(a), int(d), False)
        else:
            raise SnapshotError("corrupt_output", "unexpected diff stat counts")

    records = nul_records(raw)
    if len(records) % 2 != 0:
        raise SnapshotError("corrupt_output", "unexpected raw diff output")
    stats: list[_Stat] = []
    for i in range(0, len(records), 2):
        m = _RAW_META.fullmatch(records[i].decode("utf-8", "replace"))
        if not m:
            raise SnapshotError("corrupt_output", "unexpected raw diff record")
        path = decode_name(records[i + 1], "changed path")
        adds, dels, binary = counts.get(path, (0, 0, False))
        stats.append(_Stat(path, m[1], m[2], m[3], m[4], adds, dels, binary, not binary and adds + dels == 0 and m[3] == m[4]))
    frozen = set(snapshot["paths"])
    return sorted((s for s in stats if s.path in frozen), key=lambda s: _utf8(s.path))


# ---------------------------------------------------------------------------------------------
# path classes (pure)
# ---------------------------------------------------------------------------------------------


def _lower(s: str) -> str:
    return s.lower()


def _basename_raw(p: str) -> str:
    """Node `path.posix.basename`."""
    p = p.rstrip("/")
    return p[p.rfind("/") + 1 :]


def _extname_raw(path: str) -> str:
    """Node `path.posix.extname` (transcribed; ".env" and ".." have no extension)."""
    start_dot, start_part, end, matched_slash, pre_dot = -1, 0, -1, True, 0
    for i in range(len(path) - 1, -1, -1):
        code = path[i]
        if code == "/":
            if not matched_slash:
                start_part = i + 1
                break
            continue
        if end == -1:
            matched_slash = False
            end = i + 1
        if code == ".":
            if start_dot == -1:
                start_dot = i
            elif pre_dot != 1:
                pre_dot = 1
        elif start_dot != -1:
            pre_dot = -1
    if start_dot == -1 or end == -1 or pre_dot == 0 or (pre_dot == 1 and start_dot == end - 1 and start_dot == start_part + 1):
        return ""
    return path[start_dot:end]


def _ext(p: str) -> str:
    return _lower(_extname_raw(p))


def _base(p: str) -> str:
    return _lower(_basename_raw(p))


def _segments(p: str) -> list[str]:
    return p.split("/")


def _is_test_path(p: str) -> bool:
    segs = _segments(_lower(p))
    for seg in segs[:-1]:
        if seg in ("__tests__", "testdata"):
            return True
    name = segs[-1]
    return name.endswith("_test.go") or ".test." in name or ".spec." in name or (name.startswith("test_") and name.endswith(".py")) or name.endswith("_test.py")


def _has_excluded_segment(p: str) -> bool:
    return any(_lower(s) in ("docs", "testdata", "fixture", "fixtures", "__fixtures__") for s in _segments(p))


_CONFIG_BASENAMES = {"go.mod", "go.sum", "package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "dockerfile", "makefile"}


def _is_config_path(p: str) -> bool:
    b = _base(p)
    if b == ".env" or b.startswith(".env.") or b in _CONFIG_BASENAMES:
        return True
    return _ext(p) in (".json", ".yaml", ".yml", ".toml", ".ini", ".env")


def _strip_semantic_ext(segment: str) -> str:
    return segment[: len(segment) - len(_extname_raw(segment))] if _ext(segment) in _SOURCE_EXTENSIONS or _is_config_path(segment) else segment


def _is_service_token_path(p: str) -> bool:
    for seg in _segments(p):
        tokens = [t for t in re.split(r"[-_]", _lower(_strip_semantic_ext(seg))) if t]
        for i in range(len(tokens) - 1):
            if tokens[i] == "service" and tokens[i + 1] == "token":
                return True
    return False


def _is_shell_path(p: str) -> bool:
    e = _ext(p)
    if e in (".sh", ".bash", ".zsh"):
        return True
    return e in (".yml", ".yaml") and p.startswith(".github/workflows/")


_TOKEN_SPLIT = re.compile(r"[/\\._-]+")


def _hot_path_signals(p: str) -> list[str]:
    if _is_test_path(p):
        return []
    out: set[str] = set()
    for token in _TOKEN_SPLIT.split(_lower(p)):
        if token == "auth":
            out.add("auth")
        elif token in ("security", "webhook"):
            out.add("security")
        elif token == "payments":
            out.add("payments")
    return sorted(out)


_DEPENDENCY_BASENAMES = {
    "package.json", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "bun.lock", "go.mod", "go.sum",
    "cargo.toml", "cargo.lock", "pipfile", "pipfile.lock", "poetry.lock", "pyproject.toml", "gemfile", "gemfile.lock", "composer.json",
    "composer.lock", "pom.xml", "build.gradle", "build.gradle.kts", "gradle.lockfile", "mix.exs", "mix.lock", "uv.lock", "deno.lock", "flake.lock",
}


def _is_dependency_path(p: str) -> bool:
    b = _base(p)
    return b in _DEPENDENCY_BASENAMES or (b.startswith("requirements") and b.endswith(".txt"))


_CI_BASENAMES = {
    ".gitlab-ci.yml", "jenkinsfile", ".travis.yml", "azure-pipelines.yml", "bitbucket-pipelines.yml", "install", "install.sh", "install.ps1", "install.bat",
    "installer.sh", "release-please-config.json", "release.config.js", "release.config.cjs", ".releaserc", ".releaserc.json", ".releaserc.yml",
}


def _is_ci_release_path(p: str) -> bool:
    b = _base(p)
    lp = _lower(p)
    if lp.startswith(".github/workflows/") or lp.startswith(".github/actions/") or lp.startswith(".circleci/"):
        return True
    return b in _CI_BASENAMES or b.startswith(".goreleaser.") or b.startswith("installer.") or b.startswith("install-")


def _is_hook_path(p: str) -> bool:
    b = _base(p)
    if b in ("lefthook.yml", ".lefthook.yml", ".pre-commit-config.yaml", "hooks.json"):
        return True
    return any(s in (".husky", ".githooks", ".git-hooks", "hooks") for s in _segments(_lower(p))[:-1])


def _is_contract_path(p: str) -> bool:
    if _has_excluded_segment(p):
        return False
    b = _base(p)
    if b.endswith(".schema.json") or b.endswith(".proto") or b.endswith(".avsc") or b.startswith("openapi.") or b.startswith("swagger."):
        return True
    return any(s in ("contracts", "contract", "schemas", "schema") for s in _segments(_lower(p))[:-1])


_CREDENTIAL_TOKENS = {"secret", "secrets", "credential", "credentials", "password", "passwords", "passwd", "apikey", "apikeys", "keystore"}


def _is_credential_path(p: str) -> bool:
    b = _base(p)
    if b == ".env" or b.startswith(".env.") or b in (".npmrc", ".pypirc", ".netrc", ".htpasswd") or b.startswith("id_rsa") or b.startswith("id_ed25519"):
        return True
    if _ext(p) in (".pem", ".key", ".p12", ".pfx", ".jks"):
        return True
    if _is_test_path(p) or _has_excluded_segment(p) or b.startswith("readme"):
        return False
    return any(t in _CREDENTIAL_TOKENS for t in _TOKEN_SPLIT.split(_lower(p)))


_PERMISSION_TOKENS = {"permission", "permissions", "acl", "acls", "rbac", "sudoers", "iam", "codeowners"}


def _is_permission_path(p: str) -> bool:
    if _is_test_path(p) or _has_excluded_segment(p) or _base(p).startswith("readme"):
        return False
    return any(t in _PERMISSION_TOKENS for t in _TOKEN_SPLIT.split(_lower(p)))


def _is_inspectable(s: _Stat) -> bool:
    return s.additions + s.deletions != 0 and not s.binary and not s.mode_only and not is_generated_golden_path(s.path)


def _is_semantic_eligible(s: _Stat) -> bool:
    if not _is_inspectable(s) or _has_excluded_segment(s.path) or _base(s.path).startswith("readme"):
        return False
    return _ext(s.path) in _SOURCE_EXTENSIONS or _is_config_path(s.path)


def _is_content_scan_eligible(s: _Stat) -> bool:
    if not _is_inspectable(s) or _has_excluded_segment(s.path) or _is_test_path(s.path):
        return False
    return _ext(s.path) in _SOURCE_EXTENSIONS or _ext(s.path) == ".txt" or _is_config_path(s.path)


_NON_ALNUM = re.compile(r"[^a-z0-9]+")


def _is_operational_markdown(p: str) -> bool:
    lp = _lower(p)
    segs = lp.split("/")
    if _basename_raw(lp) in ("agents.md", "claude.md", "gemini.md", "kimi.md", "skill.md", "copilot-instructions.md"):
        return True
    for i, seg in enumerate(segs):
        if seg in (".agent", ".agents", ".claude", ".codex", ".cursor", ".opencode", "openspec", "runtime"):
            return True
        if i == 1 and segs[0] == "internal" and seg in ("runtime", "assets", "templates"):
            return True
        name = seg[: len(seg) - len(_extname_raw(seg))]
        for token in (t for t in _NON_ALNUM.split(name) if t):
            if token in ("agent", "agents", "skill", "skills", "prompt", "prompts", "instruction", "instructions", "orchestrator", "orchestrators", "workflow", "workflows"):
                return True
    return False


_OPERATIONAL_TOKENS = ["agent", "agents", "command", "commands", "prompt", "prompts", "rule", "rules", "runtime", "runtimes", "skill", "skills", "workflow", "workflows"]
_STEM_SPLIT = re.compile(r"[-_. ]+")


def _is_passive_candidate_path(p: str) -> bool:
    e = _ext(p)
    doc_ext = (not _is_operational_markdown(p)) if e == ".md" else e in (".mdx", ".rst", ".adoc", ".png", ".jpg", ".jpeg", ".gif")
    if not doc_ext or _is_config_path(p):
        return False
    lp = _lower(p)
    if lp.startswith("internal/assets/"):
        return False
    b = _basename_raw(lp)
    if b in ("agents.md", "claude.md", "gemini.md", "kimi.md", "soul.md", "tools.md", "skill.md", "copilot-instructions.md"):
        return False
    stem = b[: len(b) - len(_extname_raw(b))]
    if any(t in _OPERATIONAL_TOKENS for t in _STEM_SPLIT.split(stem)):
        return False
    for seg in lp.split("/"):
        if seg in (".github", ".claude", ".codex", ".cursor", ".gemini", ".kiro", ".kilo", ".opencode", ".windsurf", *_OPERATIONAL_TOKENS):
            return False
    return True


def _is_image_path(p: str) -> bool:
    return _ext(p) in (".png", ".jpg", ".jpeg", ".gif")


def _is_regular_non_exec(m: str) -> bool:
    return m in ("", "000000", "100644")


def _is_regular_file(m: str) -> bool:
    return m in ("100644", "100755")


def _is_passive_stat(s: _Stat) -> bool:
    if s.binary and not _is_image_path(s.path):
        return False
    if s.mode_only or not _is_passive_candidate_path(s.path):
        return False
    return _is_regular_non_exec(s.old_mode) and _is_regular_non_exec(s.new_mode)


def _parse_int8(s: str) -> float:
    """JS `parseInt(s, 8)`: the leading octal digits, NaN when there are none."""
    m = re.match(r"[0-7]+", s)
    return float(int(m[0], 8)) if m else math.nan


def _executable_bit_changed(old_mode: str, new_mode: str) -> bool:
    if not old_mode or not new_mode:
        return False
    o, n = _parse_int8(old_mode), _parse_int8(new_mode)
    return math.isfinite(o) and math.isfinite(n) and (int(o) & 0o111) != (int(n) & 0o111)


def _has_passive_image_signature(b: bytes) -> bool:
    return b.startswith(b"\x89PNG\r\n\x1a\n") or b.startswith(b"\xff\xd8\xff") or b.startswith(b"GIF87a") or b.startswith(b"GIF89a")


def _has_shebang(b: bytes) -> bool:
    return (b[3:5] if b.startswith(b"\xef\xbb\xbf") else b[:2]) == b"#!"


_MDX_ESM = re.compile(f"(?:^|(?<=[\\n\\r\\u2028\\u2029]))[{_WS}]*(?:import|export)\\b", re.A)


def _is_passive_content(p: str, content: bytes) -> bool:
    if _is_image_path(p):
        return _has_passive_image_signature(content)
    if b"\0" in content:
        return False
    try:
        text = content.decode("utf-8")
    except UnicodeDecodeError:
        return False
    if _has_shebang(content):
        return False
    if _ext(p) == ".mdx":
        return not _MDX_ESM.search(text)
    return True


# ---------------------------------------------------------------------------------------------
# content patterns over ADDED lines
# ---------------------------------------------------------------------------------------------

_PROCESS_LINE = _js_re(
    r"((^|[^A-Za-z0-9_.])(subprocess|child_process|execute_process|exec)([^A-Za-z0-9_]|$))"
    r"|(execSync\(|getRuntime\(\)\.exec\(|ProcessBuilder|os\.system\(|os\.exec[lv]p?e?\(|posix_spawn|proc_open\(|shell_exec\(|passthru\(|popen\(|Process\.Start\()"
    r"|((^|[^A-Za-z0-9_])(spawn|spawnSync|execFile|execFileSync)\s*\()|(\.(spawn|spawnSync|execFile|execFileSync)\s*\()|(Bun\.spawn|Deno\.Command)",
    True,
)

_NETWORK_LINES = [
    _js_re(s)
    for s in (
        r"(?:^|[^\w.])fetch\s*\(",
        r"\baxios(?:\.\w+)?\s*\(|\baxios\.(?:get|post|put|delete|patch|request)\b",
        r"\b(?:https?|net|tls|dgram)\.(?:request|get|connect|createConnection|createServer|Socket|createSocket)\b",
        r'''\bfrom\s+["']node:(?:https?|net|tls|dgram|dns)["']|\brequire\(\s*["'](?:node:)?(?:https?|net|tls|dgram|dns)["']\s*\)''',
        r"\bnew\s+(?:WebSocket|XMLHttpRequest|EventSource)\b",
        r"\brequests\.(?:get|post|put|delete|patch|request|head)\s*\(|\burllib\.request\b|\burlopen\s*\(|\bhttpx\.\w+\s*\(|\bsocket\.socket\s*\(",
        r"\bhttp\.(?:Get|Post|NewRequest|ListenAndServe|Head)\s*\(|\bnet\.(?:Dial|Listen)\w*\s*\(",
        r"\b(?:curl|wget)\s+\S",
    )
]

_FS_DELETE_LINES = [
    _js_re(s)
    for s in (
        r"\b(?:rmSync|rmdirSync|unlinkSync)\s*\(",
        r"\bfs(?:\.promises)?\.(?:rm|rmdir|unlink)\s*\(",
        r"(?:^|[;&|(]|\s)rm\s+-[a-zA-Z]*[rf]",
        r"\bshutil\.rmtree\s*\(|\bos\.(?:remove|unlink|rmdir|removedirs)\s*\(|\bos\.RemoveAll\s*\(",
        r"\bFiles\.delete(?:IfExists)?\s*\(|\bremove_dir_all\s*\(|\bFileUtils\.(?:rm|rm_rf|rm_r|remove_entry)\w*\s*\(",
        r"(?:^|[^\w.])unlink\s*\(",
    )
]

_JSX = ".js .jsx .ts .tsx .mjs .cjs .mts .cts"
_ALL = ".go .java .kt .kts .js .jsx .ts .tsx .mjs .cjs .py .php .rb .rs .cs"
_SINKS: list[tuple[str, re.Pattern]] = [
    (f" {e} ", _js_re(r, i))
    for e, r, i in (
        (".go", r"\bInsecureSkipVerify\s*:\s*true\b", False),
        (_JSX, r'''\brejectUnauthorized\s*:\s*false\b|\bNODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0\b''', False),
        (".py", r"\bverify\s*=\s*False\b|\bCERT_NONE\b|\bcheck_hostname\s*=\s*False\b", False),
        (".rs", r"\.danger_accept_invalid_certs\s*\(\s*true\s*\)", False),
        (".sh .bash .zsh", r"\bcurl\s+(?:[^;|]*\s)?(?:--insecure|-k)(?:\s|$)", False),
        (".py", r"\bpickle\.loads?\s*\(|\byaml\.unsafe_load\s*\(|\bmarshal\.loads?\s*\(", False),
        (".java .kt .kts", r"\bObjectInputStream\s*\(", False),
        (".rb", r"\bMarshal\.load\s*\(|\bYAML\.load\s*\(", False),
        (f"{_JSX} .py .php .rb", r"(?:^|[^\w.])eval\s*\(", False),
        (_JSX, r"\bnew\s+Function\s*\(|\bvm\.runInNewContext\s*\(", False),
        (".py", r"\bsubprocess\.(?:run|Popen|call|check_call|check_output)\s*\([^;\n]*\bshell\s*=\s*True\b", False),
        (_ALL, r'''["'](?:sh|bash)["']\s*,\s*["']-c["']\s*,\s*(?:\w+|["'][^"']*["']\s*\+|f["']|`)''', False),
        (_ALL, r"Access-Control-Allow-Origin[^;\n]*\*[^;\n]*;[^\n]*Access-Control-Allow-Credentials[^\n]*true", True),
        (_ALL, r"\b(?:chmod|mkdir|WriteFile|chmodSync|mkdirSync|writeFileSync)\s*\([^\n]*\b(?:0o777|0777|0666)\b|\bumask\s*\(\s*0\s*\)", True),
        (".sh .bash .zsh", r"\bchmod\s+(?:-R\s+)?(?:777\b|o\+w\b)", False),
        (".py", r'''\bjwt\.decode\s*\([^\n]*(?:\bverify\s*=\s*False\b|["']verify_signature["']\s*:\s*False\b)''', False),
        (".go", r"\b(?:jwt|\w+)\.ParseUnverified\s*\(", False),
        (".py", r"@csrf_exempt\b|\bWTF_CSRF_ENABLED\s*=\s*False\b", False),
        (f"{_JSX} .php .rb", r"\bcsrf\s*:\s*false\b|\bcsrf\s*=>\s*false\b", False),
    )
]


def _comment_syntax(p: str) -> str:
    b = _base(p)
    if b in ("dockerfile", "makefile", "cmakelists.txt", ".env") or b.startswith(".env.") or (b.startswith("requirements") and b.endswith(".txt")):
        return "hash"
    e = _ext(p)
    if e in (".sh", ".bash", ".zsh", ".py", ".rb", ".pl", ".pm", ".r", ".ps1", ".psm1", ".yaml", ".yml", ".toml", ".ini", ".conf", ".cfg", ".cmake", ".mk", ".tf", ".nix"):
        return "hash"
    if e in (".sql", ".lua", ".hs", ".adb", ".ads"):
        return "dash"
    if e in (".c", ".cc", ".cpp", ".h", ".hpp", ".cs", ".go", ".java", ".js", ".jsx", ".kt", ".kts", ".php", ".rs", ".swift", ".ts", ".tsx", ".scala", ".dart", ".mjs", ".cjs", ".mts", ".cts"):
        return "slash"
    return "unknown"


def _is_comment_only(p: str, line: str) -> bool:
    t = js_trim(line)
    syntax = _comment_syntax(p)
    if syntax == "hash":
        return t.startswith("#")
    if syntax == "dash":
        return t.startswith("--")
    if syntax == "slash":
        if t.startswith("//"):
            return True
        if t.startswith("/*"):
            closing = t.find("*/", 2)
            return closing < 0 or js_trim(t[closing + 2 :]) == ""
        if t.startswith("*/"):
            return js_trim(t[2:]) == ""
        return t == "*" or t.startswith("* ") or t.startswith("*\t")
    return False


def _sink_line(p: str, line: str) -> bool:
    e = f" {_ext(p)} "
    return any(e in exts and re_.search(line) for exts, re_ in _SINKS)


# ---------------------------------------------------------------------------------------------
# bounded blob access (frozen objects only)
# ---------------------------------------------------------------------------------------------


def _num(s: str) -> float:
    """JS `Number(s)`."""
    s = js_trim(s)
    return 0.0 if s == "" else js_number(s)


def _blob_sizes(cwd: str, oids: list[str], bound: dict) -> dict[str, int]:
    sizes: dict[str, int] = {}
    if len(oids) == 0:
        return sizes
    out = run_git(cwd=cwd, args=["cat-file", "--batch-check"], input="\n".join(oids) + "\n", timeout_ms=bound["timeoutMs"], limit=OUTPUT_LIMIT).stdout.decode("utf-8", "replace")
    for line in out.split("\n"):
        f = line.split(" ")
        if len(f) == 3 and f[1] == "blob" and _digits(f[2]):
            sizes[f[0]] = int(_num(f[2]))
    return sizes


def _read_blobs(cwd: str, oids: list[str], sizes: dict[str, int], bound: dict) -> dict[str, bytes]:
    blobs: dict[str, bytes] = {}
    if len(oids) == 0:
        return blobs
    total = sum(sizes.get(o, 0) for o in oids)
    out = run_git(cwd=cwd, args=["cat-file", "--batch"], input="\n".join(oids) + "\n", timeout_ms=bound["timeoutMs"], limit=total + len(oids) * 160 + 4096).stdout
    pos = 0
    while pos < len(out):
        nl = out.find(b"\n", pos)
        if nl < 0:
            break
        header = out[pos:nl].decode("utf-8", "replace").split(" ")
        if len(header) < 2 or header[1] != "blob":
            pos = nl + 1
            continue
        size = _num(header[2]) if len(header) > 2 else math.nan
        if not (math.isfinite(size) and size.is_integer()) or nl + 1 + size > len(out):
            raise SnapshotError("corrupt_output", "unexpected cat-file output")
        size = int(size)
        blobs[header[0]] = out[nl + 1 : nl + 1 + size]
        pos = nl + 1 + size + 1
    return blobs


_LITERAL = ":(literal)"


def _pathspec_batches(paths: list[str]) -> list[list[str]]:
    batches: list[list[str]] = []
    current: list[str] = []
    chars = 0
    for p in paths:
        spec = f"{_LITERAL}{p}"
        if len(current) > 0 and (chars + utf16_len(spec) > _PATHSPEC_BATCH_CHARS or len(current) >= _PATHSPEC_BATCH_ENTRIES):
            batches.append(current)
            current = []
            chars = 0
        current.append(spec)
        chars += utf16_len(spec) + 1
    if len(current) > 0:
        batches.append(current)
    return batches


# ---------------------------------------------------------------------------------------------
# assessment
# ---------------------------------------------------------------------------------------------


def _u16(s: str | None) -> bytes:
    """JS `<` on strings compares UTF-16 code units; big-endian UTF-16 bytes sort the same way."""
    return (s or "").encode("utf-16-be", "surrogatepass")


def _canonical_reasons(reasons: list[dict]) -> list[dict]:
    ordered = sorted(reasons, key=lambda r: tuple(_u16(r.get(k)) for k in ("code", "signal", "path", "old_mode", "new_mode")))
    seen: set[str] = set()
    out: list[dict] = []
    for r in ordered:
        key = f"{r['code']}\0{r.get('signal') or ''}"
        if key in seen:
            continue
        seen.add(key)
        out.append(r)
    return out


def _level_from_reasons(reasons: list[dict]) -> str:
    if any("signal" in r for r in reasons):
        return "high"
    if len(reasons) == 1 and reasons[0]["code"] == "non_executable_only":
        return "low"
    return "medium"


def _focus_for(reasons: list[dict]) -> str:
    codes = {r["code"] for r in reasons}
    if "file_deletion" in codes:
        return "resilience"
    if "large_change" in codes:
        return "readability"
    return "risk"


def _evidence_for(level: str, reasons: list[dict]) -> list[str]:
    if level == "low":
        return ["documentation or other non-executable files only"]
    lines = [f"{r['code']}{' [' + r['signal'] + ']' if r.get('signal') else ''}{': ' + r['path'] if r.get('path') else ''}" for r in reasons]
    return [*lines[:_MAX_EVIDENCE_LINES], f"… {len(lines) - _MAX_EVIDENCE_LINES} more"] if len(lines) > _MAX_EVIDENCE_LINES else lines


def _scan_limit(path: str) -> dict:
    return {"code": "process_scan_limit", "signal": "shell_process", "path": path}


def assess_risk(snapshot: dict, repo: dict, options: dict | None = None) -> dict:
    """Classify a frozen snapshot from its two trees only. Deterministic; bounded; never reads the worktree."""
    bound = bound_of(options)
    cwd = repo["root"]
    stats = _collect_stats(snapshot, repo, bound)
    candidates: list[dict] = []

    # name/mode based evidence
    for s in stats:
        golden = is_generated_golden_path(s.path)
        if _is_semantic_eligible(s):
            if _is_service_token_path(s.path) and not _is_test_path(s.path):
                candidates.append({"code": "service_token", "signal": "auth", "path": s.path})
            if _is_shell_path(s.path):
                candidates.append({"code": "shell_source", "signal": "shell_process", "path": s.path})
        if _executable_bit_changed(s.old_mode, s.new_mode):
            candidates.append({"code": "executable_mode", "signal": "permissions", "path": s.path, "old_mode": s.old_mode, "new_mode": s.new_mode})
        if golden:
            continue
        for signal in _hot_path_signals(s.path):
            candidates.append({"code": "hot_path", "signal": signal, "path": s.path})
        if _is_test_path(s.path):
            continue
        for ok, code, signal, in (
            (_is_dependency_path, "dependency_change", "dependency"),
            (_is_ci_release_path, "ci_release_change", "ci_release"),
            (_is_hook_path, "hook_change", "hooks"),
            (_is_contract_path, "contract_change", "contract"),
            (_is_credential_path, "credential_path", "credentials"),
            (_is_permission_path, "permission_path", "permissions"),
        ):
            if ok(s.path):
                candidates.append({"code": code, "signal": signal, "path": s.path})

    # blob budget: sizes first, then bounded reads
    scan_stats = [s for s in stats if _is_content_scan_eligible(s)]
    passive_stats = [s for s in stats if _is_passive_stat(s) and _is_regular_file(s.new_mode) and not _ZERO_OID.fullmatch(s.new_oid)]
    size_oids: set[str] = set()
    for s in scan_stats:
        if _is_regular_file(s.old_mode) and not _ZERO_OID.fullmatch(s.old_oid):
            size_oids.add(s.old_oid)
        if _is_regular_file(s.new_mode) and not _ZERO_OID.fullmatch(s.new_oid):
            size_oids.add(s.new_oid)
    for s in passive_stats:
        size_oids.add(s.new_oid)
    sizes = _blob_sizes(cwd, sorted(size_oids), bound)

    limit_hit: str | None = None
    total = 0
    oversized_passive: set[str] = set()

    def side_blobs(s: _Stat) -> list[str]:
        return [o for o in (s.old_oid if s.old_mode and _is_regular_file(s.old_mode) else "", s.new_oid if _is_regular_file(s.new_mode) else "") if o != "" and not _ZERO_OID.fullmatch(o)]

    for s in scan_stats:
        for oid in side_blobs(s):
            size = sizes.get(oid, 0)
            total += size
            if (size > MAX_BLOB_SCAN_BYTES or total > MAX_TOTAL_SCAN_BYTES) and limit_hit is None:
                limit_hit = s.path
    for s in passive_stats:
        size = sizes.get(s.new_oid, 0)
        total += size
        if size > MAX_BLOB_SCAN_BYTES or total > MAX_TOTAL_SCAN_BYTES:
            oversized_passive.add(s.path)

    contradicted = set(oversized_passive)
    if limit_hit is not None:
        candidates.append(_scan_limit(limit_hit))
    else:
        read_oids: set[str] = set()
        for s in scan_stats:
            if _is_regular_file(s.new_mode) and not _ZERO_OID.fullmatch(s.new_oid):
                read_oids.add(s.new_oid)
        for s in passive_stats:
            if s.path not in oversized_passive:
                read_oids.add(s.new_oid)
        blobs = _read_blobs(cwd, sorted(read_oids), sizes, bound)
        for s in scan_stats:
            blob = blobs.get(s.new_oid) if _is_regular_file(s.new_mode) else None
            if blob is not None and _has_shebang(blob):
                candidates.append({"code": "process_boundary", "signal": "shell_process", "path": s.path})
        for s in passive_stats:
            blob = blobs.get(s.new_oid)
            if s.path in oversized_passive or blob is None or not _is_passive_content(s.path, blob):
                contradicted.add(s.path)
        candidates.extend(_scan_added_lines(snapshot, cwd, scan_stats, bound))

    # non-signal evidence
    for s in stats:
        if is_generated_golden_path(s.path):
            continue
        passive = _is_passive_stat(s) and s.path not in contradicted
        if s.new_mode == "120000" or s.old_mode == "120000":
            candidates.append({"code": "symlink_change", "path": s.path})
        elif s.new_mode == "160000" or s.old_mode == "160000":
            candidates.append({"code": "submodule_change", "path": s.path})
        elif s.binary and not (_is_image_path(s.path) and passive):
            candidates.append({"code": "binary_change", "path": s.path})
        elif s.new_mode == "000000" and not passive:
            candidates.append({"code": "file_deletion", "path": s.path})
    if snapshot["changedLines"] >= LARGE_CHANGE_LINES:
        candidates.append({"code": "large_change"})

    reasons = _canonical_reasons(candidates)
    if len(reasons) == 0:
        reasons = [_fallback_reason(stats, contradicted)]
    level = _level_from_reasons(reasons)
    result = {"risk_level": level, "level": level, "reasons": reasons, "evidence": _evidence_for(level, reasons)}
    if level == "medium":
        result["focusLens"] = _focus_for(reasons)
    return result


def _fallback_reason(stats: list[_Stat], contradicted: set[str]) -> dict:
    for s in stats:
        if is_generated_golden_path(s.path):
            continue
        if _is_config_path(s.path):
            return {"code": "configuration_change", "path": s.path}
        if s.path in contradicted or not _is_passive_stat(s):
            if not s.binary and not s.mode_only and s.additions + s.deletions == 0:
                return {"code": "empty_content", "path": s.path}
            return {"code": "executable_change", "path": s.path}
    return {"code": "non_executable_only"}


def _scan_added_lines(snapshot: dict, cwd: str, scan_stats: list[_Stat], bound: dict) -> list[dict]:
    """Added-line evidence (process / sink / network / deletion) from the frozen diff, batched and byte-bounded."""
    reasons: list[dict] = []
    paths = [s.path for s in scan_stats]
    fixed = [
        "-c", "core.quotePath=false", "diff", "--text", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames",
        "--src-prefix=a/", "--dst-prefix=b/", "--unified=0", snapshot["baseTree"], snapshot["candidateTree"], "--",
    ]
    for batch in _pathspec_batches(paths):
        first = batch[0][len(_LITERAL) :]
        known = {b[len(_LITERAL) :] for b in batch}
        try:
            out = run_git(cwd=cwd, args=[*fixed, *batch], timeout_ms=bound["timeoutMs"], limit=OUTPUT_LIMIT).stdout
        except SnapshotError as e:
            if e.code == "git_output_limit":
                return [_scan_limit(first)]
            raise
        current = ""
        in_hunk = False
        seen = {"process": False, "sink": False, "network": False, "fsdelete": False}
        for raw in out.decode("utf-8", "replace").split("\n"):
            if raw.startswith("diff --git "):
                sep = raw.rfind(" b/")
                if sep < 0:
                    return [_scan_limit(first)]
                current = raw[sep + 3 :]
                in_hunk = False
                seen = dict.fromkeys(seen, False)
                if current not in known:
                    return [_scan_limit(first)]
            elif raw.startswith("@@"):
                in_hunk = True
            elif in_hunk and raw.startswith("+"):
                added = utf16_head(raw[1:], _MAX_SCAN_LINE_CHARS)
                if _is_comment_only(current, added):
                    continue
                source = _ext(current) in _SOURCE_EXTENSIONS
                if not seen["process"] and _PROCESS_LINE.search(added):
                    reasons.append({"code": "process_boundary", "signal": "shell_process", "path": current})
                    seen["process"] = True
                if not seen["sink"] and _sink_line(current, added):
                    reasons.append({"code": "dangerous_sink", "signal": "dangerous_sink", "path": current})
                    seen["sink"] = True
                if source and not seen["network"] and any(r.search(added) for r in _NETWORK_LINES):
                    reasons.append({"code": "network_access", "signal": "network", "path": current})
                    seen["network"] = True
                if source and not seen["fsdelete"] and any(r.search(added) for r in _FS_DELETE_LINES):
                    reasons.append({"code": "filesystem_deletion", "signal": "data_loss", "path": current})
                    seen["fsdelete"] = True
    return reasons


# ---------------------------------------------------------------------------------------------
# freeze + assess (read-only), for review_assess
# ---------------------------------------------------------------------------------------------


def assess_candidate(cwd: str, target: dict, options: dict | None = None) -> dict:
    """Freeze the target (private temp index only) and assess it. Writes no review state; due = high."""
    frozen = freeze_snapshot(cwd, target, options)
    if frozen["status"] == "empty":
        return {"status": "not_due", "reason": "no_changes", "reviewDue": False, "kind": frozen["kind"], "projection": frozen["projection"]}
    snap = frozen["snapshot"]
    a = assess_risk(snap, frozen["repository"], options)
    out = {
        "status": "assessed",
        "risk": a["risk_level"],
        "reasons": a["reasons"],
        "evidence": a["evidence"],
        "changedPaths": list(snap["paths"]),
        "changedLines": snap["changedLines"],
        "reviewDue": a["risk_level"] == "high",
        "kind": snap["kind"],
        "projection": snap["projection"],
        "targetIdentity": snap["identity"],
        "baseTree": snap["baseTree"],
        "candidateTree": snap["candidateTree"],
    }
    if "focusLens" in a:
        out["focusLens"] = a["focusLens"]
    return out
