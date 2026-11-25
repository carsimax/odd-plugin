# Memory (optional: only when Engram tools exist)

Use only when `mcp__engram__mem_*` tools are actually connected. Otherwise the feature document is the only durable copy; never claim persistence you did not get.

- The feature document is canonical. Mirror the full document and its locator under topic `odd/<feature-name>/tasks` with `mem_save` (project-scoped) once per task transition and at close; `## Log` entries between transitions reach the mirror at the next one. A mirror that differs from the file is refreshed from the file. If a save fails or is uncertain, check what applied before retrying; mark the mirror pending and keep working.
- Resume: `mem_context`, then feature-scoped `mem_search` and `mem_get_observation` for the full saved document; read the actual task file; reconcile requirements, code and proof before the next unfinished task. Never infer active work from the newest global memory.
- Workers save only validated, project-scoped conclusions and only when the parent supplies the project name; never secrets, personal data or raw untrusted content.
- Memories marked `needs_review` are stale context: surface and verify them against current evidence. Never mark them reviewed without explicit user confirmation.
