"""Differential: review/runner against v9 dist/review/runner.js through the oracle. Exports: liveReviewerPids, killLiveReviewers,
DEFAULT_PROMPT_BUDGET_BYTES, DEFAULT_DIFF_BUDGET_BYTES, readLensCharter, buildReviewerPrompt, parseReviewerOutput,
REVIEWER_SYSTEM_PROMPT, TIMEOUT_*, TIMEOUT_ENV, DEFAULT_MAX_OUTPUT_BYTES, REVIEWER_ARGUMENTS, reviewerArguments,
resolveReviewerTimeoutMs, sanitizeReviewerEnv, redactExcerpt, classifyFailure, runReviewer. The pure functions run in batches; the
prompt builder runs on real temp git repos (shared by both sides) with Unicode, binary, non-UTF-8, gitlink, symlink and directory
entries; `runReviewer` spawns the SAME fake `claude` (a shell wrapper around a Python script in a temp dir, never a real binary) on
both sides and compares the outcome and what the child recorded (argv, stdin, env, cwd)."""
import json
import os
import re
import subprocess
from pathlib import Path

import pytest
from lib.v9_oracle import DIST, needs_v9, v9_many
from odd_claude.review import runner as R

from review.conftest import diff_cases
from review.test_runner import fake_factory, make_fake, make_files_repo, make_repo, prompt_input  # noqa: F401
from review.test_snapshot import _hermetic_git_env, git, write  # noqa: F401

pytestmark = needs_v9
MOD = "review/runner"
V9_ENV = {"GIT_CONFIG_NOSYSTEM": "1"}
SUB = f"sha256:{'7' * 64}"


def same(fn, py_fn, calls, env=V9_ENV):
    diff_cases(MOD, fn, py_fn, calls, env=env)


# ---- constants ----

_JS_CONSTS = r"""
const m = await import(process.argv[1]);
process.stdout.write(JSON.stringify({
  DEFAULT_PROMPT_BUDGET_BYTES: m.DEFAULT_PROMPT_BUDGET_BYTES, DEFAULT_DIFF_BUDGET_BYTES: m.DEFAULT_DIFF_BUDGET_BYTES, REVIEWER_SYSTEM_PROMPT: m.REVIEWER_SYSTEM_PROMPT,
  TIMEOUT_FLOOR_MS: m.TIMEOUT_FLOOR_MS, TIMEOUT_PER_MEBIBYTE_MS: m.TIMEOUT_PER_MEBIBYTE_MS, TIMEOUT_MAX_MS: m.TIMEOUT_MAX_MS, TIMEOUT_ENV: m.TIMEOUT_ENV,
  DEFAULT_MAX_OUTPUT_BYTES: m.DEFAULT_MAX_OUTPUT_BYTES, REVIEWER_ARGUMENTS: m.REVIEWER_ARGUMENTS, live: [...m.liveReviewerPids], kill: m.killLiveReviewers() ?? null,
}));
"""


def test_constants_arguments_vector_and_the_empty_live_set_match_v9():
    r = subprocess.run(["node", "--input-type=module", "-e", _JS_CONSTS, (DIST / "review" / "runner.js").as_uri()], capture_output=True, text=True, timeout=60)
    assert r.returncode == 0, r.stderr
    v = json.loads(r.stdout)
    for name in ("DEFAULT_PROMPT_BUDGET_BYTES", "DEFAULT_DIFF_BUDGET_BYTES", "REVIEWER_SYSTEM_PROMPT", "TIMEOUT_FLOOR_MS", "TIMEOUT_PER_MEBIBYTE_MS", "TIMEOUT_MAX_MS", "TIMEOUT_ENV", "DEFAULT_MAX_OUTPUT_BYTES"):
        assert getattr(R, name) == v[name], name
    assert R.REVIEWER_ARGUMENTS == v["REVIEWER_ARGUMENTS"]
    assert v["live"] == [] and v["kill"] is None
    assert R.kill_live_reviewers() is None
    assert len(R.live_reviewer_pids) == 0


# ---- reviewerArguments / resolveReviewerTimeoutMs / sanitizeReviewerEnv ----


def test_reviewer_arguments_every_model_and_effort_shape():
    models = ["fable", "opus", "sonnet", "haiku", "Opus", "OPUS", "gpt-4", "claude-opus-4", "--bare", "", " opus", "opus ", "opus\n", "é", "\U0001f600", None, 5, True, ["opus"], {"a": 1}, []]
    efforts = ["low", "medium", "high", "xhigh", "max", "", "ultra", "high; rm", None, 5, True, ["high"], {}, "\U0001f600", " "]
    calls = [[{"model": m, "effort": e}] for m in models for e in efforts] + [[{"model": m}] for m in models] + [[{"effort": e}] for e in efforts]
    calls += [[{}], [None], [5], ["opus"], [[]], [{"model": "opus", "effort": "low", "extra": 1}]]
    same("reviewerArguments", R.reviewer_arguments, calls)


def test_resolve_reviewer_timeout_ms_cross_product():
    pbs = [0, 1, 9, 10, 1000, 1048576, 1048577, 5 * 1048576, 100 * 1048576, 10**12, 10**15, -5, 1.5, 0.1, "1000", "", " 12 ", None, True, False, [5], [], {}]
    cfg = [None, 0, -1, 1, 250, 250.0, 99_999_999, 7_200_000, 7_200_001, 1.5, 2**53, 2**53 - 1, 1e300, "250", "", True, False, [250], {}]
    envs = [{}, {"ODD_RUNNER_TIMEOUT_MS": "321"}, {"ODD_RUNNER_TIMEOUT_MS": "0"}, {"ODD_RUNNER_TIMEOUT_MS": "012"}, {"ODD_RUNNER_TIMEOUT_MS": "1e3"}, {"ODD_RUNNER_TIMEOUT_MS": "9" * 30},
            {"ODD_RUNNER_TIMEOUT_MS": " 5"}, {"ODD_RUNNER_TIMEOUT_MS": "5 "}, {"ODD_RUNNER_TIMEOUT_MS": "+5"}, {"ODD_RUNNER_TIMEOUT_MS": 5}, {"ODD_RUNNER_TIMEOUT_MS": "7200000"},
            {"ODD_RUNNER_TIMEOUT_MS": "99999999"}, {"ODD_RUNNER_TIMEOUT_MS": "١٢"}, {"ODD_RUNNER_TIMEOUT_MS": "5\n"}, {"ODD_RUNNER_TIMEOUT_MS": ""}, {"odd_runner_timeout_ms": "9"}]
    calls = [[pb, c, e] for pb in pbs for c in cfg[:6] for e in envs[:2]] + [[10, c, e] for c in cfg for e in envs] + [[pb, None, e] for pb in pbs for e in envs[:4]] + [[pb] for pb in pbs if not isinstance(pb, (list, dict))]
    calls = [c for c in calls if not (isinstance(c[0], (list, dict)) and len(c[0]) == 0)]  # `[] / n` and `{} / n` (NaN) have no JSON value
    same("resolveReviewerTimeoutMs", R.resolve_reviewer_timeout_ms, calls)


def test_sanitize_reviewer_env_every_key_shape():
    names = ["HOME", "USER", "LOGNAME", "PATH", "SHELL", "TMPDIR", "LANG", "TZ", "TERM", "XDG_CONFIG_HOME", "LC_ALL", "LC_", "LCX", "lc_all", "ANTHROPIC_API_KEY", "ANTHROPIC_", "anthropic_x", "AWS_", "AWS_PROFILE", "aws_profile",
             "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_MAX_OUTPUT_TOKENS", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_PLUGIN_ROOT", "CLOUD_ML_REGION",
             "GOOGLE_APPLICATION_CREDENTIALS", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy", "Http_Proxy", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "NODE_OPTIONS", "GIT_DIR", "LD_PRELOAD",
             "ODD_RUNNER_TIMEOUT_MS", "", "0", "10", "2", "é", "\U0001f600", "HOME ", " HOME", "constructor", "__proto__", "toString", "hasOwnProperty"]
    calls = [[{n: "v"}] for n in names] + [[{n: "v" for n in names}], [{"HOME": None}], [{"HOME": 5, "PATH": True, "TERM": ["x"], "LANG": {"a": 1}}], [{}], [{n: i for i, n in enumerate(names)}]]
    same("sanitizeReviewerEnv", R.sanitize_reviewer_env, calls)


# ---- redactExcerpt / classifyFailure ----


def test_redact_excerpt_exhaustive_shapes():
    ws = [" ", " ", " ", "\u0085", "\u001c", "\u001f", "﻿", "　", "᠎", "​", "\t", "\n", "\r", "\u000b", "\u000c", " ", " ", " ", " "]
    cases = [
        "", " ", "a\n\n  b", "sk-abcdefgh", "sk-abcdefg", "sk-ant-api03-ABCDEFGHIJKLMNOP trailing", "xsk-12345678y", "SK-abcdefgh", "sk-éabcdefgh",
        "Bearer abcdefgh", "bearer abcdefgh", "BEARER abcdefghijkl", "Bearer  abcdefgh", "Bearer abcdefg", "Basic QWxhZGRpbjpvcGVu", "basic abcdefgh.ij", "éBearer abcdefgh", "_Bearer abcdefgh", "xBearer abcdefgh", "Bearer\tabcdefgh", "Bearer abcdefgh",
        "Bearer\u0085abcdefgh", "Bearer\u001fabcdefgh", "Bearer \U0001f600abcdefgh", "Bearer abcdefghéij",
        "API_KEY=abc", "api_key: abc", "TOKEN =  x y", "X_AUTH_TOKEN:secret rest", "password=hunter2", "PASSWORD\t=\tv", "my-key=1", "KEY=", "KEY= ", "SECRETS=1", "tokenizer=1", "éKEY=1", "aéKEY=1", "AUTHORIZATION: Bearer abcdefgh", "key = v", "key\u0085=v", "key=\u0085v", "key=\u001fv",
        "x" * 31, "x" * 32, "x" * 33, "a-b" * 11, "é" * 40, "x" * 31 + "é", "é" + "x" * 32, "ab_cd-" * 6, "0123456789abcdef0123456789abcdef", "0123456789abcdef0123456789abcde-",
        "ab " * 400, "a" * 600, "\U0001f600" * 300, "x " * 249 + "\U0001f600" + " z", "y" * 499 + "\U0001f600", ("z " * 250) + "k", "  lead", "trail  ",
    ] + [f"a{w}b" for w in ws] + [f"{w}x{w}" for w in ws] + [f"KEY{w}={w}v" for w in ws] + [f"Bearer{w}abcdefgh" for w in ws]
    same("redactExcerpt", R.redact_excerpt, [[c] for c in cases])


def test_classify_failure_exhaustive_shapes():
    def pad(n, s="x"):
        return s * n

    errs = [
        "", "anything", "model not found", "MODEL NOT FOUND", "the model foo does not exist", "model" + pad(80) + "invalid", "model" + pad(81) + "invalid", "model\n" + "invalid", "model\r" + "invalid", "model " + "invalid",
        "model" + "\U0001f600" * 40 + "invalid", "model" + "\U0001f600" * 41 + "invalid", "unknown model", "invalid model", "Invalid Model", "may not exist", "There's an issue with the selected model (nope). It may not exist.", "model: issue with the selected model",
        "not logged in", "Please run /login", "/login", "invalid api key", "Invalid API Key", "authentication failed", "OAuth", "unauthorized", "unauthorised", "UNAUTHORIZED", "401", "x401", "401x", "4012", "_401", "é401", "401é", "error 401.", "credit balance too low", "API KEY", "api key", "api  key",
        "tool call not allowed: Bash", "tool" + pad(60) + "denied", "tool" + pad(61) + "denied", "tool\ndenied", "tool" + "\U0001f600" * 30 + "denied", "tool" + "\U0001f600" * 31 + "denied", "permission to use tool", "permission" + pad(60) + "tool", "permission" + pad(61) + "tool", "TOOL attempted",
        "tool permission", "disallowed", "tool disallowed", "Tool Not Allowed",
        "model not found and not logged in", "not logged in and tool denied", "tool denied model invalid", "İnvalid model", "K" + "ey", "ſk", "mÖdel invalid",
    ]
    outs = ["", "x", "not logged in", "model not found", "tool denied", pad(2000) + "not logged in", pad(1990) + "not logged in", pad(1999) + "\U0001f600" + "not logged in", pad(1998) + "\U0001f600model invalid", pad(1999) + "\U0001f600", "\U0001f600" * 1000 + "oauth", "\U0001f600" * 999 + "oauth", "é" * 2000 + "401"]
    calls = [[e, ""] for e in errs] + [["", o] for o in outs] + [[e, o] for e in errs[:12] for o in outs[:4]] + [["not logged in", "model not found"], ["a" * 100000, "b" * 100000]]
    same("classifyFailure", R.classify_failure, calls)


# ---- parseReviewerOutput ----


def lens_result(**over):
    return {"subject_hash": SUB, "inspection": {"status": "completed", "paths": ["a.txt", "é\U0001f600.txt"]}, "findings": [], "evidence": ["reviewed é"], **over}


def test_parse_reviewer_output_exhaustive_shapes():
    good = json.dumps(lens_result())
    refuter = json.dumps({"refuter_request_hash": SUB, "results": [{"finding_id": "R1-1", "outcome": "refuted", "proof_refs": ["x"]}]})
    check = {"passed": True, "evidence": ["e"]}
    validator = json.dumps({"targeted_validation_request_hash": SUB, "correction_target_identity": SUB, "original_criteria": check, "correction_regression": check, "follow_ups": []})
    texts = [
        good, refuter, validator, "", " ", "no braces", "{", "}", "{}", "{{}}", "}{", "{} {}", "[]", "[1,2]", f"[{good}]", f"```json\n{good}\n```", f"Here you go:\n```json\n{json.dumps(lens_result(), indent=2)}\n```\n", f"{good}\n{good}",
        f"{good} {{x}}", f"{{x}} {good}", f"{{not json}} {good}", f"{good} {{\"a\":", f"{good} {{\"a\": 1", '{"a": 1,}', '{"a": 1', '{"a": "}"}', '{"a": "\\"}"}', '{"a": "\\\\"}', '{"a": "\\\\\\""}',
        json.dumps(lens_result(evidence=["a } and { in a string"])), json.dumps(lens_result(evidence=["\"quoted\" \\ back"])), json.dumps(lens_result(evidence=["x"]), ensure_ascii=False), json.dumps(lens_result(evidence=["   "]), ensure_ascii=False),
        "﻿" + good, good + "﻿", "é" + good, "\U0001f600" + good + "\U0001f600", good.replace("}", "}\x00", 1), json.dumps({"subject_hash": SUB}), json.dumps({"nope": True}),
        json.dumps(lens_result(subject_hash=f"sha256:{'8' * 64}")), json.dumps(lens_result(lens="risk")), json.dumps(lens_result(extra=1)),
        '{"a": 1e400}', '{"a": 12345678901234567890}', '{"a": -0}', '{"a": 1.0}', '{"a": NaN}', '{"a": undefined}', "{'a': 1}", '{"a": 1}{"b": 2}', '{"a": {"b": {"c": {}}}}', '{"a": [1, {"b": 2}]}', '{"a":1}\n{"a":', '{"a":1}\n{',
        '{"__proto__": {"x": 1}, "subject_hash": "' + SUB + '"}', '{"a": "\\ud800"}', '{"a": "é"}', '{"": 1}', '{"a": 1} trailing }', '} {"a": 1}', "{" * 5 + "}" * 5, "{" * 300 + "}" * 300, '{"a":' * 50 + "1" + "}" * 50,
    ]
    bindings = [{"subject_hash": SUB}, {}, {"subject_hash": SUB, "refuter_request_hash": SUB}, {"refuter_request_hash": SUB}, {"targeted_validation_request_hash": SUB, "correction_target_identity": SUB}, {"a": 1}, {"a": "1"}, {"subject_hash": 5},
                {"10": "x", "2": "y", "b": "z"}, {"é": "x"}, {"subject_hash": None}, {"subject_hash": [SUB]}, "ab", 5, True, [SUB], {"subject_hash": SUB, "evidence": ["x"]}]
    roles = ["lens", "refuter", "validator"]
    calls = [[t, r, {"subject_hash": SUB}] for t in texts for r in roles] + [[good, "lens", b] for b in bindings] + [[refuter, "refuter", b] for b in bindings] + [[validator, "validator", b] for b in bindings]
    calls += [[good, "judge", {}], [good, None, {}], [good, 5, {}], [good, "x", {}], ["no json", "judge", {}], ["{}", "judge", {}], [good, "lens", None], ["no json", "lens", None], [5, "lens", {}], [True, "lens", {}], [{}, "lens", {}], [None, "lens", {}]]
    same("parseReviewerOutput", R.parse_reviewer_output, calls)


# ---- readLensCharter ----

CHARTERS = {
    "risk": "---\nname: x\n---\n\n## Review rules\nRule one é\U0001f600\n\nRule two\n\n## Output contract\nx\n",
    "resilience": "## Review rules\r\nCRLF rules\r\nmore\r\n## Output contract\r\n",
    "readability": "intro\r## Review rules\nCR-led heading\n## Out\n",
    "reliability": "intro ## Review rules\nLS-led heading ## Out\n",
}


def charter_dirs(tmp_path):
    out = {}

    def mk(name, files):
        d = tmp_path / name
        d.mkdir()
        for fn, body in files.items():
            if body is None:
                (d / fn).mkdir()
            else:
                (d / fn).write_bytes(body.encode("utf-8") if isinstance(body, str) else body)
        out[name] = str(d)

    mk("mixed", {f"odd-review-{k}.md": v for k, v in CHARTERS.items()})
    mk("empty-rules", {"odd-review-risk.md": "## Review rules\n\n## Output contract\nx\n", "odd-review-resilience.md": "## Review rules\n   \n\t\n", "odd-review-readability.md": "## Review rules\n"})
    mk("no-heading", {"odd-review-risk.md": "no heading here\n", "odd-review-resilience.md": "### Review rules\nnope\n", "odd-review-readability.md": " ## Review rules\nindented\n", "odd-review-reliability.md": "## Review rules extra\nx\n## y\n"})
    mk("eof", {"odd-review-risk.md": "## Review rules\nlast section\n", "odd-review-resilience.md": "## Review rules\nlast\nlines\n\n\n", "odd-review-readability.md": "## Review rules\nx\n## ", "odd-review-reliability.md": "## Review rules\nx\n##\nstill rules\n"})
    mk("bytes", {"odd-review-risk.md": b"## Review rules\nbad \xff\xfe bytes \xc3\n## x\n", "odd-review-resilience.md": b"\xef\xbb\xbf## Review rules\nbom\n", "odd-review-readability.md": "﻿\n## Review rules\nbom then newline\n", "odd-review-reliability.md": None})
    mk("twice", {"odd-review-risk.md": "## Review rules\nfirst\n## Review rules\nsecond\n"})
    return out


def test_read_lens_charter_default_dir_and_custom_dirs(tmp_path):
    dirs = charter_dirs(tmp_path)
    lenses = ["risk", "resilience", "readability", "reliability", "nope", "", "RISK", "risk ", None, 5, ["risk"], {"a": 1}, "constructor", "é"]
    calls = [[lens] for lens in lenses] + [[lens, d] for lens in lenses for d in [*dirs.values(), str(tmp_path / "missing"), "", ".", None, 5, "/"]]
    calls += [[lens, os.path.join(d, "..", Path(d).name)] for lens in lenses[:4] for d in dirs.values()] + [["risk", str(tmp_path) + "//mixed//"]]
    same("readLensCharter", R.read_lens_charter, calls)


# ---- buildReviewerPrompt ----


def c2(repo, *args):
    return git(repo, *args).strip()


@pytest.fixture
def rich_repo(tmp_path):
    """Base commit and a candidate with Unicode, nested, spaced and newline names, binary, non-UTF-8, BOM, CRLF, empty and big files, a
    deletion, a mode change and a symlink; plus a gitlink-and-directory tree."""
    repo = Path(os.path.realpath(tmp_path)) / "rich"
    repo.mkdir()
    git(repo, "init", "-q", "-b", "main")
    write(repo / "keep.txt", "k1\nk2\nk3\nk4\nk5\nk6\nk7\n")
    write(repo / "gone.txt", "bye\n")
    write(repo / "mode.sh", "#!/bin/sh\necho hi\n")
    write(repo / "raw-ctx.txt", b"ctx1\nctx2\nctx3\n\xff\xfe\nctx5\nctx6\nctx7\nold\n")
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "base")
    base = c2(repo, "rev-parse", "HEAD^{tree}")
    write(repo / "keep.txt", "k1\nk2\nk3\nk4 changed é\U0001f600\nk5\nk6\nk7\nadded\n")
    git(repo, "rm", "-q", "gone.txt")
    (repo / "mode.sh").chmod(0o755)
    write(repo / "raw-ctx.txt", b"ctx1\nctx2\nctx3\n\xff\xfe\nctx5\nctx6\nctx7\nnew\n")
    files = {
        "é-\U0001f600.txt": "unicode name é\n", "dir/nested/ß.md": "# nested\n", "sp ace.txt": "space\n", "new\nline.txt": "newline name\n", "empty.txt": "", "crlf.txt": "a\r\nb\r\n", "lone-cr.txt": "a\rb\n",
        "bom.txt": "﻿bom\n", "latin1.txt": b"caf\xe9\n", "bin.dat": bytes([1, 0, 2]), "nul-late.txt": b"text\x00text", "big.txt": "line of text\n" * 5000, "no-newline.txt": "last line without newline",
        "surrogates.txt": b"\xed\xa0\x80 lone surrogate bytes\n", "astral.txt": "\U0001f600" * 50 + "\n", "ws.txt": "    tricky whitespace\n",
    }
    for name, body in files.items():
        write(repo / name, body)
    os.symlink("keep.txt", repo / "link")
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "cand")
    cand = c2(repo, "rev-parse", "HEAD^{tree}")
    git(repo, "update-index", "--add", "--cacheinfo", f"160000,{'a' * 40},sub")
    gitlink_tree = c2(repo, "write-tree")
    return {"repo": str(repo), "cd": os.path.join(str(repo), ".git"), "base": base, "cand": cand, "gitlink": gitlink_tree, "paths": sorted([*files, "keep.txt", "gone.txt", "mode.sh", "raw-ctx.txt", "link"])}


def pi(r, **over):
    base = {"commonDir": r["cd"], "role": "lens", "lens": "risk", "subject": {"subject_hash": SUB, "lens": "risk"}, "binding": {"subject_hash": SUB}, "baseTree": r["base"], "candidateTree": r["cand"], "paths": ["keep.txt"]}
    base.update(over)
    return base


def test_build_reviewer_prompt_paths_trees_and_entry_kinds(rich_repo):
    r = rich_repo
    all_paths = r["paths"]
    path_sets = [[], ["keep.txt"], ["gone.txt"], ["mode.sh"], ["link"], ["raw-ctx.txt"], ["é-\U0001f600.txt"], ["dir/nested/ß.md"], ["dir"], ["dir/"], ["dir/nested"], ["sp ace.txt", "empty.txt"], ["new\nline.txt"], ["crlf.txt", "lone-cr.txt"],
                 ["bom.txt"], ["latin1.txt"], ["bin.dat", "nul-late.txt"], ["no-newline.txt"], ["surrogates.txt"], ["astral.txt", "ws.txt"], ["missing.txt"], ["keep.txt", "keep.txt"], ["b", "a"], all_paths, all_paths[::-1], ["big.txt"], ["", "keep.txt"],
                 [".", "keep.txt"], ["../x"], ["keep.txt:1"], ["a\u0000b"], ["lone\ud800.txt"], "abc", "é\U0001f600", ["keep.txt", "gone.txt", "link"]]
    calls = [[pi(r, paths=p)] for p in path_sets]
    calls += [[pi(r, candidateTree=r["gitlink"], paths=["sub", "gone.txt", "keep.txt"])], [pi(r, candidateTree=r["gitlink"], paths=["sub"])]]
    calls += [[pi(r, baseTree=r["cand"], candidateTree=r["base"], paths=all_paths)], [pi(r, baseTree=r["base"], candidateTree=r["base"], paths=all_paths)], [pi(r, baseTree=r["cand"], candidateTree=r["cand"], paths=all_paths)],
              [pi(r, baseTree="4b825dc642cb6eb9a060e54bf8d69288fbee4904", paths=all_paths)], [pi(r, baseTree="4b825dc642cb6eb9a060e54bf8d69288fbee4904", candidateTree=r["gitlink"], paths=["sub"])]]
    same("buildReviewerPrompt", R.build_reviewer_prompt, calls)


def test_build_reviewer_prompt_tree_ids_roles_lenses_and_shapes(rich_repo):
    r = rich_repo
    trees = ["main", "", "0" * 40, "0" * 64, "a" * 39, "a" * 41, r["base"].upper(), r["base"][:-1], r["base"] + "0", "g" * 40, r["base"] + "\n", " " + r["base"], None, 5, True, [r["base"]], {"a": 1}, "é" * 40, r["cand"] + r["cand"]]
    calls = [[pi(r, baseTree=t)] for t in trees] + [[pi(r, candidateTree=t)] for t in trees] + [[{k: v for k, v in pi(r).items() if k != "baseTree"}], [{k: v for k, v in pi(r).items() if k != "candidateTree"}]]
    roles = ["lens", "refuter", "validator", "judge", "", "LENS", "lens ", None, 5, ["lens"], ["refuter"], {"a": 1}, True, "é"]
    lenses = ["risk", "resilience", "readability", "reliability", "nope", "", "RISK", None, 5, ["risk"], {}, "review-risk", "\U0001f600"]
    calls += [[pi(r, role=ro)] for ro in roles] + [[pi(r, role=ro, lens=le)] for ro in ("lens", "refuter", "validator") for le in lenses] + [[{k: v for k, v in pi(r, role=ro).items() if k != "lens"}] for ro in ("lens", "refuter", "validator")]
    subjects = [{"subject_hash": SUB}, {}, None, {"b": 1, "a": 2, "é": 3, "10": 1, "2": 2}, {"n": 1.0}, {"n": 1e21}, {"n": 1e-7}, {"n": -0.0}, {"n": 2**53}, {"n": 12345678901234567890}, {"s": "  \ud800 \U0001f600 \u007f \u0000 \u001f"}, {"deep": {"a": [1, [2, {"b": None}]]}}, [1, 2], "str", 5, True, {"a": "x" * 5000}]
    calls += [[pi(r, subject=s)] for s in subjects] + [[{k: v for k, v in pi(r).items() if k != "subject"}]]
    calls += [[pi(r, binding=s)] for s in subjects] + [[{k: v for k, v in pi(r).items() if k != "binding"}]]
    findings = [[], None, [{"id": "R1-1", "claim": "é\U0001f600"}], [1, "a", None, [2]], {"a": 1}, "str", 5, [{"b": 1, "a": 2}]]
    calls += [[pi(r, role="refuter", findings=f)] for f in findings] + [[{k: v for k, v in pi(r, role="validator").items() if k != "findings"}]]
    schemas = [None, {}, {"type": "object"}, {"b": 1, "a": [1, 2]}, [], "str", 5, {"é": "\U0001f600"}]
    calls += [[pi(r, schema=s)] for s in schemas] + [[pi(r, role="refuter", schema=s)] for s in schemas[:3]]
    same("buildReviewerPrompt", R.build_reviewer_prompt, calls)


def test_build_reviewer_prompt_budgets_sweep_and_edges(rich_repo):
    r = rich_repo
    full = R.build_reviewer_prompt(pi(r, paths=["keep.txt", "é-\U0001f600.txt", "raw-ctx.txt", "gone.txt"]))
    assert full["ok"]
    n = full["bytes"]
    prompt_budgets = [0, 1, 100, 1000, 4096, 5000, 6000, 8000, 10000, n - 1, n, n + 1, n - 4096, n + 4096, n + 4097, 20000, 100000, 786432, 10**7, -1, 0.5, 1.5, 5000.5, 2**40, 1e21]
    prompt_budgets += list(range(max(0, n - 40), n + 40, 7))
    calls = [[pi(r, paths=["keep.txt", "é-\U0001f600.txt", "raw-ctx.txt", "gone.txt"], maxPromptBytes=b)] for b in prompt_budgets]
    diff_budgets = [0, 1, 10, 100, 500, 1000, 1500, 2000, 3000, 10000, 262144, -1, -5, 0.5, 2.5, 1e21, 2**40]
    calls += [[pi(r, paths=["keep.txt", "gone.txt"], maxDiffBytes=b)] for b in diff_budgets] + [[pi(r, paths=["keep.txt"], maxDiffBytes=d, maxPromptBytes=p)] for d in (50, 3000) for p in (100, 6000, 9000)]
    diff = subprocess.run(["git", "-C", r["cd"], "diff-tree", "-p", "--no-commit-id", "--no-renames", "--no-color", "--no-ext-diff", "-r", r["base"], r["cand"]], capture_output=True).stdout
    calls += [[pi(r, paths=["keep.txt"], maxDiffBytes=len(diff) + d)] for d in (-2, -1, 0, 1)]
    # file bodies: a single big file near the budget edge
    big = [[pi(r, paths=["big.txt"], maxPromptBytes=b)] for b in (150000, 160000, 170000, 200000, 786432)]
    same("buildReviewerPrompt", R.build_reviewer_prompt, calls + big)
    for given in (None, "x", "5000"):  # a null budget means the default; a string budget is not modelled
        if given is None:
            same("buildReviewerPrompt", R.build_reviewer_prompt, [[pi(r, maxPromptBytes=None, maxDiffBytes=None)]])


def test_build_reviewer_prompt_charters_and_agents_dirs(rich_repo, tmp_path):
    r = rich_repo
    dirs = charter_dirs(tmp_path)
    lenses = ["risk", "resilience", "readability", "reliability"]
    calls = [[pi(r, lens=le, agentsDir=d)] for le in lenses for d in [*dirs.values(), str(tmp_path / "nope"), "", None]] + [[pi(r, lens=le)] for le in lenses]
    calls += [[pi(r, role=ro, agentsDir=str(tmp_path / "nope"))] for ro in ("refuter", "validator")]
    same("buildReviewerPrompt", R.build_reviewer_prompt, calls)


def test_build_reviewer_prompt_error_shapes(rich_repo, tmp_path):
    r = rich_repo
    not_repo = str(tmp_path)
    calls = [[pi(r, commonDir=not_repo)], [pi(r, commonDir=str(tmp_path / "missing"))], [pi(r, paths=None)], [pi(r, paths=5)], [pi(r, paths={})], [pi(r, paths=True)], [{k: v for k, v in pi(r).items() if k != "paths"}]]
    calls += [[pi(r, baseTree="0" * 40)], [pi(r, candidateTree="0" * 40)], [pi(r, baseTree="1" * 64)], [pi(r, paths=["gone.txt", "missing.txt"], candidateTree="0" * 40)]]
    same("buildReviewerPrompt", R.build_reviewer_prompt, calls)


# ---- runReviewer ----

ECHO = ["--bare", "x"]


def norm_outcome(o):
    o = dict(o)
    o.pop("elapsedMs", None)
    if "message" in o:
        o["message"] = re.sub(r"killed after \d+ms", "killed after Nms", o["message"])
    return o


def norm_record(rec):
    if rec is None:
        return None
    rec = dict(rec)
    cwd = rec.pop("cwd")
    rec["cwd_ok"] = bool(re.match(r".*/odd-claude-reviewer-[A-Za-z0-9_]+$", cwd)) and not os.path.exists(cwd)
    rec["env"] = {k: v for k, v in rec["env"].items() if k not in ("PWD", "OLDPWD", "_", "SHLVL")}
    rec.pop("pid")
    return rec


def scenarios(tmp_path):
    """(label, behavior, prompt, opts-builder) tuples; the opts builder gets the fake and returns the options both sides use."""
    base_env = lambda fk, **extra: {"PATH": f"{os.path.dirname(fk.binary)}:/usr/bin:/bin", **extra}  # noqa: E731
    out = []

    def add(label, behavior, prompt="PROMPT BODY ünï \U0001f600", opts=lambda fk: {"env": base_env(fk)}):
        out.append((label, behavior, prompt, opts))

    add("ok", {"stdout": "ok é\U0001f600"})
    add("ok-no-env-opt", {"stdout": "fine"}, opts=lambda fk: {"claudePath": fk.binary})
    add("ok-model-effort", {"stdout": "ok"}, opts=lambda fk: {"env": base_env(fk), "model": "sonnet", "effort": "low"})
    for m, e in [("haiku", "high"), ("opus", ""), ("fable", "max"), ("gpt-4", "high"), ("--bare", ""), ("Opus", "low"), (None, "high"), ("opus", None), ("opus", "xhigh"), ("opus", "medium")]:
        add(f"model-{m}-{e}", {"stdout": "ok"}, opts=lambda fk, m=m, e=e: {"env": base_env(fk), **({"model": m} if m is not None else {}), **({"effort": e} if e is not None else {})})
    for e in ("ultra", "high; rm", "HIGH", " low"):
        add(f"bad-effort-{e}", {"stdout": "ok"}, opts=lambda fk, e=e: {"env": base_env(fk), "effort": e, "model": "opus"})
    add("env-sanitized", {"stdout": "ok"}, opts=lambda fk: {"env": base_env(fk, HOME="/home/x", ANTHROPIC_API_KEY="kkk", GIT_DIR="/nope", CLAUDE_PLUGIN_ROOT="/p", NODE_OPTIONS="--x", LC_ALL="C", AWS_REGION="r", http_proxy="p", ODD_RUNNER_TIMEOUT_MS="9999")})
    add("env-timeout-override", {"sleepMs": 5000}, opts=lambda fk: {"env": base_env(fk, ODD_RUNNER_TIMEOUT_MS="600")})
    add("prompt-empty", {"stdout": "ok"}, prompt="")
    add("prompt-surrogate", {"stdout": "ok"}, prompt="a\ud800b\udfff")
    add("prompt-big", {"stdout": "ok"}, prompt="x" * 300_000)
    add("prompt-big-noread", {"noRead": True, "exit": 1, "stderr": "gone"}, prompt="x" * 300_000)
    for name, beh in {
        "exit1-model": {"exit": 1, "stderr": "There's an issue with the selected model (nope). It may not exist."},
        "exit1-auth": {"exit": 1, "stderr": "Not logged in · Please run /login"}, "exit1-auth-stdout": {"exit": 1, "stdout": "Invalid API key"},
        "exit1-tool": {"exit": 1, "stderr": "tool call not allowed: Bash"}, "exit2": {"exit": 2, "stderr": "boom"}, "exit2-quiet": {"exit": 2},
        "exit0-empty": {"exit": 0, "stdout": "  \n"}, "exit0-nothing": {"exit": 0}, "exit0-stderr-only": {"exit": 0, "stderr": "warn é"}, "exit255": {"exit": 255, "stderr": "x"},
        "stderr-secrets": {"exit": 3, "stderr": f"fail ANTHROPIC_API_KEY=sk-ant-api03-ABCDEFGHIJKLMNOP Bearer abcdefghijkl1234 {'z ' * 1000}"},
        "stderr-huge": {"exit": 3, "stderr": "e" * 200_000}, "stderr-unicode": {"exit": 4, "stderr": "é\U0001f600 " * 300},
        "stdout-invalid-utf8": {"stdoutBytes": [0x68, 0xFF, 0xFE, 0x69]}, "stdout-ws-only-bytes": {"stdoutBytes": [0x20, 0x09, 0x0A]}, "stdout-nbsp": {"stdoutBytes": [0xC2, 0xA0]}, "stdout-bom": {"stdoutBytes": [0xEF, 0xBB, 0xBF]},
        "stdout-nel": {"stdoutBytes": [0xC2, 0x85]}, "stdout-ls": {"stdoutBytes": [0xE2, 0x80, 0xA8]},
        "self-kill-9": {"selfKill": 9, "stderr": "k"}, "self-kill-15": {"selfKill": 15}, "self-kill-1": {"selfKill": 1}, "grandchild": {"stdout": "done", "grandchild": True}, "grandchild-holds-stdout": {"stdout": "answer", "grandchild": "holds-stdout"},
    }.items():
        add(name, beh)
    add("timeout", {"sleepMs": 30_000, "stdout": "late"}, opts=lambda fk: {"env": base_env(fk), "timeoutMs": 700})
    add("timeout-grandchild", {"sleepMs": 30_000, "grandchild": True}, opts=lambda fk: {"env": base_env(fk), "timeoutMs": 900})
    add("timeout-escapes", {"stdout": "ok", "grandchild": "escapes"}, opts=lambda fk: {"env": base_env(fk), "timeoutMs": 900})
    add("timeout-float", {"sleepMs": 30_000}, opts=lambda fk: {"env": base_env(fk), "timeoutMs": 650.0})
    add("timeout-bad-value", {"stdout": "ok"}, opts=lambda fk: {"env": base_env(fk), "timeoutMs": -5})
    add("timeout-string", {"stdout": "ok"}, opts=lambda fk: {"env": base_env(fk), "timeoutMs": "250"})
    add("huge-cap", {"hugeBytes": 200_000}, opts=lambda fk: {"env": base_env(fk), "maxOutputBytes": 1000})
    add("huge-cap-linger", {"hugeBytes": 200_000, "lingerAfterWrite": True}, opts=lambda fk: {"env": base_env(fk), "maxOutputBytes": 1000})
    add("cap-exact", {"hugeBytes": 1000}, opts=lambda fk: {"env": base_env(fk), "maxOutputBytes": 1000})
    add("cap-one-over", {"hugeBytes": 1001}, opts=lambda fk: {"env": base_env(fk), "maxOutputBytes": 1000})
    add("cap-zero", {"stdout": "x"}, opts=lambda fk: {"env": base_env(fk), "maxOutputBytes": 0})
    add("cap-default-1mib", {"hugeBytes": 1024 * 1024})
    add("cap-default-over", {"hugeBytes": 1024 * 1024 + 1})
    return out


def test_run_reviewer_scenarios_outcome_and_recorded_child_match_v9(tmp_path):
    cases = scenarios(tmp_path)
    fakes = [make_fake(tmp_path, beh) for _, beh, _, _ in cases]
    calls = [[prompt, opts(fk)] for (_, _, prompt, opts), fk in zip(cases, fakes)]
    v9_out = v9_many(MOD, "runReviewer", calls, env=V9_ENV)
    v9_rec = []
    for fk in fakes:
        v9_rec.append(fk.record)
        if os.path.exists(fk.record_file):
            os.unlink(fk.record_file)
    for (label, *_), fk, call, want, want_rec in zip(cases, fakes, calls, v9_out, v9_rec):
        try:
            got = R.run_reviewer(*call)
        except Exception as e:  # noqa: BLE001
            got = {"__error__": str(e)}
        assert norm_outcome(got) == norm_outcome(want), f"{label}: python={got!r} v9={want!r}"
        assert norm_record(fk.record) == norm_record(want_rec), label
        if os.path.exists(fk.record_file):
            os.unlink(fk.record_file)
    for fk in fakes:  # no scenario leaves a straggler behind
        pid = fk.grandchild_pid()
        if pid:
            try:
                os.kill(pid, 9)
            except OSError:
                pass


def test_run_reviewer_binary_resolution_and_spawn_failures_match_v9(tmp_path):
    d = tmp_path / "bins"
    d.mkdir()
    fk = make_fake(tmp_path, {"stdout": "from-path"})
    fk2 = make_fake(tmp_path, {"stdout": "second"})
    plain = d / "plain-file"
    plain.write_text("echo hi\n")
    plain.chmod(0o644)
    no_interp = d / "no-interp"
    no_interp.write_text("#!/nonexistent/interpreter\n")
    no_interp.chmod(0o755)
    via_plain = d / "via-plain"
    via_plain.write_text(f"#!{plain}\n")
    via_plain.chmod(0o755)
    bad_format = d / "bad-format"
    bad_format.write_bytes(b"\x7fELFgarbage")
    bad_format.chmod(0o755)
    folder = d / "a-directory"
    folder.mkdir()
    named = d / "named"
    named.mkdir()
    (named / "claude").write_text("not executable\n")
    (named / "claude").chmod(0o644)
    d2 = os.path.dirname(fk2.binary)
    paths = [
        f"{os.path.dirname(fk.binary)}", f"{d2}:{os.path.dirname(fk.binary)}", f"{named}:{os.path.dirname(fk.binary)}", f"relative/dir:{os.path.dirname(fk.binary)}", f":{os.path.dirname(fk.binary)}", f"{os.path.dirname(fk.binary)}/", f"{os.path.dirname(fk.binary)}//",
        "/nonexistent", "", "/usr/bin", str(named),
    ]
    calls = [["p", {"env": {"PATH": p}}] for p in paths] + [["p", {"env": {}}], ["p", {"env": {"PATH": None}}], ["p", {"env": {"PATH": 5}}]]
    for target in (plain, no_interp, via_plain, bad_format, folder, tmp_path / "missing", fk.binary, str(tmp_path), "", "relative-claude", f"{fk.binary}\x00"):
        calls.append(["p", {"claudePath": str(target), "env": {"PATH": "/usr/bin"}}])
    v9_out = v9_many(MOD, "runReviewer", calls, env=V9_ENV)
    for call, want in zip(calls, v9_out):
        try:
            got = R.run_reviewer(*call)
        except Exception as e:  # noqa: BLE001
            got = {"__error__": str(e)}
        assert norm_outcome(got) == norm_outcome(want), f"{call}: python={got!r} v9={want!r}"


def test_run_reviewer_option_shapes_match_v9(tmp_path):
    fk = make_fake(tmp_path, {"stdout": "ok"})
    env = {"PATH": f"{os.path.dirname(fk.binary)}:/usr/bin"}
    calls = [["p"], ["p", {}], ["p", {"env": env, "model": 5}], ["p", {"env": env, "effort": 5, "model": "opus"}], ["p", {"env": env, "effort": None, "model": "opus"}], ["p", {"env": env, "effort": ["low"]}], ["p", {"env": env, "maxOutputBytes": None}],
             ["p", {"env": env, "maxOutputBytes": -1}], ["p", {"env": env, "timeoutMs": None}], ["p", {"env": env, "timeoutMs": 0}], ["p", None], ["p", {"env": None, "claudePath": fk.binary}]]
    calls = [c for c in calls if c != ["p"] and c != ["p", {}]]  # the default environment would run whatever `claude` the machine has on PATH
    v9_out = v9_many(MOD, "runReviewer", calls, env=V9_ENV)
    for call, want in zip(calls, v9_out):
        try:
            got = R.run_reviewer(*call)
        except Exception as e:  # noqa: BLE001
            got = {"__error__": str(e)}
        assert norm_outcome(got) == norm_outcome(want), f"{call}: python={got!r} v9={want!r}"
