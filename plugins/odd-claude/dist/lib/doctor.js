// Read-only diagnostics (R38 doctor semantics): probe tools and report ok/missing.
// Pure: every side effect (exec, env, filesystem) is injected so tests use fakes.
// Upstream treats Engram as a warning, not a failure; here node and git are required,
// engram, codegraph, the odd-claude install, its hooks and the data dir are optional.
import { dataDirFromEnv } from "./state.js";
export const MIN_NODE_MAJOR = 22;
export function parseVersion(text) {
    return /\d+\.\d+\.\d+/.exec(text)?.[0];
}
export function nodeSatisfies(version) {
    const major = Number(/^v?(\d+)\./.exec(version)?.[1]);
    return Number.isInteger(major) && major >= MIN_NODE_MAJOR;
}
function item(id, label, required, ok, detail) {
    return { id, label, required, status: ok ? "ok" : "missing", detail };
}
function probeBinary(deps, cmd, args) {
    const out = deps.exec(cmd, args);
    return out === undefined ? undefined : (parseVersion(out) ?? "unknown version");
}
export function collectDoctor(deps) {
    const items = [];
    items.push(item("node", "node", true, nodeSatisfies(deps.nodeVersion), `${deps.nodeVersion} (need >=${MIN_NODE_MAJOR})`));
    const git = probeBinary(deps, "git", ["--version"]);
    items.push(item("git", "git", true, git !== undefined, git ?? "not found on PATH"));
    const engramBin = probeBinary(deps, "engram", ["version"]);
    const plugins = deps.installedPlugins();
    const engramPlugin = plugins?.find((p) => p === "engram" || p.startsWith("engram@"));
    const engramParts = [
        engramBin !== undefined ? `binary ${engramBin}` : undefined,
        engramPlugin !== undefined ? `plugin ${engramPlugin}` : undefined,
    ].filter((p) => p !== undefined);
    items.push(item("engram", "engram", false, engramParts.length > 0, engramParts.join(", ") || "no binary on PATH and no engram plugin installed"));
    const cg = probeBinary(deps, "codegraph", ["--version"]);
    items.push(item("codegraph", "codegraph", false, cg !== undefined, cg !== undefined ? `${cg} (MCP server codegraph: serve --mcp)` : "not found on PATH (optional: the codegraph MCP server stays disconnected; install @colbymchenry/codegraph to enable it)"));
    const installed = deps.installedVersion();
    items.push(item("install", "odd-claude install", false, installed !== undefined, installed !== undefined ? `version ${installed} (~/.odd-claude/current)` : `no ~/.odd-claude/current (running v${deps.version}); run \`odd-claude install\``));
    const hooks = deps.hooksInstalled();
    items.push(item("hooks", "odd-claude hooks", false, hooks === true, hooks === true ? "registered in settings.json" : "not registered in settings.json"));
    const dataDir = dataDirFromEnv(deps.env);
    items.push(item("data-dir", "data dir", false, deps.isWritable(dataDir), `${dataDir}${deps.isWritable(dataDir) ? "" : " (not writable)"}`));
    const missing = items.filter((i) => i.status === "missing");
    const requiredMissing = missing.filter((i) => i.required).map((i) => i.id);
    return {
        schema: 1,
        version: deps.version,
        items,
        missing: missing.map((i) => i.id),
        requiredMissing,
        ok: requiredMissing.length === 0,
    };
}
export function renderDoctor(report) {
    const w = Math.max(...report.items.map((i) => i.label.length));
    const lines = [`odd-claude doctor (v${report.version})`, ""];
    for (const i of report.items) {
        lines.push(`${i.label.padEnd(w)}  ${i.required ? "required" : "optional"}  ${i.status.padEnd(7)}  ${i.detail}`);
    }
    lines.push("", `missing: ${report.missing.length === 0 ? "none" : report.missing.join(", ")}`);
    return lines.join("\n");
}
