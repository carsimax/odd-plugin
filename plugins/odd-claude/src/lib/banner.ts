// R45 startup banner. A short text banner (port of the upstream startup banner, minus its logo art and colours) shown to
// the user as the SessionStart `systemMessage`, so it never enters the model context. Opt out with ODD_CLAUDE_NO_BANNER=1
// or `/odd-claude:banner off` (plugin state `banner`). No data leaves the machine.
import { readPluginState, writePluginState, type StateOptions } from "./state.js";

/** True when ODD_CLAUDE_NO_BANNER is set to something other than empty/0/false. */
function envOptOut(env: Record<string, string | undefined>): boolean {
  const v = (env.ODD_CLAUDE_NO_BANNER ?? "").trim().toLowerCase();
  return v !== "" && v !== "0" && v !== "false";
}

export function bannerEnvOptOut(opts: StateOptions = {}): boolean {
  return envOptOut(opts.env ?? process.env);
}

export function bannerEnabled(opts: StateOptions = {}): boolean {
  if (envOptOut(opts.env ?? process.env)) return false;
  try {
    return readPluginState("banner", opts).enabled !== false;
  } catch {
    return true;
  }
}

export function setBannerEnabled(enabled: boolean, opts: StateOptions = {}): void {
  writePluginState("banner", { enabled }, opts);
}

export function bannerText(version: string): string {
  return [`▌ odd-claude v${version} · ODD harness for Claude Code`, "  /odd-claude:changes · /odd-claude:agents · /odd-claude:banner off to hide this"].join("\n");
}
