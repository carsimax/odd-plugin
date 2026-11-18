# Spikes (throwaway)

Exploratory experiments for [docs/research/open-questions.md](../docs/research/open-questions.md). Run from `spikes/scratch/` (cwd for headless runs), always with `--plugin-dir` (session-only; nothing is installed). Results are in the Findings section there. Targeted Claude Code: 2.1.326. Logs (`debug*.log`, `hook-log.jsonl`) are the captured evidence.

| Spike | Question | Rerun |
|---|---|---|
| `01-hello-mod/` | Q1, Q7: mod with tool, `prompt.*` hooks, pane, `/odd-hello` | `claude plugin validate spikes/01-hello-mod`; `claude plugin test spikes/01-hello-mod`; `cd spikes/scratch && claude -p "/odd-hello" --plugin-dir ../01-hello-mod` |
| `02-output-style/` | Q2: `force-for-plugin` output style (marker `ODD-MARKER-42`) | `cd spikes/scratch && claude -p "Say hi in 3 words." --model haiku --plugin-dir ../02-output-style` |
| `03-subagent-hooks/` | Q3: PreToolUse hook + agent `odd-probe` with ignored frontmatter | `cd spikes/scratch && claude -p "Use the Agent tool with subagent_type odd-subhook:odd-probe to write hello into probe-out.txt" --model haiku --permission-mode bypassPermissions --plugin-dir ../03-subagent-hooks --debug-file ../03-subagent-hooks/debug.log`, then read `03-subagent-hooks/hook-log.jsonl` |
| `06-agent-mcp/` | Q6: plugin stdio MCP server + agent granting its tool; `extra/` = session-level `--mcp-config` variant | `cd spikes/scratch && claude -p "Use the Agent tool with subagent_type odd-mcp:odd-mcp-probe" --model haiku --permission-mode bypassPermissions --plugin-dir ../06-agent-mcp` |
| `tools/pty_drive.py` | Q1: attempt at an interactive run without tmux; stops at the trust dialog (never answers it) | `python3 spikes/tools/pty_drive.py $PWD 12 "" --plugin-dir spikes/01-hello-mod` |

`spikes/scratch/` is the throwaway cwd (holds `probe-out.txt` written by the Q3 agent).
