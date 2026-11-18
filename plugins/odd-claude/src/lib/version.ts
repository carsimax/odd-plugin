import { readFileSync } from "node:fs";

/** Plugin version, read from `.claude-plugin/plugin.json` (single source of truth). */
export function pluginVersion(): string {
  const manifest = JSON.parse(
    readFileSync(new URL("../../.claude-plugin/plugin.json", import.meta.url), "utf8"),
  ) as { version?: unknown };
  if (typeof manifest.version !== "string") {
    throw new Error("plugin.json has no string `version`");
  }
  return manifest.version;
}
