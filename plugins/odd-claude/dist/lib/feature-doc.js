// Active ODD feature document: the file in `<git root>/odd/tasks/*.md` whose header names the current branch. Used to reinject a compact
// state summary after a compaction or a resume. Fail-soft: any problem (no git, no match, unreadable file) yields undefined.
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { realExec } from "./system.js";
export const FEATURE_DOC_SUMMARY_CAP = 2000;
const LINE_CAP = 160;
const LOG_CAP = 300;
function clip(s, max) {
    return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 3))}...`;
}
/** The feature document whose header (text before the first `## ` heading) contains ``Branch: `<branch>` ``, or undefined. */
export function findActiveFeatureDoc(cwd, exec = realExec) {
    try {
        const root = exec("git", ["-C", cwd, "rev-parse", "--show-toplevel"]);
        const branch = exec("git", ["-C", cwd, "branch", "--show-current"]);
        if (!root || !branch)
            return undefined;
        const dir = join(root, "odd", "tasks");
        const needle = `Branch: \`${branch}\``;
        for (const name of readdirSync(dir).filter((n) => n.endsWith(".md")).sort()) {
            try {
                const path = join(dir, name);
                const text = readFileSync(path, "utf8");
                const head = text.split(/\n## /, 1)[0] ?? "";
                if (head.includes(needle))
                    return { path: relative(root, path), text };
            }
            catch {
                // unreadable candidate: try the next one
            }
        }
    }
    catch {
        // no git, no odd/tasks directory
    }
    return undefined;
}
/** Body of the `## <title>` section: its lines and the 0-based index of the first body line in `text`; `start` is -1 when the heading is absent. */
export function sectionRange(text, title) {
    const lines = text.split("\n");
    const at = lines.findIndex((l) => l.trim() === `## ${title}`);
    if (at < 0)
        return { start: -1, lines: [] };
    const rest = lines.slice(at + 1);
    const end = rest.findIndex((l) => l.startsWith("## "));
    return { start: at + 1, lines: end < 0 ? rest : rest.slice(0, end) };
}
export function section(text, title) {
    return sectionRange(text, title).lines;
}
/** A task line of `## Tasks`: `- T<n> ...` or a `- [ ]` checkbox. */
export function isTaskLine(line) {
    return /^- (T\d+|\[ \])/.test(line.trim());
}
/** A task line whose route/status column says `done`. */
export function isDoneTaskLine(line) {
    return /\|\s*done\b/i.test(line);
}
/** An open task: a task line not marked done. */
export function isOpenTaskLine(line) {
    return isTaskLine(line) && !isDoneTaskLine(line);
}
/** Compact state of a feature document, hard-capped at FEATURE_DOC_SUMMARY_CAP characters. */
export function summarizeFeatureDoc(doc) {
    const ids = [...new Set([...section(doc.text, "Specs").join("\n").matchAll(/^- \*\*(S\d+)\*\*/gm)].map((m) => m[1]))];
    const open = section(doc.text, "Tasks")
        .map((l) => l.trim())
        .filter(isOpenTaskLine)
        .map((l) => clip(l, LINE_CAP));
    const log = section(doc.text, "Log")
        .map((l) => l.trim())
        .filter((l) => l.startsWith("- "));
    const first = (doc.text.split("\n", 1)[0] ?? "").trim();
    const parts = [
        `Active ODD feature document (reinjected): ${doc.path}`,
        `Header: ${clip(first, LINE_CAP)}`,
        `Specs: ${ids.length > 0 ? ids.join(", ") : "none listed"}`,
        `Open tasks:${open.length > 0 ? `\n${open.join("\n")}` : " none"}`,
        `Last log entry: ${log.length > 0 ? clip(log[log.length - 1], LOG_CAP) : "none"}`,
    ];
    return clip(parts.join("\n"), FEATURE_DOC_SUMMARY_CAP);
}
/** The summary for the active document of the cwd's branch, or undefined. */
export function activeFeatureDocSummary(cwd, exec = realExec) {
    const doc = findActiveFeatureDoc(cwd, exec);
    if (!doc)
        return undefined;
    try {
        return summarizeFeatureDoc(doc);
    }
    catch {
        return undefined;
    }
}
export const TASKS_LINT_SCHEMA = "odd-claude.tasks-lint/v1";
function defaultBranch(root, exec) {
    const ref = exec("git", ["-C", root, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
    return ref ? ref.replace(/^origin\//, "") : "main";
}
/** Why a branch no longer carries work (missing locally, or merged into the default branch), or undefined while it is live. */
function closedReason(root, branch, base, exec) {
    const tip = exec("git", ["-C", root, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
    if (tip === undefined)
        return "no longer exists locally";
    const baseTip = exec("git", ["-C", root, "rev-parse", "--verify", "--quiet", `refs/heads/${base}`]);
    // A branch still at the default branch's tip is freshly created, not merged.
    if (baseTip === undefined || baseTip === tip)
        return undefined;
    return exec("git", ["-C", root, "merge-base", "--is-ancestor", branch, base]) !== undefined ? `is already merged into ${base}` : undefined;
}
/** Lint one feature document; `file` is its repo-relative path. Pure apart from the git probes of the branch check. */
export function lintFeatureDoc(file, text, root, exec, base) {
    const out = [];
    const add = (line, rule, message) => out.push({ file, line, rule, message });
    const specs = sectionRange(text, "Specs");
    const tasks = sectionRange(text, "Tasks");
    const log = sectionRange(text, "Log");
    for (const [title, r] of [["Specs", specs], ["Tasks", tasks], ["Log", log]]) {
        if (r.start < 0)
            add(1, "missing-section", `no "## ${title}" section; add it (feature document layout: header, ## Specs, ## Tasks, ## Log).`);
    }
    const logText = log.lines.join("\n");
    const open = [];
    tasks.lines.forEach((raw, i) => {
        const line = tasks.start + i + 1;
        if (isOpenTaskLine(raw)) {
            open.push(line);
            if (!/done when/i.test(raw))
                add(line, "open-without-done-when", "open task has no `done when: <observable check>`; append the command or observation that proves it.");
            return;
        }
        const id = /^- (T\d+)/.exec(raw.trim())?.[1];
        if (id && isDoneTaskLine(raw) && !new RegExp(`\\b${id}\\b`).test(logText)) {
            add(line, "done-without-log", `${id} is marked done but never appears in ## Log; append a Log entry with its observed evidence, or reopen the task.`);
        }
    });
    const head = text.split(/\n## /, 1)[0] ?? "";
    const branch = /Branch: `([^`]+)`/.exec(head)?.[1];
    if (branch && open.length > 0) {
        const reason = closedReason(root, branch, base, exec);
        if (reason) {
            const line = text.split("\n").findIndex((l) => l.includes(`Branch: \`${branch}\``)) + 1;
            add(line, "open-tasks-on-closed-branch", `${open.length} open task(s) but branch \`${branch}\` ${reason}; mark finished tasks done with evidence in ## Log, or close the document.`);
        }
    }
    return out;
}
/** Read-only lint of every `<git root>/odd/tasks/*.md`, or undefined when there is no git root or tasks directory. */
export function lintFeatureDocs(cwd, exec = realExec) {
    try {
        const root = exec("git", ["-C", cwd, "rev-parse", "--show-toplevel"]);
        if (!root)
            return undefined;
        const dir = join(root, "odd", "tasks");
        const names = readdirSync(dir).filter((n) => n.endsWith(".md")).sort();
        const base = defaultBranch(root, exec);
        const findings = [];
        for (const name of names) {
            try {
                const path = join(dir, name);
                findings.push(...lintFeatureDoc(relative(root, path), readFileSync(path, "utf8"), root, exec, base));
            }
            catch {
                // unreadable document: skip it
            }
        }
        return { files: names.length, findings };
    }
    catch {
        return undefined;
    }
}
export function renderTasksLint(lint) {
    const head = `Feature documents: ${lint.files}, findings: ${lint.findings.length}`;
    return [head, ...lint.findings.map((f) => `${f.file}:${f.line} ${f.rule}: ${f.message}`)].join("\n");
}
