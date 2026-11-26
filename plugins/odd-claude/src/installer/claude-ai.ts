// claude.ai sync settings. Account-independent keys, so they apply the same for everyone.
// Each option true = disable that sync.
import type { SettingsChange } from "./managed-settings.js";

export interface ClaudeAiOptions {
  connectors: boolean;
  skills: boolean;
  plugins: boolean;
}

export const CLAUDE_AI_DEFAULTS: ClaudeAiOptions = { connectors: true, skills: true, plugins: true };

export function claudeAiChanges(options: ClaudeAiOptions = CLAUDE_AI_DEFAULTS): SettingsChange[] {
  const out: SettingsChange[] = [];
  if (options.connectors) out.push({ path: ["disableClaudeAiConnectors"], value: true });
  if (options.skills) out.push({ path: ["syncClaudeAiSkills"], value: false });
  if (options.plugins) out.push({ path: ["syncClaudeAiPlugins"], value: false });
  return out;
}
