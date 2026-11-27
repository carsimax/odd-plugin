# Spikes (throwaway)

Exploratory experiments for [docs/research/open-questions.md](../docs/research/open-questions.md). Run from `spikes/scratch/` (cwd for headless runs), always with `--plugin-dir` (session-only; nothing is installed). Results are in the Findings section there. Targeted Claude Code: 2.1.326. Logs (`debug*.log`, `hook-log.jsonl`) are the captured evidence.

| Spike | Question | Rerun |
|---|---|---|
| `01-hello-mod/` | Q1, Q7: mod with tool, `prompt.*` hooks, pane, `/odd-hello` | `claude plugin validate spikes/01-hello-mod`; `claude plugin test spikes/01-hello-mod`; `cd spikes/scratch && claude -p "/odd-hello" --plugin-dir ../01-hello-mod` |
| `02-output-style/` | Q2: `force-for-plugin` output style (marker `ODD-MARKER-42`) | `cd spikes/scratch && claude -p "Say hi in 3 words." --model haiku --plugin-dir ../02-output-style` |
| `03-subagent-hooks/` | Q3: PreToolUse hook + agent `odd-probe` with ignored frontmatter | `cd spikes/scratch && claude -p "Use the Agent tool with subagent_type odd-subhook:odd-probe to write hello into probe-out.txt" --model haiku --permission-mode bypassPermissions --plugin-dir ../03-subagent-hooks --debug-file ../03-subagent-hooks/debug.log`, then read `03-subagent-hooks/hook-log.jsonl` |
| `06-agent-mcp/` | Q6: plugin stdio MCP server + agent granting its tool; `extra/` = session-level `--mcp-config` variant | `cd spikes/scratch && claude -p "Use the Agent tool with subagent_type odd-mcp:odd-mcp-probe" --model haiku --permission-mode bypassPermissions --plugin-dir ../06-agent-mcp` |
| `tools/pty_drive.py` | Q1: attempt at an interactive run without tmux; stops at the trust dialog (never answers it) | `python3 spikes/tools/pty_drive.py $PWD 12 "" --plugin-dir spikes/01-hello-mod` |
| `py-02-mcp/` | S2: official Python MCP SDK vs hand-rolled (versions, cancellation, error codes, 4 MiB cap) | `cd /tmp && uv run --script <repo>/spikes/py-02-mcp/driver.py` |
| `py-03-textual/` | S3: Textual feasibility for the 5 install/models/update/uninstall/backups flows | `cd spikes/py-03-textual && PYTHONDONTWRITEBYTECODE=1 uv run --script test_install_flow.py` |
| `py-04-command-shape/` | S4: hook and MCP command shape in `settings.json` | `bash spikes/py-04-command-shape/run.sh` |
| `py-05-ram/` | S5: RAM budget on 16 GB (embedder and 7B curator) | `spikes/py-05-ram/measure.sh` (after `ollama pull nomic-embed-text` and `ollama pull qwen2.5:7b`) |
| `py-06-contract-harness/` | S6: language-neutral contract harness (`ODD_IMPL=ts\|py`) | `ODD_IMPL=ts node --test spikes/py-06-contract-harness/main.contract.spec.mjs` |
| `py-07-open-questions/` | S7: decisions for roadmap section 9 | none (docs; its README lists the reruns of py-02, py-04, py-05, py-06) |

`spikes/scratch/` is the throwaway cwd (holds `probe-out.txt` written by the Q3 agent).
