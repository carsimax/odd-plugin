// External dependencies (Engram, codegraph): detect, plan and install behind an injected runner and a confirm callback.
// MCP registration is not done here; the existing applyMcp registers codegraph/engram servers.
import type { McpRunner, RunResult } from "./mcp.js";

export interface DepsDetected {
  engram: boolean;
  codegraph: boolean;
  brew: boolean;
  npm: boolean;
}
export interface DepStep {
  cmd: string;
  args: string[];
}
export interface DepAction {
  name: "engram" | "codegraph";
  status: "present" | "install" | "manual";
  steps: DepStep[];
  /** Set when status is `manual`. */
  instructions?: string;
}
export interface DepResult {
  name: DepAction["name"];
  status: "skipped" | "installed" | "declined" | "manual" | "failed";
  detail: string;
}

export const ENGRAM_URL = "https://github.com/Gentleman-Programming/engram";
const ENGRAM_BREW = "gentleman-programming/tap/engram";
const CODEGRAPH_PKG = "@colbymchenry/codegraph";

async function run(runner: McpRunner, cmd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<RunResult> {
  try {
    return await runner(cmd, args, { env });
  } catch (err) {
    return { code: null, stdout: "", stderr: (err as Error).message };
  }
}

const text = (r: RunResult): string => (r.stderr.trim() || r.stdout.trim() || `exit ${r.code}`).split("\n")[0]!;

export async function detectDeps(runner: McpRunner, env?: NodeJS.ProcessEnv): Promise<DepsDetected> {
  const has = async (cmd: string, arg: string): Promise<boolean> => (await run(runner, cmd, [arg], env)).code === 0;
  return {
    engram: await has("engram", "version"),
    codegraph: await has("codegraph", "--version"),
    brew: await has("brew", "--version"),
    npm: await has("npm", "--version"),
  };
}

export function planDeps(d: DepsDetected): DepAction[] {
  const engram: DepAction = d.engram
    ? { name: "engram", status: "present", steps: [] }
    : d.brew
      ? {
          name: "engram",
          status: "install",
          steps: [
            { cmd: "brew", args: ["install", ENGRAM_BREW] },
            { cmd: "engram", args: ["setup", "claude-code"] },
          ],
        }
      : { name: "engram", status: "manual", steps: [], instructions: `Homebrew was not found. Install Engram manually (${ENGRAM_URL}), then run \`engram setup claude-code\`.` };
  const codegraph: DepAction = d.codegraph
    ? { name: "codegraph", status: "present", steps: [] }
    : d.npm
      ? { name: "codegraph", status: "install", steps: [{ cmd: "npm", args: ["install", "-g", CODEGRAPH_PKG] }] }
      : { name: "codegraph", status: "manual", steps: [], instructions: `npm was not found. Install codegraph manually with \`npm install -g ${CODEGRAPH_PKG}\`.` };
  return [engram, codegraph];
}

/** Runs the plan. Nothing is installed unless `confirm` returns true; failures are reported per dependency, never thrown. */
export async function installDeps(runner: McpRunner, opts: { confirm: (action: DepAction) => boolean | Promise<boolean>; env?: NodeJS.ProcessEnv }): Promise<DepResult[]> {
  const results: DepResult[] = [];
  for (const action of planDeps(await detectDeps(runner, opts.env))) {
    if (action.status === "present") {
      results.push({ name: action.name, status: "skipped", detail: "already installed" });
      continue;
    }
    if (action.status === "manual") {
      results.push({ name: action.name, status: "manual", detail: action.instructions ?? "" });
      continue;
    }
    let approved = false;
    try {
      approved = (await opts.confirm(action)) === true;
    } catch {
      approved = false;
    }
    if (!approved) {
      results.push({ name: action.name, status: "declined", detail: "not confirmed, nothing installed" });
      continue;
    }
    let failure: string | null = null;
    for (const step of action.steps) {
      const r = await run(runner, step.cmd, step.args, opts.env);
      if (r.code !== 0) {
        failure = `${[step.cmd, ...step.args].join(" ")}: ${text(r)}`;
        break;
      }
    }
    results.push(failure ? { name: action.name, status: "failed", detail: failure } : { name: action.name, status: "installed", detail: action.steps.map((s) => [s.cmd, ...s.args].join(" ")).join("; ") });
  }
  return results;
}
