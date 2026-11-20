// The one trivial journey of T1: proves sandbox + counting shims + fresh MCP processes + metrics + projection against odd's real
// review server, with the fake `claude` on PATH (no model). Real journeys arrive in T2.
import type { Journey } from "../journey.js";

export const exampleStatusJourney: Journey = {
  id: "example-status-clean-repo",
  description: "Agent lists the review tools, then asks review_status on a clean repo: nothing to review, so the action is stop.",
  expected: { review_tools_listed: true, operation: "review.status", action: "stop" },
  steps: [
    {
      name: "list review tools",
      actor: "agent",
      async run(env) {
        const tools = await env.mcpTools();
        return { ok: tools.includes("review_status"), observed: { review_tools_listed: tools.includes("review_status") } };
      },
    },
    {
      name: "review_status",
      actor: "agent",
      async run(env) {
        const r = await env.mcpCall("review_status");
        const j = (r.json ?? {}) as { operation?: unknown; action?: unknown };
        return { ok: !r.isError, observed: { operation: j.operation, action: j.action } };
      },
    },
  ],
};
