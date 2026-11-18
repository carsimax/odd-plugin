// Read-only diagnostics (R38 doctor semantics): probe tools and report ok/missing.
// Pure: every side effect (exec, env, filesystem) is injected so tests use fakes.
// Upstream treats Engram as a warning, not a failure; here node and git are required,
// engram, codegraph, plugin and data-dir are optional.

export interface DoctorDeps {
  /** Runs `cmd args`; returns trimmed stdout, or undefined when missing/failing. */
  exec: (cmd: string, args: string[]) => string | undefined;
  env: Record<string, string | undefined>;
  /** e.g. "v22.1.0" (process.version). */
  nodeVersion: string;
  pluginVersion: string;
  /** Installed plugin keys (`name@marketplace`); undefined when unknown. */
  installedPlugins: () => string[] | undefined;
  isWritable: (dir: string) => boolean;
}

export interface DoctorItem {
  id: string;
  label: string;
  required: boolean;
  status: "ok" | "missing";
  detail: string;
}

export interface DoctorReport {
  schema: 1;
  pluginVersion: string;
  items: DoctorItem[];
  missing: string[];
  requiredMissing: string[];
  ok: boolean;
}

export const MIN_NODE_MAJOR = 20;

export function parseVersion(text: string): string | undefined {
  return /\d+\.\d+\.\d+/.exec(text)?.[0];
}

export function nodeSatisfies(version: string): boolean {
  const major = Number(/^v?(\d+)\./.exec(version)?.[1]);
  return Number.isInteger(major) && major >= MIN_NODE_MAJOR;
}

function item(id: string, label: string, required: boolean, ok: boolean, detail: string): DoctorItem {
  return { id, label, required, status: ok ? "ok" : "missing", detail };
}

function probeBinary(deps: DoctorDeps, cmd: string, args: string[]): string | undefined {
  const out = deps.exec(cmd, args);
  return out === undefined ? undefined : (parseVersion(out) ?? "unknown version");
}

export function collectDoctor(deps: DoctorDeps): DoctorReport {
  const items: DoctorItem[] = [];
  items.push(
    item("node", "node", true, nodeSatisfies(deps.nodeVersion), `${deps.nodeVersion} (need >=${MIN_NODE_MAJOR})`),
  );
  const git = probeBinary(deps, "git", ["--version"]);
  items.push(item("git", "git", true, git !== undefined, git ?? "not found on PATH"));

  const engramBin = probeBinary(deps, "engram", ["version"]);
  const plugins = deps.installedPlugins();
  const engramPlugin = plugins?.find((p) => p === "engram" || p.startsWith("engram@"));
  const engramParts = [
    engramBin !== undefined ? `binary ${engramBin}` : undefined,
    engramPlugin !== undefined ? `plugin ${engramPlugin}` : undefined,
  ].filter((p) => p !== undefined);
  items.push(
    item("engram", "engram", false, engramParts.length > 0, engramParts.join(", ") || "no binary on PATH and no engram plugin installed"),
  );

  const cg = probeBinary(deps, "codegraph", ["--version"]);
  items.push(item("codegraph", "codegraph", false, cg !== undefined, cg !== undefined ? `${cg} (plugin MCP server codegraph: serve --mcp)` : "not found on PATH (optional: the plugin codegraph MCP server stays disconnected; install @colbymchenry/codegraph to enable it)"));

  items.push(item("plugin", "odd-claude plugin", false, true, `version ${deps.pluginVersion}`));

  const dataDir = deps.env.CLAUDE_PLUGIN_DATA;
  if (!dataDir) items.push(item("data-dir", "data dir", false, false, "CLAUDE_PLUGIN_DATA not set"));
  else items.push(item("data-dir", "data dir", false, deps.isWritable(dataDir), `${dataDir}${deps.isWritable(dataDir) ? "" : " (not writable)"}`));

  const missing = items.filter((i) => i.status === "missing");
  const requiredMissing = missing.filter((i) => i.required).map((i) => i.id);
  return {
    schema: 1,
    pluginVersion: deps.pluginVersion,
    items,
    missing: missing.map((i) => i.id),
    requiredMissing,
    ok: requiredMissing.length === 0,
  };
}

export function renderDoctor(report: DoctorReport): string {
  const w = Math.max(...report.items.map((i) => i.label.length));
  const lines = [`odd-claude doctor (v${report.pluginVersion})`, ""];
  for (const i of report.items) {
    lines.push(`${i.label.padEnd(w)}  ${i.required ? "required" : "optional"}  ${i.status.padEnd(7)}  ${i.detail}`);
  }
  lines.push("", `missing: ${report.missing.length === 0 ? "none" : report.missing.join(", ")}`);
  return lines.join("\n");
}
