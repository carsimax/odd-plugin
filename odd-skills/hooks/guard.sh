#!/bin/sh
# odd-skills guard: PreToolUse hook for the Bash tool.
# Blocks (exit 2, remediation on stderr) irreversible git and rm commands; allows everything else.
#
# Hook input (JSON on stdin, https://code.claude.com/docs/en/hooks.md): tool_name, cwd and
# tool_input.command. Exit 2 blocks the tool call and feeds stderr back to the model.
# Blocked: git push --force/-f/--force-with-lease, git reset --hard, --no-verify, git branch -D,
# git clean -f, and rm -rf aimed at /, ~, $HOME, a path with "..", or any absolute path outside cwd.
# Limits: it inspects each simple command of the line (split on ; & | and newlines, with subshell
# parentheses); commands wrapped in `bash -c "..."` or built dynamically are not inspected.
# Any hook failure or unparsable input allows the command (fail open): this is a guard rail, not a sandbox.

input=$(cat)

if command -v jq >/dev/null 2>&1; then
  tool=$(printf '%s' "$input" | jq -r '.tool_name // empty' 2>/dev/null) || exit 0
  cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null) || exit 0
  cwd=$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null) || exit 0
else
  field() { printf '%s' "$input" | sed -E -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"(([^\"\\\\]|\\\\.)*)\".*/\\1/p" | head -n 1; }
  tool=$(field tool_name)
  cmd=$(field command | sed 's/\\"/"/g; s/\\\\/\\/g')
  cwd=$(field cwd)
fi

[ "$tool" = "Bash" ] || exit 0
[ -n "$cmd" ] || exit 0
[ -n "$cwd" ] || cwd=$(pwd)

block() { # reason, remediation
  printf 'odd-skills guard blocked this command: %s\nRemediation: %s\nIf the user explicitly asked for it, ask them to run it themselves.\n' "$1" "$2" >&2
  exit 2
}

has_word() { # word in "$seg"
  case " $seg " in *" $1 "*) return 0 ;; esac
  return 1
}

check_rm_path() { # one rm operand
  p=$1
  case $p in \"*\" | \'*\') p=${p#?}; p=${p%?} ;; esac
  case $p in
    /) echo "rm -rf on /" ;;
    "~" | "~/"* | '$HOME' | '$HOME/'* | '${HOME}' | '${HOME}/'*) echo "rm -rf on the home directory ($p)" ;;
    ".." | "../"* | *"/../"* | *"/..") echo "rm -rf outside the project via '..' ($p)" ;;
    "$cwd" | "$cwd/"*) ;;
    /*) echo "rm -rf on an absolute path outside the project ($p)" ;;
  esac
}

check_segment() {
  seg=$1
  set -f
  # shellcheck disable=SC2086
  set -- $seg
  set +f
  while [ "$1" = sudo ] || [ "$1" = command ] || [ "$1" = env ]; do shift; done
  case "$1" in
    git)
      has_word --no-verify && block "--no-verify skips hooks" "run the command without --no-verify and fix the failing hook"
      has_word push && {
        has_word --force && block "git push --force" "push normally; ask the user before rewriting remote history"
        has_word -f && block "git push -f" "push normally; ask the user before rewriting remote history"
        has_word --force-with-lease && block "git push --force-with-lease" "push normally; ask the user before rewriting remote history"
      }
      has_word reset && has_word --hard && block "git reset --hard" "use git stash or git reset --soft/--mixed; ask the user before discarding work"
      has_word branch && has_word -D && block "git branch -D" "use git branch -d, or ask the user before force-deleting a branch"
      has_word clean && {
        for t in "$@"; do
          case $t in --force | -f* | -[!-]*f*) block "git clean -f" "run git clean -n to preview; ask the user before deleting untracked files" ;; esac
        done
      }
      ;;
    rm)
      shift
      rec=0 frc=0
      for t in "$@"; do
        case $t in
          --recursive) rec=1 ;;
          --force) frc=1 ;;
          --*) ;;
          -*) case $t in *[rR]*) rec=1 ;; esac; case $t in *f*) frc=1 ;; esac ;;
        esac
      done
      [ "$rec$frc" = 11 ] || return 0
      for t in "$@"; do
        case $t in -*) continue ;; esac
        r=$(check_rm_path "$t")
        [ -n "$r" ] && block "$r" "delete only specific paths inside the project, or ask the user"
      done
      ;;
  esac
  return 0
}

segments=$(printf '%s\n' "$cmd" | sed 's/&&/\n/g; s/||/\n/g; s/[;&|(){]/\n/g')
oldifs=$IFS
IFS='
'
for s in $segments; do
  IFS=$oldifs
  s=$(printf '%s' "$s" | sed 's/^[[:space:]]*//')
  [ -n "$s" ] && check_segment "$s"
  IFS='
'
done
exit 0
