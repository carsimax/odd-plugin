// The eager handler registry: every handler statically imported. Only tests and tools that need the sync `defaultHandlers` load this
// module (run.ts does so when it is imported rather than run); the hook process itself dispatches through `lazy.ts`.
import { postToolUse } from "./post-tool-use.js";
import { preToolUse } from "./pre-tool-use.js";
import { sessionEnd } from "./session-end.js";
import { sessionStart } from "./session-start.js";
import { stop } from "./stop.js";
import { stopFailure } from "./stop-failure.js";
import { subagentStart, subagentStop } from "./subagents.js";
import { userPromptSubmit } from "./user-prompt-submit.js";
/** Eager twin of `lazyHandlers` (lazy.ts is the registry: `HookEvent` keeps both on the same events). */
export const handlers = {
    SessionStart: sessionStart,
    UserPromptSubmit: userPromptSubmit,
    PreToolUse: preToolUse,
    PostToolUse: postToolUse,
    StopFailure: stopFailure,
    Stop: stop,
    SubagentStart: subagentStart,
    SubagentStop: subagentStop,
    SessionEnd: sessionEnd,
};
