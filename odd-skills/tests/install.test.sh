#!/bin/sh
# Installer tests. Every run targets a mktemp -d directory; nothing real is touched.
SRC_INSTALL=$(cd "$(dirname "$0")/.." && pwd -P)/install.sh
ROOT=$(mktemp -d) || exit 1
trap 'rm -rf "$ROOT"' EXIT INT TERM
PASS=0
FAIL=0

ok() { PASS=$((PASS + 1)); printf 'ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL %s\n' "$1"; }
check() { # name, command...
  n=$1; shift
  if "$@" >/dev/null 2>&1; then ok "$n"; else bad "$n"; fi
}
tree_hash() { (cd "$1" && find . -type f | sort | while read -r f; do printf '%s ' "$f"; cksum <"$f"; done; find . | sort); }

# Fixture source tree: <ROOT>/src/odd-skills with its own copy of install.sh.
FIX=$ROOT/src/odd-skills
mkdir -p "$FIX/skills/alpha/references" "$FIX/agents" "$FIX/hooks"
printf '# Coordinator\nline two\n' >"$FIX/CLAUDE.md"
printf -- '---\nname: alpha\n---\nalpha\n' >"$FIX/skills/alpha/SKILL.md"
printf 'ref\n' >"$FIX/skills/alpha/references/r.md"
printf -- '---\nname: agent-a\n---\n' >"$FIX/agents/agent-a.md"
printf '#!/bin/sh\nexit 0\n' >"$FIX/hooks/guard.sh"
cp "$SRC_INSTALL" "$FIX/install.sh"
INSTALL=$FIX/install.sh

# 1. install into an empty target
T1=$ROOT/t1
out=$(sh "$INSTALL" --target "$T1" 2>&1); rc=$?
[ $rc -eq 0 ] && ok "install exits 0" || { bad "install exits 0 (rc=$rc: $out)"; }
check "skill copied with references" test -f "$T1/skills/alpha/references/r.md"
check "agent copied" test -f "$T1/agents/agent-a.md"
check "guard copied and executable" test -x "$T1/odd-skills/hooks/guard.sh"
check "manifest written" test -s "$T1/odd-skills/manifest.txt"
check "CLAUDE.md has block" grep -qx '<!-- odd-skills:begin -->' "$T1/CLAUDE.md"
check "CLAUDE.md has coordinator text" grep -q 'line two' "$T1/CLAUDE.md"
T1R=$(cd "$T1" && pwd -P)
check "settings hook registered (Bash matcher, absolute guard path)" \
  jq -e --arg c "$T1R/odd-skills/hooks/guard.sh" \
  '.hooks.PreToolUse | length == 1 and .[0].matcher == "Bash" and .[0].hooks[0].type == "command" and .[0].hooks[0].command == $c' "$T1/settings.json"

# 2. idempotent re-install
h1=$(cat "$T1/CLAUDE.md" "$T1/settings.json" "$T1/odd-skills/manifest.txt" | cksum)
sh "$INSTALL" --target "$T1" >/dev/null 2>&1
h2=$(cat "$T1/CLAUDE.md" "$T1/settings.json" "$T1/odd-skills/manifest.txt" | cksum)
[ "$h1" = "$h2" ] && ok "re-install leaves CLAUDE.md, settings.json, manifest unchanged" || bad "re-install changed files"
[ "$(grep -c 'odd-skills:begin' "$T1/CLAUDE.md")" -eq 1 ] && ok "single block after re-install" || bad "block duplicated"
[ "$(jq '.hooks.PreToolUse | length' "$T1/settings.json")" -eq 1 ] && ok "single hook entry after re-install" || bad "hook duplicated"
# block replaced in place with new content
printf '# Coordinator v2\n' >"$FIX/CLAUDE.md"
sh "$INSTALL" --target "$T1" >/dev/null 2>&1
{ grep -q 'v2' "$T1/CLAUDE.md" && ! grep -q 'line two' "$T1/CLAUDE.md"; } && ok "re-install replaces block content" || bad "block not replaced"
printf '# Coordinator\nline two\n' >"$FIX/CLAUDE.md"

# 3. uninstall on a target with foreign content restores it byte for byte
T2=$ROOT/t2
mkdir -p "$T2/skills/mine" "$T2/agents"
printf 'mine\n' >"$T2/skills/mine/SKILL.md"
printf '# My rules\n\nkeep me\n' >"$T2/CLAUDE.md"
cat >"$T2/settings.json" <<'JSON'
{
  "model": "opus",
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit",
        "hooks": [
          {
            "type": "command",
            "command": "echo foreign"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "echo stop"
          }
        ]
      }
    ]
  }
}
JSON
cp "$T2/CLAUDE.md" "$ROOT/claude.orig"; cp "$T2/settings.json" "$ROOT/settings.orig"
sh "$INSTALL" --target "$T2" >/dev/null 2>&1
check "foreign CLAUDE.md content kept on install" grep -q 'keep me' "$T2/CLAUDE.md"
check "foreign hooks kept on install" jq -e '.model == "opus" and (.hooks.Stop | length) == 1 and (.hooks.PreToolUse | length) == 2' "$T2/settings.json"
check "backup dir holds original CLAUDE.md" sh -c "cat '$T2'/.odd-skills-backup/*/CLAUDE.md | cmp -s - '$ROOT/claude.orig'"
check "backup dir holds original settings.json" sh -c "cat '$T2'/.odd-skills-backup/*/settings.json | cmp -s - '$ROOT/settings.orig'"
out=$(sh "$INSTALL" --target "$T2" --uninstall 2>&1); rc=$?
[ $rc -eq 0 ] && ok "uninstall exits 0" || bad "uninstall exits 0 (rc=$rc: $out)"
check "uninstall restores CLAUDE.md byte for byte" cmp -s "$T2/CLAUDE.md" "$ROOT/claude.orig"
check "uninstall restores settings.json byte for byte" cmp -s "$T2/settings.json" "$ROOT/settings.orig"
check "uninstall removed installed skill" test ! -e "$T2/skills/alpha"
check "uninstall removed installed agent" test ! -e "$T2/agents/agent-a.md"
check "uninstall kept foreign skill" test -f "$T2/skills/mine/SKILL.md"
check "uninstall removed manifest" test ! -e "$T2/odd-skills/manifest.txt"

# 3b. uninstall of a fresh install removes the files it created
sh "$INSTALL" --target "$T1" --uninstall >/dev/null 2>&1
check "fresh install fully removed (CLAUDE.md gone)" test ! -e "$T1/CLAUDE.md"
check "fresh install fully removed (settings.json gone)" test ! -e "$T1/settings.json"
check "fresh install fully removed (odd-skills dir gone)" test ! -e "$T1/odd-skills"

# 4. foreign same-name skill is backed up and reported
T3=$ROOT/t3
mkdir -p "$T3/skills/alpha"
printf 'foreign alpha\n' >"$T3/skills/alpha/SKILL.md"
out=$(sh "$INSTALL" --target "$T3" 2>&1)
check "foreign skill overwritten by installed one" grep -q '^name: alpha' "$T3/skills/alpha/SKILL.md"
check "foreign skill backed up" sh -c "grep -q 'foreign alpha' '$T3'/.odd-skills-backup/*/skills/alpha/SKILL.md"
printf '%s' "$out" | grep -qi 'backed up.*alpha\|alpha.*backed up' && ok "foreign skill reported" || bad "foreign skill not reported: $out"
n=$(ls "$T3/.odd-skills-backup" | wc -l)
sh "$INSTALL" --target "$T3" >/dev/null 2>&1
check "re-install does not re-back-up own skill" sh -c "! grep -rq 'name: alpha' '$T3'/.odd-skills-backup/*/skills 2>/dev/null"

# 5. dry-run changes nothing
T4=$ROOT/t4
mkdir -p "$T4"
printf 'pre\n' >"$T4/CLAUDE.md"
printf '{"a":1}\n' >"$T4/settings.json"
before=$(tree_hash "$T4")
out=$(sh "$INSTALL" --target "$T4" --dry-run 2>&1); rc=$?
after=$(tree_hash "$T4")
[ $rc -eq 0 ] && ok "dry-run install exits 0" || bad "dry-run install exits 0 ($out)"
[ "$before" = "$after" ] && ok "dry-run install changes nothing" || bad "dry-run install changed target"
printf '%s' "$out" | grep -q 'skills/alpha' && printf '%s' "$out" | grep -q 'settings.json' && printf '%s' "$out" | grep -q 'CLAUDE.md' && ok "dry-run lists planned actions" || bad "dry-run output incomplete: $out"
sh "$INSTALL" --target "$T4" >/dev/null 2>&1
before=$(tree_hash "$T4")
out=$(sh "$INSTALL" --target "$T4" --uninstall --dry-run 2>&1); rc=$?
after=$(tree_hash "$T4")
[ $rc -eq 0 ] && [ "$before" = "$after" ] && ok "dry-run uninstall changes nothing" || bad "dry-run uninstall changed target or failed"
T5=$ROOT/t5-never
sh "$INSTALL" --target "$T5" --dry-run >/dev/null 2>&1
check "dry-run does not create a missing target" test ! -e "$T5"

# 6. refusals
out=$(sh "$INSTALL" 2>&1); rc=$?
{ [ $rc -ne 0 ] && printf '%s' "$out" | grep -q -- '--target'; } && ok "refuses missing --target" || bad "missing --target not refused (rc=$rc)"
FH=$ROOT/home
mkdir -p "$FH"
out=$(HOME=$FH sh "$INSTALL" --target "$FH/.claude" 2>&1); rc=$?
{ [ $rc -ne 0 ] && printf '%s' "$out" | grep -q -- '--i-know-this-is-my-real-config'; } && ok "refuses real config without flag" || bad "real config not refused (rc=$rc)"
check "refused real config left untouched" test ! -e "$FH/.claude"
out=$(HOME=$FH sh "$INSTALL" --target "$FH/.claude" --uninstall 2>&1); rc=$?
[ $rc -ne 0 ] && ok "refuses real config uninstall without flag" || bad "real config uninstall not refused"
out=$(HOME=$FH sh "$INSTALL" --target "$FH/.claude" --i-know-this-is-my-real-config 2>&1); rc=$?
{ [ $rc -eq 0 ] && [ -f "$FH/.claude/CLAUDE.md" ]; } && ok "real config accepted with explicit flag (fake HOME)" || bad "flagged real config failed ($out)"
out=$(sh "$INSTALL" --target "$ROOT/never" --uninstall 2>&1); rc=$?
{ [ $rc -ne 0 ] && printf '%s' "$out" | grep -qi 'manifest'; } && ok "uninstall without manifest refused" || bad "uninstall without manifest not refused (rc=$rc)"
check "refused uninstall created nothing" test ! -e "$ROOT/never"

printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
