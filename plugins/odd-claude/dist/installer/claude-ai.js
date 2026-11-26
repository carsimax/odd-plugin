export const CLAUDE_AI_DEFAULTS = { connectors: true, skills: true, plugins: true };
export function claudeAiChanges(options = CLAUDE_AI_DEFAULTS) {
    const out = [];
    if (options.connectors)
        out.push({ path: ["disableClaudeAiConnectors"], value: true });
    if (options.skills)
        out.push({ path: ["syncClaudeAiSkills"], value: false });
    if (options.plugins)
        out.push({ path: ["syncClaudeAiPlugins"], value: false });
    return out;
}
