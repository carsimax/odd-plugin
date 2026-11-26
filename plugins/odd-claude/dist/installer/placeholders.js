export function resolvePlaceholders(text, values) {
    return text.replaceAll("${CLAUDE_PLUGIN_ROOT}", () => values.root).replaceAll("${CLAUDE_PLUGIN_DATA}", () => values.data);
}
