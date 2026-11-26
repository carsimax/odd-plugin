// Installer layout. Every function takes explicit inputs so tests run against temp dirs, never the real home.
import { join } from "node:path";
import { dataDirFromEnv } from "../lib/state.js";

export interface InstallPaths {
  claudeDir: string;
  oddHome: string;
  versionsDir: string;
  currentLink: string;
  dataDir: string;
  manifestPath: string;
  backupsDir: string;
}

type Env = Record<string, string | undefined>;

/** `claudeDir` = CLAUDE_CONFIG_DIR or <home>/.claude; `oddHome` = ODD_CLAUDE_HOME or <home>/.odd-claude. */
export function resolveInstallPaths(env: Env, homedir: string): InstallPaths {
  const claudeDir = env.CLAUDE_CONFIG_DIR || join(homedir, ".claude");
  const oddHome = env.ODD_CLAUDE_HOME || join(homedir, ".odd-claude");
  // The runtime resolver decides the data dir, so installer and hooks always agree.
  const dataDir = dataDirFromEnv({ ...env, ODD_CLAUDE_HOME: oddHome });
  return {
    claudeDir,
    oddHome,
    versionsDir: join(oddHome, "versions"),
    currentLink: join(oddHome, "current"),
    dataDir,
    manifestPath: join(oddHome, "manifest.json"),
    backupsDir: join(oddHome, "backups"),
  };
}
