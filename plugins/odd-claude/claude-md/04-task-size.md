## Task Size

A task is **small** when all three hold:

1. **Understood**: the outcome is specified, what and where to change is known, and no product or design decision is open; prove it within one bounded read batch (at most 3 calls, approximately 10k tokens).
2. **Contained risk**: it touches no high-risk item below.
3. **Resumable from the diff**: resume test: if the session stopped now, someone could finish the work from the original request and `git diff` alone.

The number of files, commands or tests, fixes, or a requested todo list never decides size. A task is **large** only when the resume test fails: several sessions, waiting on something external, separate deliverables the user wants apart (never several features asked at once), or requirements too long to survive compaction. A large task gets tracking; it gets a writer only by the Writer trigger, otherwise the parent works inline.

Small path: work inline. Read and edit, several files of one understood change included; observe RED inline before the fix; run the focused test and the suite inline, once each. No explorer, worker or verifier; no feature document, mirror, or commits unless the user asks; a todo list is optional.

**High risk**: a mistake would be hard to detect, hard to undo, or reaches beyond the change. It touches (1) data or irreversible effects that cannot be rebuilt: migrations, changing or deleting existing stored data, persisted format changes (not saving new records, nor a dev or test database a seed or backup rebuilds); (2) security: auth, permissions, credentials, secrets, guards, sandbox; (3) contracts others consume: changing or removing public API, CLI flags, config formats, published exports, or mirrored prompts or contracts others already consume (not adding a flag, command, or optional field; requested changes are not high risk by themselves; unrequested breaks in shared code are); (4) concurrency: locks, races, async ordering; (5) delivery or environment: installers, release, CI, deploy, dependencies; (6) no test would catch a regression in what changes. Count "unclear" as high only when a bounded look cannot tell whether (1)-(5) apply. Only a named high-risk item adds an independent verifier.

**Risk line**: close every code change, small path or delegated, with `Risk: item N (reason)` or `Risk: none` per the list; any item fires the Verification trigger. Before writing `Risk: none`, check whether the diff changes code that existing behavior the request did not mention also uses (shared options, parsers, helpers); if it does, that is item 3.

After explicit change intent is established, route work for the requested outcome with the smallest useful topology. Every authorized change takes exactly one implementation route:

- **Direct inline:** small tasks, and large tasks without a Writer trigger reason, which follow their logbook. Decide or verify with one parallel batch, at most 3 calls and approximately 10k tokens of evidence. Use bounded search and line ranges, not whole large files. One understood change stays inline even when it spans files, and its focused test and suite run inline.
- **Delegated direct:** understanding that needs more evidence or more than approximately 5 sequential lookups takes read-only explorers, then task size is re-evaluated; a writer is delegated only by the Writer trigger.
- File count, changed lines, size, or perceived risk alone never forces a heavier route.
- These are implementation routes, not a ban on per-action delegation: long suites, builds and installs of a large task may use fresh workers without changing the selected route.
