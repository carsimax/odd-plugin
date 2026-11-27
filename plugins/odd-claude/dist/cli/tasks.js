// `node dist/cli/tasks.js [--json] [--cwd <dir>]`: read-only lint of `<git root>/odd/tasks/*.md`; always exits 0.
import { lintFeatureDocs, renderTasksLint, TASKS_LINT_SCHEMA } from "../lib/feature-doc.js";
import { flagValue, realExec, runMain } from "../lib/system.js";
export function tasksCli(argv, exec = realExec, defaultCwd = process.cwd()) {
    const json = argv.includes("--json");
    const note = (n) => ({ exitCode: 0, stdout: json ? JSON.stringify({ schema: TASKS_LINT_SCHEMA, note: n }, null, 2) : n });
    try {
        const lint = lintFeatureDocs(flagValue(argv, "--cwd") ?? defaultCwd, exec);
        if (lint === undefined)
            return note("No odd/tasks directory in a git repository; nothing to lint.");
        return { exitCode: 0, stdout: json ? JSON.stringify({ schema: TASKS_LINT_SCHEMA, ...lint }, null, 2) : renderTasksLint(lint) };
    }
    catch {
        return note("Tasks lint unavailable.");
    }
}
const main = () => tasksCli(process.argv.slice(2));
runMain(import.meta.url, main);
