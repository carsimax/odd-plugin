// SessionStart integrations: skill-registry refresh (R53) and codegraph warm-up launch (R13).
// Each step is bounded, fail-safe and logged; nothing here may break or slow session start.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isBroadDirectory, planWarmup, realHasIndex } from "./codegraph.js";
import { realGitTracked, realPluginRoots, refreshRegistry, type PluginRoot, type RefreshDeps } from "./skill-registry.js";

export interface IntegrationDeps {
  home: string;
  env: Record<string, string | undefined>;
  plugins: PluginRoot[];
  gitTracked: RefreshDeps["gitTracked"];
  hasIndex: (cwd: string) => boolean;
  isBroadDir: (cwd: string) => boolean;
  /** Starts the warm-up detached from the hook; must return immediately. */
  launchWarmup: (cwd: string) => void;
  log: (message: string) => void;
}

export function runSessionIntegrations(cwd: string, deps: IntegrationDeps): { extraLines: string[] } {
  const extraLines: string[] = [];
  try {
    const r = refreshRegistry({ cwd, home: deps.home, plugins: deps.plugins, env: deps.env, gitTracked: deps.gitTracked });
    if (r.status === "skipped") {
      if (r.warning) deps.log(`skill registry skipped (${r.reason}): ${r.warning}`);
    } else {
      const noun = `${r.skillCount} skill${r.skillCount === 1 ? "" : "s"}`;
      extraLines.push(
        `Skill registry: ${r.registryPath} (${noun}) indexes project, user and plugin skills by trigger and path; read it when delegating and pass exact SKILL.md paths to subagents.`,
      );
    }
  } catch (err) {
    deps.log(`skill registry refresh failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    const plan = planWarmup(cwd, deps);
    if (plan.action !== "skip") deps.launchWarmup(cwd);
  } catch (err) {
    deps.log(`codegraph warm-up launch failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { extraLines };
}

/** Real detached launch of dist/cli/codegraph-warm.js; the hook never waits for it. */
export function realLaunchWarmup(cwd: string, env: Record<string, string | undefined>): void {
  const script = fileURLToPath(new URL("../cli/codegraph-warm.js", import.meta.url));
  if (!existsSync(script)) throw new Error("codegraph-warm.js not found");
  const child = spawn(process.execPath, [script, cwd], { detached: true, stdio: "ignore", env: env as NodeJS.ProcessEnv });
  child.on("error", () => {});
  child.unref();
}

export function realIntegrationDeps(home: string, env: Record<string, string | undefined>, log: (m: string) => void): IntegrationDeps {
  return {
    home,
    env,
    plugins: realPluginRoots(env, home),
    gitTracked: realGitTracked,
    hasIndex: realHasIndex,
    isBroadDir: (cwd) => isBroadDirectory(cwd, home),
    launchWarmup: (cwd) => realLaunchWarmup(cwd, env),
    log,
  };
}
