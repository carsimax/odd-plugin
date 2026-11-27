#!/usr/bin/env bash
# Rerun: builds a sandbox HOME (mktemp -d), lays out an odd-claude-like tree, runs the settings.json commands exactly.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
SB="$(mktemp -d)"; export HOME="$SB"        # never touches the real ~/.claude
trap 'rm -rf "$SB"' EXIT                    # removes only this mktemp dir
ODD="$SB/.odd-claude"
mkdir -p "$ODD/versions/1.0.0/py" "$SB/.claude"
cp "$here"/stubs/*.py "$ODD/versions/1.0.0/py/"
python3.14 -m venv "$ODD/versions/1.0.0/venv" 2>/dev/null || python3 -m venv "$ODD/versions/1.0.0/venv"
ln -s "$ODD/versions/1.0.0" "$ODD/current"
PY="$ODD/current/venv/bin/python"
HOOK="\"$PY\" \"$ODD/current/py/hook.py\" PreToolUse"
MCP="\"$PY\" \"$ODD/current/py/mcp.py\""
python3 - "$SB/.claude/settings.json" "$HOOK" <<'PYEOF'
import json, sys
json.dump({"hooks": {"PreToolUse": [{"matcher": "Bash|Edit|Write", "hooks": [{"type": "command", "command": sys.argv[2], "timeout": 10}]}]}}, open(sys.argv[1], "w"), indent=2)
PYEOF
now() { python3 -c 'import time;print(time.time())'; }
echo "== settings.json hook command (read back from sandbox settings.json)"
CMD="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["hooks"]["PreToolUse"][0]["hooks"][0]["command"])' "$SB/.claude/settings.json")"
echo "${CMD//$SB/\$SANDBOX}"
for i in 1 2 3; do
  t0=$(now)
  out="$(echo '{"hook_event_name":"PreToolUse","tool_name":"Bash","cwd":"/tmp"}' | bash -c "$CMD")"; rc=$?
  t1=$(now)
  echo "hook run $i: exit=$rc stdout=$out wall=$(python3 -c "print(f'{($t1-$t0)*1000:.0f}ms')")"
done
echo "== MCP command"; echo "${MCP//$SB/\$SANDBOX}"
for i in 1 2 3; do
  t0=$(now)
  out="$(echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}' | bash -c "$MCP")"; rc=$?
  t1=$(now)
  echo "mcp run $i: exit=$rc initialize=$out wall=$(python3 -c "print(f'{($t1-$t0)*1000:.0f}ms')")"
done
echo "== comparison timing: uv run --no-project --script (PATH-dependent, informational)"
if command -v uv >/dev/null; then
  for i in 1 2; do
    t0=$(now); echo '{"hook_event_name":"PreToolUse"}' | uv run --no-project --quiet --script "$here/stubs/hook.py" PreToolUse >/dev/null; t1=$(now)
    echo "uv run $i: wall=$(python3 -c "print(f'{($t1-$t0)*1000:.0f}ms')")"
  done
  echo "== same hook with PATH stripped (hook-env simulation)"
  echo '{"hook_event_name":"PreToolUse"}' | env -i HOME="$HOME" PATH=/usr/bin:/bin bash -c "$CMD" && rc=0 || rc=$?; echo "venv python, stripped PATH: exit=$rc"
  echo '{"hook_event_name":"PreToolUse"}' | env -i HOME="$HOME" PATH=/usr/bin:/bin bash -c "uv run --no-project --script '$here/stubs/hook.py' PreToolUse" >/dev/null 2>&1 && rc=0 || rc=$?; echo "uv run, stripped PATH: exit=$rc"
fi
