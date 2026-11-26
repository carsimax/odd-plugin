// Root of the odd-claude install (the dir holding package.json, dist/, cards/, agents/ ...).
// Resolution: CLAUDE_PLUGIN_ROOT (set by Claude Code while the plugin distribution exists), else the
// module location: this file is `<root>/dist/lib/root.js` (or `<root>/dist-test/lib/root.js`), so the root is three
// path segments up from the file itself.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
/** The root derived from where this module lives; never reads the environment. */
export function moduleRoot() {
    return join(dirname(fileURLToPath(import.meta.url)), "..", "..");
}
/** Legacy: `CLAUDE_PLUGIN_ROOT` is only set by the removed plugin distribution (bench still sets it). `CLAUDE_PLUGIN_ROOT` when set and non-empty, else the module-relative root. */
export function oddClaudeRoot(env = process.env) {
    const fromEnv = env.CLAUDE_PLUGIN_ROOT;
    return typeof fromEnv === "string" && fromEnv !== "" ? fromEnv : moduleRoot();
}
