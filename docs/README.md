# odd-claude docs

**odd-claude** ports [gentle-shell](../upstream/gentle-shell) (a Pi-harness distribution, cloned read-only and gitignored under `upstream/gentle-shell`) to Claude Code as a plugin. The upstream repo is the single source of truth for behaviour; these docs capture what Claude Code can host and what is still unknown, as the base for a roadmap.

## Decisions

1. Source is 100% `upstream/gentle-shell`; no other projects are used as input.
2. Naming: prefix `odd`, plugin namespace `odd-claude:`; never `gentle-` (see below).
3. No telemetry of any kind. Telemetry-related Claude Code APIs are documented only as capability facts.

## Naming convention

Everything odd-claude ships uses the `odd` prefix: plugin `odd-claude`, namespaced as `/odd-claude:<skill>`, agents `odd-claude:odd-<name>`, tools/env vars `odd_*` / `ODD_*`. No `gentle-` prefix is used for anything we name.

## Research

| Doc | Content |
|---|---|
| [research/gentle-shell-inventory.md](research/gentle-shell-inventory.md) | What upstream gentle-shell ships (written separately). |
| [research/portability-matrix.md](research/portability-matrix.md) | Upstream feature → Claude Code mechanism, with gaps (written separately). |
| [research/claude-code-extensibility.md](research/claude-code-extensibility.md) | What Claude Code v2.1.326 plugins can and cannot ship; hooks, subagents, skills, mods. |
| [research/open-questions.md](research/open-questions.md) | Spikes to run before the roadmap. |

## Roadmap

See [roadmap.md](roadmap.md): phase 0 gates (open questions), then eight phases (skeleton, core layer, guards, RDD, mods UX, web tools, cosmetic, deferred) mapped to releases v0.1 to v1.0+, with the out-of-scope list and per-phase status.
