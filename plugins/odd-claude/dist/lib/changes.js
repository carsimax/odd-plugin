// R46 working-tree changes summary (port of the upstream Changes view, reduced to text). Git is the source of
// truth for what changed; nothing is recorded per session. Read-only: `git status` and `git diff --stat` with
// optional locks off, a bounded timeout and no user text on any command line. Never throws.
import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { cleanText } from "./statusline.js";
const MAX_FILES = 50;
const MAX_STAT_LINES = 40;
const MAX_LINE = 200;
const GIT_TIMEOUT_MS = 5000;
const NOT_A_REPO = "Not a git repository; no changes to summarize.";
const TIMED_OUT = "git timed out; changes unavailable.";
const GIT_FAILED = "git failed; changes unavailable.";
const NO_GIT = "git not found; changes unavailable.";
/** Runs git in `cwd`; a `fail` reason on any failure (timeout, missing git, not a repo / other error). */
function runGit(cwd, args, timeoutMs) {
    const r = spawnSync("git", ["-c", "core.fsmonitor=false", "-c", "core.quotepath=false", ...args], {
        cwd,
        encoding: "utf8",
        timeout: timeoutMs,
        killSignal: "SIGKILL", // a git that ignores SIGTERM must not hold the caller past the timeout
        maxBuffer: 4 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
        // C locale: the stderr classification below matches English text only
        env: { ...process.env, LC_ALL: "C", LANG: "C", LANGUAGE: undefined, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
    });
    if (r.error) {
        const code = r.error.code;
        return { fail: code === "ETIMEDOUT" ? "timeout" : code === "ENOENT" ? "missing" : "failed" };
    }
    if (r.status !== 0) {
        if (r.signal === "SIGKILL")
            return { fail: "timeout" };
        // same classification as the mod (hooks/register.ts): only this stderr means "not a repository"
        return { fail: /not a git repository/i.test(r.stderr ?? "") ? "not-a-repo" : "failed" };
    }
    return { out: r.stdout ?? "" };
}
export function collectChanges(cwd, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? GIT_TIMEOUT_MS;
    let isDir = false;
    try {
        isDir = statSync(cwd).isDirectory();
    }
    catch {
        // missing directory: not a repository
    }
    if (!isDir)
        return NOT_A_REPO;
    const status = runGit(cwd, ["status", "--porcelain=v1", "-z", "--branch"], timeoutMs);
    if ("fail" in status)
        return status.fail === "timeout" ? TIMED_OUT : status.fail === "missing" ? NO_GIT : status.fail === "not-a-repo" ? NOT_A_REPO : GIT_FAILED;
    const head = runGit(cwd, ["diff", "--stat", "--no-color", "HEAD"], timeoutMs);
    const stat = "out" in head ? head : runGit(cwd, ["diff", "--stat", "--no-color"], timeoutMs);
    return summarizeChanges(status.out, "out" in stat ? stat.out : undefined);
}
/** Pure: `git status --porcelain=v1 -z --branch` output plus `git diff --stat` output to the printed summary. */
export function summarizeChanges(statusZ, stat) {
    const tokens = statusZ.split("\0");
    let branch = "";
    const entries = [];
    let untracked = 0;
    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (t === "")
            continue;
        if (t.startsWith("## ")) {
            branch = cleanText(t.slice(3).split("...")[0].replace(/^No commits yet on /, "").replace(/^Initial commit on /, "")).slice(0, MAX_LINE);
            continue;
        }
        const code = t.slice(0, 2);
        const path = cleanText(t.slice(3)).slice(0, MAX_LINE);
        if (code === "??")
            untracked++;
        if (/[RC]/.test(code)) {
            const orig = cleanText(tokens[++i] ?? "").slice(0, MAX_LINE);
            entries.push(`${code} ${orig} -> ${path}`);
        }
        else
            entries.push(`${code} ${path}`);
    }
    const head = `odd-claude changes${branch === "" ? "" : ` · branch ${branch}`}`;
    if (entries.length === 0)
        return `${head}\nWorking tree clean.`;
    const shown = entries.slice(0, MAX_FILES);
    const out = [head, ...shown];
    if (entries.length > shown.length)
        out.push(`… and ${entries.length - shown.length} more`);
    out.push(`${entries.length} changed, ${untracked} untracked`);
    const statLines = cleanStat(stat);
    if (statLines.length > 0)
        out.push("", ...statLines);
    return out.join("\n");
}
function cleanStat(stat) {
    if (!stat)
        return [];
    const lines = stat.split("\n").map((l) => cleanText(l).slice(0, MAX_LINE)).filter((l) => l !== "");
    if (lines.length <= MAX_STAT_LINES)
        return lines;
    return [...lines.slice(0, MAX_STAT_LINES - 1), "…", lines[lines.length - 1]];
}
