# py-07: open questions (roadmap section 9)

Spec: `odd/tasks/py-phase0-spikes.md` T7, S7, S8. Docs only; no code. Exit criterion: "Every open question in section 9 has a decision or an explicit deferral." Decisions are the human's, recorded verbatim below and in the feature document `## Log` (L7).

## Result

| Question | Evidence | Recommendation | Human decision (verbatim) |
|---|---|---|---|
| CLI framework | No spike. Judged on the roadmap alone: the CLI is a thin set of subcommands (`odd-claude hook <Event>`, `mcp review`, `tasks`), and hooks run on every tool call, so startup and zero dependencies matter (py-04 measured about 65 ms per hook with a stdlib script). | stdlib `argparse` | "argparse (Recommended)" |
| MCP server | `spikes/py-02-mcp/README.md`: SDK `mcp` 2.3.0 differs from v9 on 4 of 8 points (no reply to a cancelled request, malformed JSON ignored instead of `-32700`, a line over 4 MiB accepted instead of `-32600`, unknown protocol version answered with `2025-11-25`); the 2.x rename `FastMCP` to `MCPServer` shows API churn. | hand-rolled (port of `server-core.ts`, small stdlib `asyncio` loop) | "A mano (Recommended)" |
| Packaging | `spikes/py-04-command-shape/README.md`: the chosen shape is the absolute venv interpreter under the `current` symlink (`"$ODD/current/venv/bin/python" ...`); with a stripped PATH the venv command exits 0 while `uv run` exits 127; the versioned dir plus `current` keeps the v9 install and rollback model. | wheel plus payload, installer creates the venv with uv and installs the wheel | "Wheel (Recommended)" (option text: "El release publica un wheel + payload; el instalador crea el venv con uv e instala el wheel. Rollback = cambiar el symlink current.") |
| Name of the new root | Skeleton from py-01 (commit `12ca3c8`): `pyproject.toml`, `src/odd_claude/`, `tests/` work with `uv run pytest` (1 passed). | keep `src/odd_claude/` | "src/odd_claude (Recommended)" (option text: "Se queda como está; plugins/odd-claude/ se retira en la Fase 8.") |
| bench | No spike. bench drives `dist/` entries black-box, but its eval imports `dist/installer/orchestrate.js` (roadmap section 4); py-06 (`spikes/py-06-contract-harness/README.md`) shows the `ODD_IMPL` switch works for process-boundary specs, so a later move stays possible. | stays TS | "Se queda en TS (Recommended)" (option text: "No bloquea la paridad; se revisa después de v10.0.0 si deja de ser útil.") |
| Memory store design | `spikes/py-05-ram/README.md`: embedder `nomic-embed-text` is cheap (about 0.3-0.5 GB); a 7B curator loaded at once added +1726 MB swap on 16 GB, so it fits only on demand. The RAM measurement is an input, not a design. | defer to Phase 9 | "Diferir a Fase 9 (Recommended)" (option text: "Paridad primero: no hace falta para v10; la medición de RAM queda como insumo.") |

Roadmap edits: section 9 shows each decision (memory store: "Deferred to Phase 9"); section 5 Stack rows for CLI framework and MCP server are Decided (Phase 0).

## Rerun

This spike is documentation; it has no command of its own. The evidence it relies on reruns as follows (copied from each README).

py-02 (MCP):

```sh
cd /tmp && uv run --script <repo>/spikes/py-02-mcp/driver.py
```

py-04 (command shape):

```
bash spikes/py-04-command-shape/run.sh
```

py-05 (RAM):

```sh
ollama pull nomic-embed-text
ollama pull qwen2.5:7b
spikes/py-05-ram/measure.sh
```

py-06 (contract harness):

```sh
ODD_IMPL=ts node --test spikes/py-06-contract-harness/main.contract.spec.mjs   # expect exit 0, 4 pass
ODD_IMPL=py node --test spikes/py-06-contract-harness/main.contract.spec.mjs   # expect exit 1, 3 fail (placeholder)
```

py-01 skeleton: `uv run pytest` at the repository root (1 passed).
