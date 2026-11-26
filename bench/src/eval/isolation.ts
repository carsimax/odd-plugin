// Per-run isolation of Claude Code state. See docs/eval/README.md ("Isolation") for the mechanism and what is unproven.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type Arm = "none" | "coord-on" | "coord-off" | "skills";
export const ARMS: readonly Arm[] = ["none", "coord-on", "coord-off", "skills"];
/** Arms run when `--arms` is not given (the plugin eval); `skills` is opt-in. */
export const DEFAULT_ARMS: readonly Arm[] = ["none", "coord-on", "coord-off"];
export const ARM_MODE: Record<Arm, "full" | "organic" | null> = { none: null, "coord-on": "full", "coord-off": "organic", skills: null };
/** Arms that run odd-claude installed by the real installer into the run's private config dir (the layout that is distributed). */
export const isInstalledArm = (arm: Arm): boolean => arm === "coord-on" || arm === "coord-off";

/** Id the legacy `--plugin-dir` arm loaded odd-claude under; no arm may show it any more (the plugin distribution was removed). */
export const LEGACY_PLUGIN_ID = "odd-claude@inline";

export interface RunDirs { root: string; home: string; config: string; /** ODD_CLAUDE_HOME of the installed arms. */ oddHome: string; /** `<oddHome>/data`: where the runtime keeps `delegation.json`. */ dataDir: string }

/** Layout of one run's private directories; everything lives under `root`. */
export function runDirs(root: string): RunDirs {
  const oddHome = join(root, "odd-claude");
  return { root, home: join(root, "home"), config: join(root, "claude-config"), oddHome, dataDir: join(oddHome, "data") };
}

/** Variables that carry credentials or provider routing; the only parent variables a run inherits besides PATH, TMPDIR and proxy/CA settings. */
const INHERIT = /^(ANTHROPIC_|CLAUDE_CODE_OAUTH_TOKEN$|CLAUDE_CODE_USE_|AWS_|GOOGLE_|GCLOUD_|CLOUD_ML_|VERTEX_|HTTPS?_PROXY$|NO_PROXY$|ALL_PROXY$|SSL_CERT_|NODE_EXTRA_CA_CERTS$|https?_proxy$|no_proxy$)/;
const NEVER = /^(CLAUDE_CONFIG_DIR|CLAUDE_PLUGIN_|CLAUDE_CODE_PLUGIN_|CLAUDE_CODE_SIMPLE$|ANTHROPIC_CONFIG_DIR)/;

/** True when the parent environment carries a credential that works with a fresh CLAUDE_CONFIG_DIR (the user's stored login does not). */
export function hasAuthEnv(base: NodeJS.ProcessEnv): boolean {
  return Boolean(base.ANTHROPIC_API_KEY || base.ANTHROPIC_AUTH_TOKEN || base.CLAUDE_CODE_OAUTH_TOKEN || base.CLAUDE_CODE_USE_BEDROCK || base.CLAUDE_CODE_USE_VERTEX || base.CLAUDE_CODE_USE_FOUNDRY);
}

/** Environment built from scratch: private HOME/config/XDG/ODD_CLAUDE_HOME, no inherited CLAUDE_* location variables, fixed git identity. */
export function buildRunEnv(base: NodeJS.ProcessEnv, dirs: RunDirs, arm: Arm): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: base.PATH ?? "/usr/bin:/bin", TMPDIR: base.TMPDIR, LANG: "C",
    HOME: dirs.home, CLAUDE_CONFIG_DIR: dirs.config,
    XDG_CONFIG_HOME: join(dirs.root, "xdg", "config"), XDG_DATA_HOME: join(dirs.root, "xdg", "data"), XDG_CACHE_HOME: join(dirs.root, "xdg", "cache"), XDG_STATE_HOME: join(dirs.root, "xdg", "state"),
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(dirs.home, ".gitconfig"),
    GIT_AUTHOR_NAME: "odd-eval", GIT_AUTHOR_EMAIL: "eval@example.invalid", GIT_COMMITTER_NAME: "odd-eval", GIT_COMMITTER_EMAIL: "eval@example.invalid",
  };
  for (const [k, v] of Object.entries(base)) if (v !== undefined && INHERIT.test(k) && !NEVER.test(k)) env[k] = v;
  // The installed runtime (hooks, MCP servers) resolves its data dir from ODD_CLAUDE_HOME; the installer reads it too.
  if (isInstalledArm(arm)) env.ODD_CLAUDE_HOME = dirs.oddHome;
  return env;
}

/** Creates the run's private dirs and, for a coordinator arm, writes the `delegation` state in the runtime state format
 *  (plugins/odd-claude/src/lib/state.ts writePluginState: `<ODD_CLAUDE_HOME>/data/delegation.json` = {version:1, sessionId:"delegation", data:{mode}}). */
export function prepareIsolation(dirs: RunDirs, arm: Arm): void {
  for (const d of [dirs.home, dirs.config, join(dirs.root, "xdg", "config"), join(dirs.root, "xdg", "data"), join(dirs.root, "xdg", "cache"), join(dirs.root, "xdg", "state")]) mkdirSync(d, { recursive: true });
  const mode = ARM_MODE[arm];
  if (mode === null) return;
  mkdirSync(dirs.dataDir, { recursive: true });
  writeFileSync(join(dirs.dataDir, "delegation.json"), JSON.stringify({ version: 1, sessionId: "delegation", data: { mode } }, null, 2) + "\n");
}
