// Risk classification for the review engine (U9).
//
// Reads ONLY the two frozen trees of a snapshot (base vs candidate) through git plumbing, with the same
// sanitized environment, timeouts and output bounds as snapshot.ts (it reuses `runGit`). The working tree
// and the real index are never read, so editing files after the freeze cannot change the verdict.
//
// Tiering mirrors the reference engine: any reason carrying a `signal` is high; a lone `non_executable_only`
// is low; everything else is medium. Reason codes keep the reference names where they exist
// (non_executable_only, executable_change, configuration_change, empty_content, executable_mode,
// shell_source, service_token, hot_path, process_boundary, dangerous_sink, process_scan_limit,
// large_change). odd-claude adds dependency_change, ci_release_change, hook_change, contract_change,
// credential_path, permission_path, network_access, filesystem_deletion (all high) and file_deletion,
// binary_change, symlink_change, submodule_change (medium).
//
// Bounded: no blob over MAX_BLOB_SCAN_BYTES and no more than MAX_TOTAL_SCAN_BYTES of blobs are ever read;
// the added-lines diff is capped by the git output limit. Exceeding either fails closed to a high
// `process_scan_limit` reason instead of an unbounded read.
import { basename, extname } from "node:path";
import { boundOf, freezeSnapshot, isGeneratedGoldenPath, nulRecords, decodeName, OUTPUT_LIMIT, runGit, SnapshotError, } from "./snapshot.js";
export const LARGE_CHANGE_LINES = 400;
export const MAX_BLOB_SCAN_BYTES = 1024 * 1024;
export const MAX_TOTAL_SCAN_BYTES = 8 * 1024 * 1024;
const MAX_SCAN_LINE_CHARS = 4096;
const MAX_EVIDENCE_LINES = 12;
const PATHSPEC_BATCH_CHARS = 24_000;
const PATHSPEC_BATCH_ENTRIES = 400;
const ZERO_OID = /^0+$/;
const SOURCE_EXTENSIONS = new Set([
    ".c", ".cc", ".cpp", ".cs", ".go", ".h", ".hpp", ".java", ".js", ".jsx", ".kt", ".kts", ".php", ".py",
    ".rb", ".rs", ".sh", ".bash", ".zsh", ".ts", ".tsx", ".mjs", ".cjs", ".mts", ".cts",
]);
function collectStats(snapshot, repo, bound) {
    const common = ["--no-renames", "--no-ext-diff", "--no-textconv", "--ignore-submodules=none", snapshot.baseTree, snapshot.candidateTree, "--"];
    const raw = runGit({ cwd: repo.root, args: ["diff", "--raw", "--no-abbrev", "-z", ...common], ...bound, limit: 64 * 1024 * 1024 }).stdout;
    const numstat = runGit({ cwd: repo.root, args: ["diff", "--numstat", "-z", ...common], ...bound, limit: 64 * 1024 * 1024 }).stdout;
    const counts = new Map();
    for (const record of nulRecords(numstat)) {
        const text = decodeName(record, "diff stat record");
        const first = text.indexOf("\t");
        const second = first < 0 ? -1 : text.indexOf("\t", first + 1);
        if (first < 0 || second < 0)
            throw new SnapshotError("corrupt_output", "unexpected diff stat record");
        const a = text.slice(0, first);
        const d = text.slice(first + 1, second);
        const path = text.slice(second + 1);
        if (a === "-" && d === "-")
            counts.set(path, { additions: 0, deletions: 0, binary: true });
        else if (/^\d+$/.test(a) && /^\d+$/.test(d))
            counts.set(path, { additions: Number(a), deletions: Number(d), binary: false });
        else
            throw new SnapshotError("corrupt_output", "unexpected diff stat counts");
    }
    const records = nulRecords(raw);
    if (records.length % 2 !== 0)
        throw new SnapshotError("corrupt_output", "unexpected raw diff output");
    const stats = [];
    for (let i = 0; i < records.length; i += 2) {
        const meta = records[i].toString("utf8");
        const match = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) [A-Z]\d*$/.exec(meta);
        if (!match)
            throw new SnapshotError("corrupt_output", "unexpected raw diff record");
        const path = decodeName(records[i + 1], "changed path");
        const c = counts.get(path) ?? { additions: 0, deletions: 0, binary: false };
        stats.push({
            path,
            oldMode: match[1],
            newMode: match[2],
            oldOid: match[3],
            newOid: match[4],
            additions: c.additions,
            deletions: c.deletions,
            binary: c.binary,
            modeOnly: !c.binary && c.additions + c.deletions === 0 && match[3] === match[4],
        });
    }
    const frozen = new Set(snapshot.paths);
    return stats.filter((s) => frozen.has(s.path)).sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
}
// ---------------------------------------------------------------------------------------------
// path classes (pure)
// ---------------------------------------------------------------------------------------------
const lower = (s) => s.toLowerCase();
const ext = (p) => lower(extname(p));
const base = (p) => lower(basename(p));
const segmentsOf = (p) => p.split("/");
function isTestPath(p) {
    const segs = segmentsOf(lower(p));
    for (const seg of segs.slice(0, -1))
        if (seg === "__tests__" || seg === "testdata")
            return true;
    const name = segs[segs.length - 1];
    return name.endsWith("_test.go") || name.includes(".test.") || name.includes(".spec.") || (name.startsWith("test_") && name.endsWith(".py")) || name.endsWith("_test.py");
}
function hasExcludedSegment(p) {
    return segmentsOf(p).some((s) => ["docs", "testdata", "fixture", "fixtures", "__fixtures__"].includes(lower(s)));
}
const CONFIG_BASENAMES = new Set(["go.mod", "go.sum", "package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "dockerfile", "makefile"]);
function isConfigPath(p) {
    const b = base(p);
    if (b === ".env" || b.startsWith(".env.") || CONFIG_BASENAMES.has(b))
        return true;
    return [".json", ".yaml", ".yml", ".toml", ".ini", ".env"].includes(ext(p));
}
const stripSemanticExt = (segment) => (SOURCE_EXTENSIONS.has(ext(segment)) || isConfigPath(segment) ? segment.slice(0, segment.length - extname(segment).length) : segment);
function isServiceTokenPath(p) {
    for (const seg of segmentsOf(p)) {
        const tokens = lower(stripSemanticExt(seg)).split(/[-_]/).filter(Boolean);
        for (let i = 0; i + 1 < tokens.length; i++)
            if (tokens[i] === "service" && tokens[i + 1] === "token")
                return true;
    }
    return false;
}
function isShellPath(p) {
    const e = ext(p);
    if ([".sh", ".bash", ".zsh"].includes(e))
        return true;
    return (e === ".yml" || e === ".yaml") && p.startsWith(".github/workflows/");
}
function hotPathSignals(p) {
    if (isTestPath(p))
        return [];
    const out = new Set();
    for (const token of lower(p).split(/[/\\._-]+/)) {
        if (token === "auth")
            out.add("auth");
        else if (token === "security" || token === "webhook")
            out.add("security");
        else if (token === "payments")
            out.add("payments");
    }
    return [...out].sort();
}
const DEPENDENCY_BASENAMES = new Set([
    "package.json", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "bun.lock", "go.mod", "go.sum",
    "cargo.toml", "cargo.lock", "pipfile", "pipfile.lock", "poetry.lock", "pyproject.toml", "gemfile", "gemfile.lock", "composer.json",
    "composer.lock", "pom.xml", "build.gradle", "build.gradle.kts", "gradle.lockfile", "mix.exs", "mix.lock", "uv.lock", "deno.lock", "flake.lock",
]);
function isDependencyPath(p) {
    const b = base(p);
    return DEPENDENCY_BASENAMES.has(b) || (b.startsWith("requirements") && b.endsWith(".txt"));
}
const CI_BASENAMES = new Set([
    ".gitlab-ci.yml", "jenkinsfile", ".travis.yml", "azure-pipelines.yml", "bitbucket-pipelines.yml", "install", "install.sh", "install.ps1", "install.bat",
    "installer.sh", "release-please-config.json", "release.config.js", "release.config.cjs", ".releaserc", ".releaserc.json", ".releaserc.yml",
]);
function isCiReleasePath(p) {
    const b = base(p);
    const lp = lower(p);
    if (lp.startsWith(".github/workflows/") || lp.startsWith(".github/actions/") || lp.startsWith(".circleci/"))
        return true;
    return CI_BASENAMES.has(b) || b.startsWith(".goreleaser.") || b.startsWith("installer.") || b.startsWith("install-");
}
function isHookPath(p) {
    const b = base(p);
    if (["lefthook.yml", ".lefthook.yml", ".pre-commit-config.yaml", "hooks.json"].includes(b))
        return true;
    return segmentsOf(lower(p)).slice(0, -1).some((s) => [".husky", ".githooks", ".git-hooks", "hooks"].includes(s));
}
function isContractPath(p) {
    if (hasExcludedSegment(p))
        return false;
    const b = base(p);
    if (b.endsWith(".schema.json") || b.endsWith(".proto") || b.endsWith(".avsc") || b.startsWith("openapi.") || b.startsWith("swagger."))
        return true;
    return segmentsOf(lower(p)).slice(0, -1).some((s) => ["contracts", "contract", "schemas", "schema"].includes(s));
}
const CREDENTIAL_TOKENS = new Set(["secret", "secrets", "credential", "credentials", "password", "passwords", "passwd", "apikey", "apikeys", "keystore"]);
function isCredentialPath(p) {
    const b = base(p);
    if (b === ".env" || b.startsWith(".env.") || [".npmrc", ".pypirc", ".netrc", ".htpasswd"].includes(b) || b.startsWith("id_rsa") || b.startsWith("id_ed25519"))
        return true;
    if ([".pem", ".key", ".p12", ".pfx", ".jks"].includes(ext(p)))
        return true;
    if (isTestPath(p) || hasExcludedSegment(p) || b.startsWith("readme"))
        return false;
    return lower(p).split(/[/\\._-]+/).some((t) => CREDENTIAL_TOKENS.has(t));
}
const PERMISSION_TOKENS = new Set(["permission", "permissions", "acl", "acls", "rbac", "sudoers", "iam", "codeowners"]);
function isPermissionPath(p) {
    if (isTestPath(p) || hasExcludedSegment(p) || base(p).startsWith("readme"))
        return false;
    return lower(p).split(/[/\\._-]+/).some((t) => PERMISSION_TOKENS.has(t));
}
function isSemanticEligible(s) {
    if (!isInspectable(s) || hasExcludedSegment(s.path) || base(s.path).startsWith("readme"))
        return false;
    return SOURCE_EXTENSIONS.has(ext(s.path)) || isConfigPath(s.path);
}
function isContentScanEligible(s) {
    if (!isInspectable(s) || hasExcludedSegment(s.path) || isTestPath(s.path))
        return false;
    return SOURCE_EXTENSIONS.has(ext(s.path)) || ext(s.path) === ".txt" || isConfigPath(s.path);
}
const isInspectable = (s) => s.additions + s.deletions !== 0 && !s.binary && !s.modeOnly && !isGeneratedGoldenPath(s.path);
function isOperationalMarkdown(p) {
    const lp = lower(p);
    const segs = lp.split("/");
    if (["agents.md", "claude.md", "gemini.md", "kimi.md", "skill.md", "copilot-instructions.md"].includes(basename(lp)))
        return true;
    for (let i = 0; i < segs.length; i++) {
        const seg = segs[i];
        if ([".agent", ".agents", ".claude", ".codex", ".cursor", ".opencode", "openspec", "runtime"].includes(seg))
            return true;
        if (i === 1 && segs[0] === "internal" && ["runtime", "assets", "templates"].includes(seg))
            return true;
        const name = seg.slice(0, seg.length - extname(seg).length);
        for (const token of name.split(/[^a-z0-9]+/).filter(Boolean)) {
            if (["agent", "agents", "skill", "skills", "prompt", "prompts", "instruction", "instructions", "orchestrator", "orchestrators", "workflow", "workflows"].includes(token))
                return true;
        }
    }
    return false;
}
const OPERATIONAL_TOKENS = ["agent", "agents", "command", "commands", "prompt", "prompts", "rule", "rules", "runtime", "runtimes", "skill", "skills", "workflow", "workflows"];
function isPassiveCandidatePath(p) {
    const e = ext(p);
    const docExt = e === ".md" ? !isOperationalMarkdown(p) : [".mdx", ".rst", ".adoc", ".png", ".jpg", ".jpeg", ".gif"].includes(e);
    if (!docExt || isConfigPath(p))
        return false;
    const lp = lower(p);
    if (lp.startsWith("internal/assets/"))
        return false;
    const b = basename(lp);
    if (["agents.md", "claude.md", "gemini.md", "kimi.md", "soul.md", "tools.md", "skill.md", "copilot-instructions.md"].includes(b))
        return false;
    const stem = b.slice(0, b.length - extname(b).length);
    if (stem.split(/[-_. ]+/).some((t) => OPERATIONAL_TOKENS.includes(t)))
        return false;
    for (const seg of lp.split("/")) {
        if ([".github", ".claude", ".codex", ".cursor", ".gemini", ".kiro", ".kilo", ".opencode", ".windsurf", ...OPERATIONAL_TOKENS].includes(seg))
            return false;
    }
    return true;
}
const isImagePath = (p) => [".png", ".jpg", ".jpeg", ".gif"].includes(ext(p));
const isRegularNonExec = (m) => m === "" || m === "000000" || m === "100644";
const isRegularFile = (m) => m === "100644" || m === "100755";
function isPassiveStat(s) {
    if (s.binary && !isImagePath(s.path))
        return false;
    if (s.modeOnly || !isPassiveCandidatePath(s.path))
        return false;
    return isRegularNonExec(s.oldMode) && isRegularNonExec(s.newMode);
}
function executableBitChanged(oldMode, newMode) {
    if (!oldMode || !newMode)
        return false;
    const o = parseInt(oldMode, 8);
    const n = parseInt(newMode, 8);
    return Number.isFinite(o) && Number.isFinite(n) && (o & 0o111) !== (n & 0o111);
}
function hasPassiveImageSignature(b) {
    return b.subarray(0, 8).equals(Buffer.from("\x89PNG\r\n\x1a\n", "latin1")) || (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) || b.subarray(0, 6).toString("latin1") === "GIF87a" || b.subarray(0, 6).toString("latin1") === "GIF89a";
}
const hasShebang = (b) => (b.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? b.subarray(3, 5) : b.subarray(0, 2)).toString("latin1") === "#!";
function isPassiveContent(p, content) {
    if (isImagePath(p))
        return hasPassiveImageSignature(content);
    if (content.includes(0))
        return false;
    try {
        new TextDecoder("utf-8", { fatal: true }).decode(content);
    }
    catch {
        return false;
    }
    if (hasShebang(content))
        return false;
    if (ext(p) === ".mdx")
        return !/^\s*(import|export)\b/m.test(content.toString("utf8"));
    return true;
}
// ---------------------------------------------------------------------------------------------
// content patterns over ADDED lines
// ---------------------------------------------------------------------------------------------
const PROCESS_LINE = new RegExp("((^|[^A-Za-z0-9_.])(subprocess|child_process|execute_process|exec)([^A-Za-z0-9_]|$))" +
    "|(execSync\\(|getRuntime\\(\\)\\.exec\\(|ProcessBuilder|os\\.system\\(|os\\.exec[lv]p?e?\\(|posix_spawn|proc_open\\(|shell_exec\\(|passthru\\(|popen\\(|Process\\.Start\\()" +
    "|((^|[^A-Za-z0-9_])(spawn|spawnSync|execFile|execFileSync)\\s*\\()|(\\.(spawn|spawnSync|execFile|execFileSync)\\s*\\()|(Bun\\.spawn|Deno\\.Command)", "i");
const NETWORK_LINES = [
    /(?:^|[^\w.])fetch\s*\(/,
    /\baxios(?:\.\w+)?\s*\(|\baxios\.(?:get|post|put|delete|patch|request)\b/,
    /\b(?:https?|net|tls|dgram)\.(?:request|get|connect|createConnection|createServer|Socket|createSocket)\b/,
    /\bfrom\s+["']node:(?:https?|net|tls|dgram|dns)["']|\brequire\(\s*["'](?:node:)?(?:https?|net|tls|dgram|dns)["']\s*\)/,
    /\bnew\s+(?:WebSocket|XMLHttpRequest|EventSource)\b/,
    /\brequests\.(?:get|post|put|delete|patch|request|head)\s*\(|\burllib\.request\b|\burlopen\s*\(|\bhttpx\.\w+\s*\(|\bsocket\.socket\s*\(/,
    /\bhttp\.(?:Get|Post|NewRequest|ListenAndServe|Head)\s*\(|\bnet\.(?:Dial|Listen)\w*\s*\(/,
    /\b(?:curl|wget)\s+\S/,
];
const FS_DELETE_LINES = [
    /\b(?:rmSync|rmdirSync|unlinkSync)\s*\(/,
    /\bfs(?:\.promises)?\.(?:rm|rmdir|unlink)\s*\(/,
    /(?:^|[;&|(]|\s)rm\s+-[a-zA-Z]*[rf]/,
    /\bshutil\.rmtree\s*\(|\bos\.(?:remove|unlink|rmdir|removedirs)\s*\(|\bos\.RemoveAll\s*\(/,
    /\bFiles\.delete(?:IfExists)?\s*\(|\bremove_dir_all\s*\(|\bFileUtils\.(?:rm|rm_rf|rm_r|remove_entry)\w*\s*\(/,
    /(?:^|[^\w.])unlink\s*\(/,
];
const sink = (exts, re) => ({ exts: ` ${exts} `, re });
const JSX = ".js .jsx .ts .tsx .mjs .cjs .mts .cts";
const ALL = ".go .java .kt .kts .js .jsx .ts .tsx .mjs .cjs .py .php .rb .rs .cs";
const SINKS = [
    sink(".go", /\bInsecureSkipVerify\s*:\s*true\b/),
    sink(JSX, /\brejectUnauthorized\s*:\s*false\b|\bNODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0\b/),
    sink(".py", /\bverify\s*=\s*False\b|\bCERT_NONE\b|\bcheck_hostname\s*=\s*False\b/),
    sink(".rs", /\.danger_accept_invalid_certs\s*\(\s*true\s*\)/),
    sink(".sh .bash .zsh", /\bcurl\s+(?:[^;|]*\s)?(?:--insecure|-k)(?:\s|$)/),
    sink(".py", /\bpickle\.loads?\s*\(|\byaml\.unsafe_load\s*\(|\bmarshal\.loads?\s*\(/),
    sink(".java .kt .kts", /\bObjectInputStream\s*\(/),
    sink(".rb", /\bMarshal\.load\s*\(|\bYAML\.load\s*\(/),
    sink(`${JSX} .py .php .rb`, /(?:^|[^\w.])eval\s*\(/),
    sink(JSX, /\bnew\s+Function\s*\(|\bvm\.runInNewContext\s*\(/),
    sink(".py", /\bsubprocess\.(?:run|Popen|call|check_call|check_output)\s*\([^;\n]*\bshell\s*=\s*True\b/),
    sink(ALL, /["'](?:sh|bash)["']\s*,\s*["']-c["']\s*,\s*(?:\w+|["'][^"']*["']\s*\+|f["']|`)/),
    sink(ALL, /Access-Control-Allow-Origin[^;\n]*\*[^;\n]*;[^\n]*Access-Control-Allow-Credentials[^\n]*true/i),
    sink(ALL, /\b(?:chmod|mkdir|WriteFile|chmodSync|mkdirSync|writeFileSync)\s*\([^\n]*\b(?:0o777|0777|0666)\b|\bumask\s*\(\s*0\s*\)/i),
    sink(".sh .bash .zsh", /\bchmod\s+(?:-R\s+)?(?:777\b|o\+w\b)/),
    sink(".py", /\bjwt\.decode\s*\([^\n]*(?:\bverify\s*=\s*False\b|["']verify_signature["']\s*:\s*False\b)/),
    sink(".go", /\b(?:jwt|\w+)\.ParseUnverified\s*\(/),
    sink(".py", /@csrf_exempt\b|\bWTF_CSRF_ENABLED\s*=\s*False\b/),
    sink(`${JSX} .php .rb`, /\bcsrf\s*:\s*false\b|\bcsrf\s*=>\s*false\b/),
];
function commentSyntax(p) {
    const b = base(p);
    if (b === "dockerfile" || b === "makefile" || b === "cmakelists.txt" || b === ".env" || b.startsWith(".env.") || (b.startsWith("requirements") && b.endsWith(".txt")))
        return "hash";
    const e = ext(p);
    if ([".sh", ".bash", ".zsh", ".py", ".rb", ".pl", ".pm", ".r", ".ps1", ".psm1", ".yaml", ".yml", ".toml", ".ini", ".conf", ".cfg", ".cmake", ".mk", ".tf", ".nix"].includes(e))
        return "hash";
    if ([".sql", ".lua", ".hs", ".adb", ".ads"].includes(e))
        return "dash";
    if ([".c", ".cc", ".cpp", ".h", ".hpp", ".cs", ".go", ".java", ".js", ".jsx", ".kt", ".kts", ".php", ".rs", ".swift", ".ts", ".tsx", ".scala", ".dart", ".mjs", ".cjs", ".mts", ".cts"].includes(e))
        return "slash";
    return "unknown";
}
function isCommentOnly(p, line) {
    const t = line.trim();
    switch (commentSyntax(p)) {
        case "hash":
            return t.startsWith("#");
        case "dash":
            return t.startsWith("--");
        case "slash": {
            if (t.startsWith("//"))
                return true;
            if (t.startsWith("/*")) {
                const closing = t.indexOf("*/", 2);
                return closing < 0 || t.slice(closing + 2).trim() === "";
            }
            if (t.startsWith("*/"))
                return t.slice(2).trim() === "";
            return t === "*" || t.startsWith("* ") || t.startsWith("*\t");
        }
        default:
            return false;
    }
}
function sinkLine(p, line) {
    const e = ` ${ext(p)} `;
    return SINKS.some((s) => s.exts.includes(e) && s.re.test(line));
}
// ---------------------------------------------------------------------------------------------
// bounded blob access (frozen objects only)
// ---------------------------------------------------------------------------------------------
function blobSizes(cwd, oids, bound) {
    const sizes = new Map();
    if (oids.length === 0)
        return sizes;
    const out = runGit({ cwd, args: ["cat-file", "--batch-check"], input: oids.join("\n") + "\n", ...bound, limit: OUTPUT_LIMIT }).stdout.toString("utf8");
    for (const line of out.split("\n")) {
        const f = line.split(" ");
        if (f.length === 3 && f[1] === "blob" && /^\d+$/.test(f[2]))
            sizes.set(f[0], Number(f[2]));
    }
    return sizes;
}
function readBlobs(cwd, oids, sizes, bound) {
    const blobs = new Map();
    if (oids.length === 0)
        return blobs;
    const total = oids.reduce((n, o) => n + (sizes.get(o) ?? 0), 0);
    const out = runGit({ cwd, args: ["cat-file", "--batch"], input: oids.join("\n") + "\n", ...bound, limit: total + oids.length * 160 + 4096 }).stdout;
    let pos = 0;
    while (pos < out.length) {
        const nl = out.indexOf(10, pos);
        if (nl < 0)
            break;
        const header = out.toString("utf8", pos, nl).split(" ");
        if (header[1] !== "blob") {
            pos = nl + 1;
            continue;
        }
        const size = Number(header[2]);
        if (!Number.isInteger(size) || nl + 1 + size > out.length)
            throw new SnapshotError("corrupt_output", "unexpected cat-file output");
        blobs.set(header[0], out.subarray(nl + 1, nl + 1 + size));
        pos = nl + 1 + size + 1;
    }
    return blobs;
}
function pathspecBatches(paths) {
    const batches = [];
    let current = [];
    let chars = 0;
    for (const p of paths) {
        const spec = `:(literal)${p}`;
        if (current.length > 0 && (chars + spec.length > PATHSPEC_BATCH_CHARS || current.length >= PATHSPEC_BATCH_ENTRIES)) {
            batches.push(current);
            current = [];
            chars = 0;
        }
        current.push(spec);
        chars += spec.length + 1;
    }
    if (current.length > 0)
        batches.push(current);
    return batches;
}
// ---------------------------------------------------------------------------------------------
// assessment
// ---------------------------------------------------------------------------------------------
function canonicalReasons(reasons) {
    const cmp = (a, b) => ((a ?? "") < (b ?? "") ? -1 : (a ?? "") > (b ?? "") ? 1 : 0);
    const sorted = [...reasons].sort((a, b) => cmp(a.code, b.code) || cmp(a.signal, b.signal) || cmp(a.path, b.path) || cmp(a.old_mode, b.old_mode) || cmp(a.new_mode, b.new_mode));
    const seen = new Set();
    const out = [];
    for (const r of sorted) {
        const key = `${r.code}\0${r.signal ?? ""}`;
        if (seen.has(key))
            continue;
        seen.add(key);
        out.push(r);
    }
    return out;
}
function levelFromReasons(reasons) {
    if (reasons.some((r) => r.signal !== undefined))
        return "high";
    if (reasons.length === 1 && reasons[0].code === "non_executable_only")
        return "low";
    return "medium";
}
function focusFor(reasons) {
    const has = (c) => reasons.some((r) => r.code === c);
    if (has("file_deletion"))
        return "resilience";
    if (has("large_change"))
        return "readability";
    return "risk";
}
function evidenceFor(level, reasons) {
    if (level === "low")
        return ["documentation or other non-executable files only"];
    const lines = reasons.map((r) => `${r.code}${r.signal ? ` [${r.signal}]` : ""}${r.path ? `: ${r.path}` : ""}`);
    return lines.length > MAX_EVIDENCE_LINES ? [...lines.slice(0, MAX_EVIDENCE_LINES), `… ${lines.length - MAX_EVIDENCE_LINES} more`] : lines;
}
const scanLimit = (path) => ({ code: "process_scan_limit", signal: "shell_process", path });
/** Classify a frozen snapshot from its two trees only. Deterministic; bounded; never reads the worktree. */
export function assessRisk(snapshot, repo, options = {}) {
    const bound = boundOf(options);
    const cwd = repo.root;
    const stats = collectStats(snapshot, repo, bound);
    const candidates = [];
    // name/mode based evidence
    for (const s of stats) {
        const golden = isGeneratedGoldenPath(s.path);
        if (isSemanticEligible(s)) {
            if (isServiceTokenPath(s.path) && !isTestPath(s.path))
                candidates.push({ code: "service_token", signal: "auth", path: s.path });
            if (isShellPath(s.path))
                candidates.push({ code: "shell_source", signal: "shell_process", path: s.path });
        }
        if (executableBitChanged(s.oldMode, s.newMode)) {
            candidates.push({ code: "executable_mode", signal: "permissions", path: s.path, old_mode: s.oldMode, new_mode: s.newMode });
        }
        if (golden)
            continue;
        for (const signal of hotPathSignals(s.path))
            candidates.push({ code: "hot_path", signal, path: s.path });
        if (isTestPath(s.path))
            continue;
        if (isDependencyPath(s.path))
            candidates.push({ code: "dependency_change", signal: "dependency", path: s.path });
        if (isCiReleasePath(s.path))
            candidates.push({ code: "ci_release_change", signal: "ci_release", path: s.path });
        if (isHookPath(s.path))
            candidates.push({ code: "hook_change", signal: "hooks", path: s.path });
        if (isContractPath(s.path))
            candidates.push({ code: "contract_change", signal: "contract", path: s.path });
        if (isCredentialPath(s.path))
            candidates.push({ code: "credential_path", signal: "credentials", path: s.path });
        if (isPermissionPath(s.path))
            candidates.push({ code: "permission_path", signal: "permissions", path: s.path });
    }
    // blob budget: sizes first, then bounded reads
    const scanStats = stats.filter(isContentScanEligible);
    const passiveStats = stats.filter((s) => isPassiveStat(s) && isRegularFile(s.newMode) && !ZERO_OID.test(s.newOid));
    const sizeOids = new Set();
    for (const s of scanStats) {
        if (isRegularFile(s.oldMode) && !ZERO_OID.test(s.oldOid))
            sizeOids.add(s.oldOid);
        if (isRegularFile(s.newMode) && !ZERO_OID.test(s.newOid))
            sizeOids.add(s.newOid);
    }
    for (const s of passiveStats)
        sizeOids.add(s.newOid);
    const sizes = blobSizes(cwd, [...sizeOids].sort(), bound);
    let limitHit;
    let total = 0;
    const oversizedPassive = new Set();
    const sideBlobs = (s) => [s.oldMode && isRegularFile(s.oldMode) ? s.oldOid : "", isRegularFile(s.newMode) ? s.newOid : ""].filter((o) => o !== "" && !ZERO_OID.test(o));
    for (const s of scanStats) {
        for (const oid of sideBlobs(s)) {
            const size = sizes.get(oid) ?? 0;
            total += size;
            if (size > MAX_BLOB_SCAN_BYTES || total > MAX_TOTAL_SCAN_BYTES)
                limitHit ??= s.path;
        }
    }
    for (const s of passiveStats) {
        const size = sizes.get(s.newOid) ?? 0;
        total += size;
        if (size > MAX_BLOB_SCAN_BYTES || total > MAX_TOTAL_SCAN_BYTES)
            oversizedPassive.add(s.path);
    }
    const contradicted = new Set(oversizedPassive);
    if (limitHit !== undefined) {
        candidates.push(scanLimit(limitHit));
    }
    else {
        const readOids = new Set();
        for (const s of scanStats)
            if (isRegularFile(s.newMode) && !ZERO_OID.test(s.newOid))
                readOids.add(s.newOid);
        for (const s of passiveStats)
            if (!oversizedPassive.has(s.path))
                readOids.add(s.newOid);
        const blobs = readBlobs(cwd, [...readOids].sort(), sizes, bound);
        for (const s of scanStats) {
            const blob = isRegularFile(s.newMode) ? blobs.get(s.newOid) : undefined;
            if (blob && hasShebang(blob))
                candidates.push({ code: "process_boundary", signal: "shell_process", path: s.path });
        }
        for (const s of passiveStats) {
            const blob = blobs.get(s.newOid);
            if (oversizedPassive.has(s.path) || !blob || !isPassiveContent(s.path, blob))
                contradicted.add(s.path);
        }
        candidates.push(...scanAddedLines(snapshot, cwd, scanStats, bound));
    }
    // non-signal evidence
    for (const s of stats) {
        if (isGeneratedGoldenPath(s.path))
            continue;
        const passive = isPassiveStat(s) && !contradicted.has(s.path);
        if (s.newMode === "120000" || s.oldMode === "120000")
            candidates.push({ code: "symlink_change", path: s.path });
        else if (s.newMode === "160000" || s.oldMode === "160000")
            candidates.push({ code: "submodule_change", path: s.path });
        else if (s.binary && !(isImagePath(s.path) && passive))
            candidates.push({ code: "binary_change", path: s.path });
        else if (s.newMode === "000000" && !passive)
            candidates.push({ code: "file_deletion", path: s.path });
    }
    if (snapshot.changedLines >= LARGE_CHANGE_LINES)
        candidates.push({ code: "large_change" });
    let reasons = canonicalReasons(candidates);
    if (reasons.length === 0) {
        reasons = [fallbackReason(stats, contradicted)];
    }
    const level = levelFromReasons(reasons);
    const result = { risk_level: level, level, reasons, evidence: evidenceFor(level, reasons) };
    if (level === "medium")
        result.focusLens = focusFor(reasons);
    return result;
}
function fallbackReason(stats, contradicted) {
    for (const s of stats) {
        if (isGeneratedGoldenPath(s.path))
            continue;
        if (isConfigPath(s.path))
            return { code: "configuration_change", path: s.path };
        if (contradicted.has(s.path) || !isPassiveStat(s)) {
            if (!s.binary && !s.modeOnly && s.additions + s.deletions === 0)
                return { code: "empty_content", path: s.path };
            return { code: "executable_change", path: s.path };
        }
    }
    return { code: "non_executable_only" };
}
/** Added-line evidence (process / sink / network / deletion) from the frozen diff, batched and byte-bounded. */
function scanAddedLines(snapshot, cwd, scanStats, bound) {
    const reasons = [];
    const paths = scanStats.map((s) => s.path);
    const fixed = [
        "-c", "core.quotePath=false", "diff", "--text", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames",
        "--src-prefix=a/", "--dst-prefix=b/", "--unified=0", snapshot.baseTree, snapshot.candidateTree, "--",
    ];
    for (const batch of pathspecBatches(paths)) {
        const first = batch[0].slice(":(literal)".length);
        const known = new Set(batch.map((b) => b.slice(":(literal)".length)));
        let out;
        try {
            out = runGit({ cwd, args: [...fixed, ...batch], ...bound, limit: OUTPUT_LIMIT }).stdout;
        }
        catch (e) {
            if (e instanceof SnapshotError && e.code === "git_output_limit")
                return [scanLimit(first)];
            throw e;
        }
        let current = "";
        let inHunk = false;
        const seen = { process: false, sink: false, network: false, fsdelete: false };
        for (const raw of out.toString("utf8").split("\n")) {
            if (raw.startsWith("diff --git ")) {
                const sep = raw.lastIndexOf(" b/");
                if (sep < 0)
                    return [scanLimit(first)];
                current = raw.slice(sep + 3);
                inHunk = false;
                seen.process = seen.sink = seen.network = seen.fsdelete = false;
                if (!known.has(current))
                    return [scanLimit(first)];
            }
            else if (raw.startsWith("@@")) {
                inHunk = true;
            }
            else if (inHunk && raw.startsWith("+")) {
                const added = raw.slice(1, 1 + MAX_SCAN_LINE_CHARS);
                if (isCommentOnly(current, added))
                    continue;
                const source = SOURCE_EXTENSIONS.has(ext(current));
                if (!seen.process && PROCESS_LINE.test(added)) {
                    reasons.push({ code: "process_boundary", signal: "shell_process", path: current });
                    seen.process = true;
                }
                if (!seen.sink && sinkLine(current, added)) {
                    reasons.push({ code: "dangerous_sink", signal: "dangerous_sink", path: current });
                    seen.sink = true;
                }
                if (source && !seen.network && NETWORK_LINES.some((re) => re.test(added))) {
                    reasons.push({ code: "network_access", signal: "network", path: current });
                    seen.network = true;
                }
                if (source && !seen.fsdelete && FS_DELETE_LINES.some((re) => re.test(added))) {
                    reasons.push({ code: "filesystem_deletion", signal: "data_loss", path: current });
                    seen.fsdelete = true;
                }
            }
        }
    }
    return reasons;
}
/** Freeze the target (private temp index only) and assess it. Writes no review state; due = high. */
export function assessCandidate(cwd, target, options = {}) {
    const frozen = freezeSnapshot(cwd, target, options);
    if (frozen.status === "empty")
        return { status: "not_due", reason: "no_changes", reviewDue: false, kind: frozen.kind, projection: frozen.projection };
    const a = assessRisk(frozen.snapshot, frozen.repository, options);
    const out = {
        status: "assessed",
        risk: a.risk_level,
        reasons: a.reasons,
        evidence: a.evidence,
        changedPaths: [...frozen.snapshot.paths],
        changedLines: frozen.snapshot.changedLines,
        reviewDue: a.risk_level === "high",
        kind: frozen.snapshot.kind,
        projection: frozen.snapshot.projection,
        targetIdentity: frozen.snapshot.identity,
        baseTree: frozen.snapshot.baseTree,
        candidateTree: frozen.snapshot.candidateTree,
    };
    if (a.focusLens !== undefined)
        out.focusLens = a.focusLens;
    return out;
}
