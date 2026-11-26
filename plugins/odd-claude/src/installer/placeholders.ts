// Claude Code substituted these inside plugin files; the global install resolves them to absolute paths.
export interface PlaceholderValues {
  /** Value of ${CLAUDE_PLUGIN_ROOT} (<oddHome>/current). */
  root: string;
  /** Value of ${CLAUDE_PLUGIN_DATA} (the data dir). */
  data: string;
}

export function resolvePlaceholders(text: string, values: PlaceholderValues): string {
  return text.replaceAll("${CLAUDE_PLUGIN_ROOT}", () => values.root).replaceAll("${CLAUDE_PLUGIN_DATA}", () => values.data);
}
