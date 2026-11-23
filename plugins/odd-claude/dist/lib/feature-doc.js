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
function section(text, title) {
    const lines = text.split("\n");
    const start = lines.findIndex((l) => l.trim() === `## ${title}`);
    if (start < 0)
        return [];
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((l) => l.startsWith("## "));
    return end < 0 ? rest : rest.slice(0, end);
}
/** Compact state of a feature document, hard-capped at FEATURE_DOC_SUMMARY_CAP characters. */
export function summarizeFeatureDoc(doc) {
    const ids = [...new Set([...section(doc.text, "Specs").join("\n").matchAll(/^- \*\*(S\d+)\*\*/gm)].map((m) => m[1]))];
    const open = section(doc.text, "Tasks")
        .map((l) => l.trim())
        .filter((l) => /^- (T\d+|\[ \])/.test(l) && !/\|\s*done\b/i.test(l))
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
