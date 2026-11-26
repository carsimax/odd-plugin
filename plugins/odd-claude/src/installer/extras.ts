// Optional settings.json extras: status line, claude.ai sync switches, builtin plugin disabling.
// Everything goes through applyManagedSettings / restoreManagedSettings, so previous values are recorded and
// uninstall restores exactly these paths (absent keys are removed again).
//
// CLI flags (wired by the TUI task):
//   --no-statusline                 -> statusLine: false
//   --keep-claude-ai-connectors     -> claudeAi.connectors: false
//   --keep-claude-ai-skills         -> claudeAi.skills: false
//   --keep-claude-ai-plugins        -> claudeAi.plugins: false
//   --keep-builtin-plugins          -> builtin: { mode: "keep" }
//   --disable-builtin <id> (repeat) -> builtin: { mode: "subset", ids }
import { applyManagedSettings, readOddState, restoreManagedSettings, type ApplyManagedResult, type ManagedPaths, type RestoreManagedResult, type SettingsChange } from "./managed-settings.js";
import { builtinPluginChanges, discoverBuiltinPlugins, type BuiltinSelection, type DiscoverResult } from "./builtin-plugins.js";
import { CLAUDE_AI_DEFAULTS, claudeAiChanges, type ClaudeAiOptions } from "./claude-ai.js";
import type { McpRunner } from "./mcp.js";
import { statusLineChanges, STATUSLINE_PATH } from "./statusline.js";

export interface ExtrasOptions {
  statusLine: boolean;
  claudeAi: ClaudeAiOptions;
  builtin: BuiltinSelection;
}

export const DEFAULT_EXTRAS: ExtrasOptions = { statusLine: true, claudeAi: { ...CLAUDE_AI_DEFAULTS }, builtin: { mode: "all" } };

interface PlanInput {
  oddRoot: string;
  options: ExtrasOptions;
  runner?: McpRunner;
  env?: NodeJS.ProcessEnv;
}
export interface ExtrasPlan {
  changes: SettingsChange[];
  warnings: string[];
  /** Discovery result; undefined when the builtin step is "keep" (discovery is not run). */
  builtin?: DiscoverResult;
}
export interface ExtrasApplyResult extends ExtrasPlan {
  settings?: ApplyManagedResult;
}

export async function planExtras(input: PlanInput): Promise<ExtrasPlan> {
  const { options } = input;
  const changes: SettingsChange[] = [];
  const warnings: string[] = [];
  if (options.statusLine) changes.push(...statusLineChanges(input.oddRoot));
  changes.push(...claudeAiChanges(options.claudeAi));
  let builtin: DiscoverResult | undefined;
  if (options.builtin.mode !== "keep") {
    builtin = await discoverBuiltinPlugins(input.runner, input.env);
    if (!builtin.ok) warnings.push(`builtin plugins skipped: ${builtin.error}`);
    else {
      const b = builtinPluginChanges(builtin.plugins, options.builtin);
      changes.push(...b.changes);
      if (b.unknown.length > 0) warnings.push(`unknown builtin plugin ids ignored: ${b.unknown.join(", ")}`);
      if (b.protectedSkipped.length > 0) warnings.push(`protected builtin plugin ids left untouched: ${b.protectedSkipped.join(", ")}`);
    }
  }
  return { changes, warnings, builtin };
}

export async function applyExtras(input: PlanInput & { paths: ManagedPaths }): Promise<ExtrasApplyResult> {
  const plan = await planExtras(input);
  if (plan.changes.length === 0) return plan;
  return { ...plan, settings: applyManagedSettings(input.paths, plan.changes) };
}

const OWNED_ROOTS = new Set([STATUSLINE_PATH[0], "disableClaudeAiConnectors", "syncClaudeAiSkills", "syncClaudeAiPlugins", "enabledPlugins"]);

/** Restores every path owned by the extras (never outputStyle or hook paths). */
export function removeExtras(input: { paths: ManagedPaths }): RestoreManagedResult {
  const owned = Object.values(readOddState(input.paths.statePath).settings ?? {})
    .map((o) => o.path)
    .filter((p) => OWNED_ROOTS.has(p[0]));
  return restoreManagedSettings(input.paths, owned);
}
