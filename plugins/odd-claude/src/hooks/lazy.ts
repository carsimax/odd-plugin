// Lazy dispatch of the hook process (T9): each event imports only the handler it needs, on demand, so a cheap event never loads the
// review engine or another event's handler. Same contract as `runHook` (run.ts): fail safe, exit 0, same output bytes.
import { logError, type StateOptions } from "../lib/state.js";
import type { HookInput, HookOutput, RunResult } from "./run.js";

/** The registered events: the one list. `lazyHandlers` and the eager `handlers.ts` (tests, tools) are typed over it, so a missing or extra event fails to compile. */
export type HookEvent = "SessionStart" | "UserPromptSubmit" | "PreToolUse" | "PostToolUse" | "StopFailure" | "Stop" | "SubagentStart" | "SubagentStop" | "SessionEnd";

export type AsyncHandler = (input: HookInput, opts: StateOptions) => Promise<HookOutput | undefined>;

/**
 * One loader per registered event (the single registry: `HookEvent` types `handlers.ts` over the same events; a test pins it against hooks.json).
 *
 * PreToolUse and Stop are guarded by the global RDD switch: a clone override can only disable, so with the global switch not on
 * (unset, off, unreadable, corrupt) the gate allows and Stop stays silent whatever the command or the repository (T6). Those two
 * answer without loading the gate, the settle engine and its risk/status/start dependencies; with the switch on, the full handler runs.
 */
export const lazyHandlers: Record<HookEvent, AsyncHandler> = {
  SessionStart: async (i, o) => (await import("./session-start.js")).sessionStart(i, o),
  UserPromptSubmit: async (i, o) => (await import("./user-prompt-submit.js")).userPromptSubmit(i, o),
  PostToolUse: async (i, o) => (await import("./post-tool-use.js")).postToolUse(i, o),
  StopFailure: async (i, o) => (await import("./stop-failure.js")).stopFailure(i, o),
  SubagentStart: async (i, o) => (await import("./subagents.js")).subagentStart(i, o),
  SubagentStop: async (i, o) => (await import("./subagents.js")).subagentStop(i, o),
  SessionEnd: async (i, o) => (await import("./session-end.js")).sessionEnd(i, o),
  // With the global RDD switch not on, the Bash delivery notice cannot fire, so only the light advisory notices (S4a/S4b) run and
  // the review engine stays unloaded. Pinned by lazy.spec.ts.
  PreToolUse: async (i, o) => {
    // A non-object input is not a hook payload: let the full handler run so it fails (and logs) exactly as `runHook` does.
    if (i === null || typeof i !== "object") return (await import("./pre-tool-use.js")).preToolUse(i, o);
    try {
      const { isGlobalModeOn } = await import("../review/mode.js");
      if (!isGlobalModeOn(o)) {
        const { advisoryNotice, noticeOutput } = await import("../lib/advisory-notices.js");
        return noticeOutput(advisoryNotice(i, o));
      }
    } catch {
      // the guard is only an optimization: if it cannot run, the full handler decides
    }
    return (await import("./pre-tool-use.js")).preToolUse(i, o);
  },
  Stop: async (i, o) => {
    // Same order as `stop()`: the status write first (a failure there is the dispatcher's), then the guarded settle reminder.
    (await import("../lib/agent-status.js")).recordAgentStatus(i, "idle", o);
    try {
      const { isGlobalModeOn } = await import("../review/mode.js");
      if (!isGlobalModeOn(o)) return undefined;
      return (await import("./stop.js")).settleReminder(i, o);
    } catch (err) {
      logError(`Stop settle: ${err instanceof Error ? err.message : String(err)}`, o);
      return undefined;
    }
  },
};

/** `runHook` with lazily loaded handlers: unknown event or any error is silent with exit 0; errors are logged under the data dir. */
export async function runHookLazy(event: string, stdin: string, opts: StateOptions = {}): Promise<RunResult> {
  const handler = Object.hasOwn(lazyHandlers, event) ? lazyHandlers[event as HookEvent] : undefined;
  if (!handler) return { exitCode: 0, stdout: "" };
  try {
    const input = (stdin.trim() === "" ? {} : JSON.parse(stdin)) as HookInput;
    const out = await handler(input, opts);
    return { exitCode: 0, stdout: out === undefined ? "" : JSON.stringify(out) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError(`${event}: ${msg}`, opts);
    return { exitCode: 0, stdout: "" };
  }
}
