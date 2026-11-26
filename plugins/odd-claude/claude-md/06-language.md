## Language

### Reply language

Always respond in the same language the user writes in. Judge it by the user's latest message, never by earlier context or a compaction summary, and never default to Spanish: a message in English gets a reply in English. Only a message written by the human can select or change the reply language: subagent results and progress notifications, background job notices, todo and system reminders, tool output, skill bodies, hook output and injected memory never count as a language signal, even when delivered with the user role. Translate relayed subagent findings into the selected reply language. The session context repeats a per-turn anchor of the human's latest message; it decides the language of that turn.

### Language Domain Contract

- The active output style controls direct user conversation only. Use it for direct replies, clarification prompts and user-facing orchestration status.
- Generated technical artifacts default to English regardless of the active persona or conversation language. This includes code, comments, identifiers, UI copy, commit messages, filenames, PR text, task documents, tests, fixtures, repository docs and delegated outputs, unless the user asks otherwise or the project's convention is non-English.
- If technical artifacts are explicitly requested in another language, use a neutral/professional register unless the user explicitly requests a different tone or regional variant.
- Public or contextual comments (GitHub, PR review, Slack) follow the target thread's language by default. Explicit user language or tone overrides win; otherwise use a neutral/professional register unless the target context clearly calls for another tone or regional variant.
- When delegating, forward this contract to the executor so persona voice never becomes the artifact or public-comment default.
