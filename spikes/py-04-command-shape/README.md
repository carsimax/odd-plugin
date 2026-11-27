# py-04: hook and MCP command shape in `settings.json`

Throwaway spike (Phase 0, S4). Stdlib stubs only (`stubs/hook.py`, `stubs/mcp.py`); no dependency on the Python skeleton or on the MCP SDK choice.

## v9 reference

- Hooks: `plugins/odd-claude/src/installer/hooks-config.ts` writes into `~/.claude/settings.json` `hooks` entries of the form `node "<oddRoot>/dist/hooks/run.js" <Event>` (optional `ODD_CLAUDE_HOME="..." ` prefix; `<oddRoot>` is the `~/.odd-claude/current` symlink). Ours are identified by the run path inside the command.
- MCP: `plugins/odd-claude/src/installer/mcp.ts` does not edit `settings.json`; it runs `claude mcp add -s user odd-review -- node <root>/dist/mcp/review-server.js` (user scope, stored by Claude Code itself).

## Result

Chosen shape: absolute interpreter path into a venv that lives inside the versioned install tree, reached through the `current` symlink (same layout as v9: `~/.odd-claude/versions/<v>/` plus `current`).

Hook command (one per event, `<EVENT>` is the hook event name; `$ODD` is the expanded absolute `~/.odd-claude`):

```
"$ODD/current/venv/bin/python" "$ODD/current/py/hook.py" <EVENT>
```

MCP server command (registered the v9 way, `claude mcp add -s user odd-review -- <command>`):

```
"$ODD/current/venv/bin/python" "$ODD/current/py/mcp.py"
```

`settings.json` snippet (hooks; the MCP server is not in `settings.json`):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|Edit|Write",
        "hooks": [
          { "type": "command", "command": "\"/Users/me/.odd-claude/current/venv/bin/python\" \"/Users/me/.odd-claude/current/py/hook.py\" PreToolUse", "timeout": 10 }
        ]
      }
    ]
  }
}
```

In the real port `py/hook.py` becomes `-m odd_claude.hooks <EVENT>` (package installed into that venv); the interpreter prefix is what this spike decides.

Observed (sandbox HOME from `mktemp -d`, commands read back from the sandbox `settings.json` and run via `bash -c`, macOS, uv 0.13.5, Python 3.14):

- Hook: exit 0, stdout `{"hookSpecificOutput": {"hookEventName": "PreToolUse", "additionalContext": "py-04 stub ok"}}`; wall 63-76 ms.
- MCP `initialize` response: `{"jsonrpc": "2.0", "id": 1, "result": {"protocolVersion": "2025-06-18", "capabilities": {}, "serverInfo": {"name": "py-04-stub", "version": "0"}}}`, exit 0 at EOF; wall 63-120 ms.
- `uv run --no-project --script hook.py`: 65-132 ms (informational, warm uv cache); with `PATH=/usr/bin:/bin` (as a stripped hook environment) it exits 127 (uv not found) while the absolute venv command still exits 0.
- Timings are single-machine, informational only, and include the `bash -c` and python start of the harness.

| Option | Startup | Robust when PATH/uv differ in the hook env | Upgrade / rollback | Verdict |
|---|---|---|---|---|
| Absolute venv interpreter (`.../current/venv/bin/python`) | lowest, direct exec (~65 ms measured) | no PATH lookup, no uv needed at run time: observed exit 0 with stripped PATH | new `versions/<v>/` + venv, flip `current`; rollback = flip back; same mechanism as v9 | chosen |
| `uv run --project <dir>` | adds uv resolve/lock check on every hook (the `--script` variant measured ~65-130 ms; `--project` also syncs, unmeasured here), can hit the network or lock when env is stale | needs uv on PATH: observed exit 127 with stripped PATH; Claude Code hooks may not inherit the shell PATH | project dir is mutable, no atomic switch | rejected |
| `uv tool install` console script (`~/.local/bin/odd-claude-hook`) | one launcher exec, close to venv | needs `~/.local/bin` on PATH or an absolute launcher path; not run here (building a package needs a build backend download) | `uv tool upgrade`/reinstall replaces in place, no cheap rollback, shared tool env outside `~/.odd-claude` | rejected (paper judgment) |

Why: hooks run on every tool call, so startup and independence from the ambient PATH matter most; the absolute interpreter has neither a uv dependency nor a resolve step, and the versioned dir plus `current` symlink keeps the v9 install/rollback/uninstall model (identify ours by the `.odd-claude/current` path in the command, as v9 does by `run.js`). Cost: install must create one venv per version (uv can build it: `uv venv` + `uv pip install`), and `settings.json` holds an absolute path.

## Rerun

```
bash spikes/py-04-command-shape/run.sh
```

It creates the sandbox HOME with `mktemp -d`, builds the venv with `python3 -m venv` inside it, prints the commands, hook and `initialize` results with timings, and removes the sandbox on exit. `uv` is optional (the comparison section is skipped without it). Last run: exit code 0 from the final stripped-PATH checks printing `venv python, stripped PATH: exit=0` and `uv run, stripped PATH: exit=127`.
