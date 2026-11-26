#!/bin/sh
# Installer e2e: install then uninstall in a throwaway HOME and assert settings.json is restored exactly.
# Needs the TUI bundle (npm --prefix plugins/odd-claude/tui run bundle), `jq`, and the `claude` CLI (MCP registration).
# Usage: sh scripts/tests/installer-e2e.sh
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
BUNDLE="$REPO/plugins/odd-claude/tui/dist/odd-claude.mjs"
SOURCE="$REPO/plugins/odd-claude"

fail() { printf 'e2e: FAIL: %s\n' "$*" >&2; exit 1; }
[ -f "$BUNDLE" ] || fail "missing $BUNDLE (run: npm --prefix plugins/odd-claude/tui run bundle)"
command -v jq >/dev/null 2>&1 || fail "jq is required"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT INT TERM
export HOME="$TMP/home" CLAUDE_CONFIG_DIR="$TMP/home/.claude" ODD_CLAUDE_HOME="$TMP/home/.odd-claude"
mkdir -p "$CLAUDE_CONFIG_DIR"
SETTINGS="$CLAUDE_CONFIG_DIR/settings.json"

# A foreign hook the installer must keep and restore byte-for-byte (compared with jq -S).
cat > "$SETTINGS" <<'JSON'
{
  "hooks": {
    "SessionStart": [
      { "hooks": [ { "type": "command", "command": "echo foreign-hook" } ] }
    ]
  }
}
JSON
jq -S . "$SETTINGS" > "$TMP/original.json"

node "$BUNDLE" install --source "$SOURCE" --yes --no-deps --json > "$TMP/install.json" || fail "install exited $? ($(cat "$TMP/install.json"))"
[ "$(jq -r .ok "$TMP/install.json")" = "true" ] || fail "install reported ok != true: $(cat "$TMP/install.json")"

[ "$(jq -r .outputStyle "$SETTINGS")" = "odd" ] || fail "outputStyle is not \"odd\""
jq -e '[.hooks.SessionStart[].hooks[].command] | any(. == "echo foreign-hook")' "$SETTINGS" >/dev/null || fail "foreign hook was lost on install"
jq -e '[.hooks[][].hooks[].command | select(contains("dist/hooks/run.js"))] | length >= 9' "$SETTINGS" >/dev/null || fail "odd-claude hooks are not registered"
[ -e "$ODD_CLAUDE_HOME/current/dist/hooks/run.js" ] || fail "$ODD_CLAUDE_HOME/current/dist/hooks/run.js is missing"

node "$BUNDLE" uninstall --yes --json > "$TMP/uninstall.json" || fail "uninstall exited $? ($(cat "$TMP/uninstall.json"))"
[ "$(jq -r .ok "$TMP/uninstall.json")" = "true" ] || fail "uninstall reported ok != true: $(cat "$TMP/uninstall.json")"

jq -S . "$SETTINGS" > "$TMP/after.json"
cmp -s "$TMP/original.json" "$TMP/after.json" || { diff "$TMP/original.json" "$TMP/after.json" >&2 || true; fail "settings.json differs from the original after uninstall"; }

printf 'e2e: ok (install + uninstall restored settings.json)\n'
