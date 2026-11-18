// R46 working-tree changes summary (port of the upstream Changes view, reduced to text). Git is the source of
// truth for what changed; nothing is recorded per session. Read-only: `git status` and `git diff --stat` with
// optional locks off, a bounded timeout and no user text on any command line. Never throws.
import { spawnSync } from "node:child_process";
import { cleanText } from "./statusline.js";
const MAX_FILES = 50;
const MAX_STAT_LINES = 40;
const MAX_LINE = 200;
const NOT_A_REPO = "Not a git repository; no changes to summarize.";
/** Runs git in `cwd`; undefined on any failure (not a repo, timeout, missing git). */
function runGit(cwd, args) {
    const r = spawnSync("git", ["-c", "core.fsmonitor=false", "-c", "core.quotepath=false", ...args], {
        cwd,
        encoding: "utf8",
        timeout: 5000,
        maxBuffer: 4 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
    });
    if (r.error || r.status !== 0)
        return undefined;
    return r.stdout ?? "";
}
export function collectChanges(cwd) {
    const status = runGit(cwd, ["status", "--porcelain=v1", "-z", "--branch"]);
    if (status === undefined)
        return NOT_A_REPO;
    const stat = runGit(cwd, ["diff", "--stat", "--no-color", "HEAD"]) ?? runGit(cwd, ["diff", "--stat", "--no-color"]);
    return summarizeChanges(status, stat);
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
