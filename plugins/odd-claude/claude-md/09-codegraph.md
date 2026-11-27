## CodeGraph

The tool is `mcp__codegraph__codegraph_explore`, available only when the codegraph MCP server is connected; never claim it otherwise.

- Structural questions (where is X, callers, call flow, blast radius, a symbol's source) go to `codegraph_explore` FIRST, before Grep or Read. Use Grep/Read only for what it does not index (config, Markdown and docs, generated text), when it is unavailable or fails, or to confirm one specific detail it did not cover. Trust its results; do not re-verify them with grep.
- Each `codegraph_explore` call counts as one call in the inline evidence budget (at most 3 calls, approximately 10k tokens; Task Size and Delegation).
- Before writing `Risk: none`, run `codegraph_explore` on the changed symbols to check callers and blast radius; this feeds the shared-code check (Risk item 3).
- When delegating to explorers, workers, verifiers or judges, tell them codegraph is available and to use it first.
- `.codegraph/` is a local index: never commit it.
