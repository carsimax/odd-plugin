#!/bin/sh
# Tests for hooks/guard.sh. Feeds PreToolUse hook JSON on stdin and checks the exit code
# (2 = blocked with a remediation message on stderr, 0 = allowed).
# Hook input shape relied on (https://code.claude.com/docs/en/hooks.md): a JSON object with
# "tool_name":"Bash", "tool_input":{"command":"..."} and "cwd":"<project dir>".
# Run: sh odd-skills/tests/guard.test.sh
HERE=$(cd "$(dirname "$0")" && pwd)
GUARD="$HERE/../hooks/guard.sh"
PROJ=$(mktemp -d) || exit 1
trap 'rmdir "$PROJ" 2>/dev/null' EXIT
fail=0
total=0

json_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

run() { # expected command
  want=$1; cmd=$2; total=$((total + 1))
  payload=$(printf '{"session_id":"t","cwd":"%s","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"%s"}}' "$PROJ" "$(json_escape "$cmd")")
  err=$(printf '%s' "$payload" | sh "$GUARD" 2>&1 >/dev/null)
  got=$?
  if [ "$got" != "$want" ]; then
    echo "FAIL: want exit $want got $got: $cmd"; fail=$((fail + 1))
  elif [ "$want" = 2 ] && [ -z "$err" ]; then
    echo "FAIL: blocked without stderr message: $cmd"; fail=$((fail + 1))
  else
    echo "ok: ($want) $cmd"
  fi
}

# blocked
run 2 'git push --force origin main'
run 2 'git push -f origin feat/x'
run 2 'git push origin feat/x --force-with-lease'
run 2 'git push --force-with-lease'
run 2 'git reset --hard HEAD~1'
run 2 'git commit --no-verify -m x'
run 2 'git push --no-verify origin feat/x'
run 2 'git branch -D old'
run 2 'git clean -fd'
run 2 'git clean -f'
run 2 'cd repo && git reset --hard'
run 2 'rm -rf /'
run 2 'rm -rf ~'
run 2 'rm -rf ~/Documents'
run 2 'rm -rf $HOME'
run 2 'rm -rf "$HOME/x"'
run 2 'rm -rf /tmp/other'
run 2 'rm -rf ../sibling'
run 2 'rm -fr /etc'
run 2 'rm -r -f /var/log'
# allowed
run 0 'git push origin feat/x'
run 0 'git status'
run 0 'git branch -d merged'
run 0 'git clean -n'
run 0 'git reset --soft HEAD~1'
run 0 'rm -rf ./build'
run 0 'rm -rf build dist'
run 0 "rm -rf $PROJ/out"
run 0 'rm file.txt'
run 0 'npm test'
run 0 'echo "git push --force is blocked"'

# non-Bash tool and malformed input never block
total=$((total + 1))
printf '%s' '{"tool_name":"Read","tool_input":{"file_path":"/x"}}' | sh "$GUARD" >/dev/null 2>&1
[ $? = 0 ] && echo "ok: non-Bash tool" || { echo "FAIL: non-Bash tool"; fail=$((fail + 1)); }
total=$((total + 1))
printf '%s' 'not json' | sh "$GUARD" >/dev/null 2>&1
[ $? = 0 ] && echo "ok: malformed input" || { echo "FAIL: malformed input"; fail=$((fail + 1)); }

echo "$((total - fail))/$total passed"
[ "$fail" = 0 ]
