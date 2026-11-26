#!/usr/bin/env bash
# Tests for cds-skills install.sh / uninstall.sh. Runs only against temp HOMEs.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
export CDS_SRC="$ROOT/payload"
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
assert_file() { [ -f "$1" ] || fail "missing file: $1"; }
assert_dir() { [ -d "$1" ] || fail "missing dir: $1"; }
assert_absent() { [ ! -e "$1" ] || fail "should not exist: $1"; }
assert_eq() { [ "$1" = "$2" ] || fail "$3: expected [$2] got [$1]"; }
count_marker() { grep -c -F "$1" "$2" || true; }

new_home() { H="$(mktemp -d "$SCRATCH/home.XXXXXX")"; T="$H/.claude"; mkdir -p "$T"; export HOME="$H"; unset CLAUDE_CONFIG_DIR; }
run_install() { bash "$ROOT/install.sh"; }

HAVE_JQ=1
command -v jq >/dev/null 2>&1 || HAVE_JQ=0

# ---------- install into a populated config ----------
new_home
mkdir -p "$T/agents" "$T/skills/cds"
printf '# My notes\nkeep me\n' > "$T/CLAUDE.md"
echo "user agent" > "$T/agents/mine.md"
echo "stale skill file" > "$T/skills/cds/leftover.txt"
printf '{"theme":"dark"}\n' > "$T/settings.json"

OUT="$(run_install 2>&1)" || fail "install failed: $OUT"

assert_eq "$(find "$T/skills" -mindepth 1 -maxdepth 1 -type d -name 'cds*' | wc -l | tr -d ' ')" 13 "skill dirs"
for s in "$ROOT"/payload/skills/*/; do
  assert_file "$T/skills/$(basename "$s")/SKILL.md"
done
assert_absent "$T/skills/cds/leftover.txt"
assert_eq "$(find "$T/agents" -maxdepth 1 -name 'cds-*.md' | wc -l | tr -d ' ')" 10 "agents"
assert_eq "$(find "$T/rules" -maxdepth 1 -name 'cds-*.md' | wc -l | tr -d ' ')" 3 "rules"
assert_file "$T/output-styles/cds.md"
assert_file "$T/cds-skills/uninstall.sh"
assert_file "$T/cds-skills/manifest.txt"
assert_eq "$(wc -l < "$T/cds-skills/manifest.txt" | tr -d ' ')" 27 "manifest entries"
grep -qx 'skills/cds-branch-pr' "$T/cds-skills/manifest.txt" || fail "manifest lacks skill"
grep -qx 'agents/cds-worker.md' "$T/cds-skills/manifest.txt" || fail "manifest lacks agent"
grep -qx 'rules/cds-tracking.md' "$T/cds-skills/manifest.txt" || fail "manifest lacks rule"
grep -qx 'output-styles/cds.md' "$T/cds-skills/manifest.txt" || fail "manifest lacks style"
assert_file "$T/agents/mine.md"

# CLAUDE.md: preserved + one block + backup
grep -q '^keep me$' "$T/CLAUDE.md" || fail "user CLAUDE.md content lost"
assert_eq "$(count_marker '<!-- cds:start -->' "$T/CLAUDE.md")" 1 "start markers"
assert_eq "$(count_marker '<!-- cds:end -->' "$T/CLAUDE.md")" 1 "end markers"
BK="$(find "$T" -maxdepth 1 -name 'CLAUDE.md.cds-backup-*' | head -1)"
[ -n "$BK" ] || fail "no CLAUDE.md backup"
assert_eq "$(cat "$BK")" "$(printf '# My notes\nkeep me')" "backup content"
echo "$OUT" | grep -qF "bash \"$T/cds-skills/uninstall.sh\"" || fail "summary lacks uninstall command"

# settings.json with jq
if [ "$HAVE_JQ" = 1 ]; then
  assert_eq "$(jq -r .outputStyle "$T/settings.json")" cds "outputStyle"
  assert_eq "$(jq -r .theme "$T/settings.json")" dark "unrelated key"
else
  echo "SKIP: jq absent, settings.json assertions"
fi

# ---------- reinstall: no duplicate, stale removal, user edit outside block ----------
printf '\nuser tail\n' >> "$T/CLAUDE.md"
echo "agents/cds-old.md" >> "$T/cds-skills/manifest.txt"
echo "old" > "$T/agents/cds-old.md"
echo "../escape.txt" >> "$T/cds-skills/manifest.txt"
echo "keep" > "$H/escape.txt"
echo "agents/other-user.md" >> "$T/cds-skills/manifest.txt"
echo "mine" > "$T/agents/other-user.md"
run_install >/dev/null 2>&1 || fail "reinstall failed"
assert_eq "$(count_marker '<!-- cds:start -->' "$T/CLAUDE.md")" 1 "start markers after reinstall"
assert_eq "$(count_marker '<!-- cds:end -->' "$T/CLAUDE.md")" 1 "end markers after reinstall"
grep -q '^user tail$' "$T/CLAUDE.md" || fail "content after block lost"
grep -q '^keep me$' "$T/CLAUDE.md" || fail "content before block lost"
assert_absent "$T/agents/cds-old.md"
assert_file "$T/agents/mine.md"
assert_file "$T/agents/other-user.md"
assert_file "$H/escape.txt"
assert_eq "$(wc -l < "$T/cds-skills/manifest.txt" | tr -d ' ')" 27 "manifest after reinstall"
assert_eq "$(find "$T" -maxdepth 1 -name 'CLAUDE.md.cds-backup-*' | wc -l | tr -d ' ')" 2 "backups after reinstall"

# ---------- uninstall ----------
cp "$T/CLAUDE.md" "$SCRATCH/claude.before"
bash "$T/cds-skills/uninstall.sh" >/dev/null 2>&1 || fail "uninstall failed"
assert_eq "$(find "$T/skills" -mindepth 1 -maxdepth 1 -name 'cds*' 2>/dev/null | wc -l | tr -d ' ')" 0 "skills left"
assert_eq "$(find "$T/agents" -maxdepth 1 -name 'cds-*.md' | wc -l | tr -d ' ')" 0 "agents left"
assert_eq "$(find "$T/rules" -maxdepth 1 -name 'cds-*.md' 2>/dev/null | wc -l | tr -d ' ')" 0 "rules left"
assert_absent "$T/output-styles/cds.md"
assert_absent "$T/cds-skills"
assert_file "$T/agents/mine.md"
assert_file "$T/agents/other-user.md"
assert_eq "$(count_marker 'cds:start' "$T/CLAUDE.md")" 0 "marker after uninstall"
grep -q '^keep me$' "$T/CLAUDE.md" || fail "user content lost on uninstall"
grep -q '^user tail$' "$T/CLAUDE.md" || fail "user tail lost on uninstall"
if [ "$HAVE_JQ" = 1 ]; then
  assert_eq "$(jq -r 'has("outputStyle")' "$T/settings.json")" false "outputStyle removed"
  assert_eq "$(jq -r .theme "$T/settings.json")" dark "unrelated key after uninstall"
fi
# second uninstall (script copy kept outside) succeeds
cp "$ROOT/uninstall.sh" "$SCRATCH/uninstall.sh"
bash "$SCRATCH/uninstall.sh" >/dev/null 2>&1 || fail "second uninstall failed"

# ---------- block-only file round trip is byte-exact ----------
new_home
printf 'line one\nline two' > "$T/CLAUDE.md"   # no trailing newline
run_install >/dev/null 2>&1 || fail "install (no trailing newline)"
bash "$T/cds-skills/uninstall.sh" >/dev/null 2>&1 || fail "uninstall (no trailing newline)"
cmp -s "$T/CLAUDE.md" <(printf 'line one\nline two\n') || [ "$(cat "$T/CLAUDE.md")" = "$(printf 'line one\nline two')" ] || fail "round trip altered CLAUDE.md"

# ---------- fresh install: no CLAUDE.md, no settings.json ----------
new_home
rm -rf "$T"
run_install >/dev/null 2>&1 || fail "fresh install"
assert_file "$T/CLAUDE.md"
assert_eq "$(count_marker '<!-- cds:start -->' "$T/CLAUDE.md")" 1 "fresh start marker"
if [ "$HAVE_JQ" = 1 ]; then
  assert_eq "$(jq -r .outputStyle "$T/settings.json")" cds "fresh outputStyle"
fi

# ---------- no jq: settings.json untouched, instruction printed ----------
new_home
printf '{"theme":"dark"}\n' > "$T/settings.json"
cp "$T/settings.json" "$SCRATCH/settings.before"
OUT="$(CDS_JQ=/nonexistent run_install 2>&1)" || fail "no-jq install failed"
cmp -s "$T/settings.json" "$SCRATCH/settings.before" || fail "settings.json changed without jq"
echo "$OUT" | grep -qF 'jq not found: run /output-style cds inside Claude Code to activate the cds output style.' || fail "no-jq instruction missing"
OUT="$(CDS_JQ=/nonexistent bash "$T/cds-skills/uninstall.sh" 2>&1)" || fail "no-jq uninstall failed"
cmp -s "$T/settings.json" "$SCRATCH/settings.before" || fail "settings.json changed by no-jq uninstall"

# ---------- invalid settings.json aborts without touching anything ----------
if [ "$HAVE_JQ" = 1 ]; then
  new_home
  printf '{not json' > "$T/settings.json"
  if run_install >/dev/null 2>&1; then fail "install should abort on invalid settings.json"; fi
  assert_eq "$(cat "$T/settings.json")" '{not json' "invalid settings untouched"
  assert_absent "$T/skills"
fi

# ---------- uninstall keeps a non-cds outputStyle ----------
if [ "$HAVE_JQ" = 1 ]; then
  new_home
  run_install >/dev/null 2>&1
  printf '{"outputStyle":"other"}\n' > "$T/settings.json"
  bash "$T/cds-skills/uninstall.sh" >/dev/null 2>&1
  assert_eq "$(jq -r .outputStyle "$T/settings.json")" other "foreign outputStyle kept"
fi

# ---------- CLAUDE_CONFIG_DIR honored ----------
new_home
ALT="$SCRATCH/alt-config"
CLAUDE_CONFIG_DIR="$ALT" bash "$ROOT/install.sh" >/dev/null 2>&1 || fail "install with CLAUDE_CONFIG_DIR"
assert_file "$ALT/agents/cds-worker.md"
assert_file "$ALT/cds-skills/manifest.txt"
assert_absent "$H/.claude/agents"
CLAUDE_CONFIG_DIR="$ALT" bash "$ALT/cds-skills/uninstall.sh" >/dev/null 2>&1 || fail "uninstall with CLAUDE_CONFIG_DIR"
assert_absent "$ALT/agents/cds-worker.md"

# ---------- symlinked CLAUDE.md and settings.json (dotfile managers) ----------
new_home
mkdir -p "$H/dot"
printf '{"theme":"dark"}\n' > "$H/dot/settings.json"
printf 'mine' > "$H/dot/CLAUDE.md"
ln -s "$H/dot/settings.json" "$T/settings.json"
ln -s "$H/dot/CLAUDE.md" "$T/CLAUDE.md"
run_install >/dev/null 2>&1 || fail "install with symlinks"
[ -L "$T/CLAUDE.md" ] || fail "CLAUDE.md symlink replaced on install"
[ -L "$T/settings.json" ] || fail "settings.json symlink replaced on install"
assert_eq "$(count_marker '<!-- cds:start -->' "$H/dot/CLAUDE.md")" 1 "symlink target block"
if [ "$HAVE_JQ" = 1 ]; then
  assert_eq "$(jq -r .outputStyle "$H/dot/settings.json")" cds "symlink target outputStyle"
  assert_eq "$(jq -r .theme "$H/dot/settings.json")" dark "symlink target theme"
fi
bash "$T/cds-skills/uninstall.sh" >/dev/null 2>&1 || fail "uninstall with symlinks"
[ -L "$T/CLAUDE.md" ] || fail "CLAUDE.md symlink replaced on uninstall"
[ -L "$T/settings.json" ] || fail "settings.json symlink replaced on uninstall"
assert_eq "$(cat "$H/dot/CLAUDE.md")" mine "symlink target CLAUDE.md restored"
if [ "$HAVE_JQ" = 1 ]; then
  assert_eq "$(jq -r 'has("outputStyle")' "$H/dot/settings.json")" false "symlink target outputStyle removed"
fi

# ---------- CRLF and plain CLAUDE.md round trip, byte-exact ----------
for variant in crlf plain; do
  new_home
  if [ "$variant" = crlf ]; then printf 'a\r\nb\r\n' > "$T/CLAUDE.md"; else printf '# x\n\ny\n' > "$T/CLAUDE.md"; fi
  cp "$T/CLAUDE.md" "$SCRATCH/orig.$variant"
  run_install >/dev/null 2>&1 || fail "install 1 ($variant)"
  run_install >/dev/null 2>&1 || fail "install 2 ($variant)"
  assert_eq "$(count_marker '<!-- cds:start -->' "$T/CLAUDE.md")" 1 "blocks ($variant)"
  bash "$T/cds-skills/uninstall.sh" >/dev/null 2>&1 || fail "uninstall ($variant)"
  cmp -s "$T/CLAUDE.md" "$SCRATCH/orig.$variant" || fail "round trip not byte-exact ($variant)"
done

# ---------- piped install with a space in HOME ----------
H="$(mktemp -d "$SCRATCH/home dir.XXXXXX")"; T="$H/.claude"; mkdir -p "$T"; export HOME="$H"
cat "$ROOT/install.sh" | bash >/dev/null 2>&1 || fail "piped install"
assert_eq "$(find "$T/agents" -maxdepth 1 -name 'cds-*.md' | wc -l | tr -d ' ')" 10 "piped agents"

# ---------- tampered manifest deletes nothing outside the allowlist ----------
new_home
run_install >/dev/null 2>&1
mkdir -p "$T/skills/cdsnotes-user"; echo keep > "$T/skills/cdsnotes-user/f"
echo victim > "$H/victim"
printf '{"theme":"dark"}\n' > "$T/settings.json"
printf '%s\n' /etc/hosts 'skills/cds/../../../victim' 'agents/../CLAUDE.md' settings.json skills/cdsnotes-user >> "$T/cds-skills/manifest.txt"
check_tamper() {
  [ -f /etc/hosts ] || fail "/etc/hosts gone ($1)"
  assert_file "$H/victim"; assert_file "$T/CLAUDE.md"; assert_file "$T/settings.json"
  assert_file "$T/skills/cdsnotes-user/f"
}
run_install >/dev/null 2>&1 || fail "reinstall (tampered)"
check_tamper reinstall
printf '%s\n' /etc/hosts 'skills/cds/../../../victim' 'agents/../CLAUDE.md' settings.json skills/cdsnotes-user >> "$T/cds-skills/manifest.txt"
bash "$T/cds-skills/uninstall.sh" >/dev/null 2>&1 || fail "uninstall (tampered)"
check_tamper uninstall

# ---------- settings.json mode preserved ----------
if [ "$HAVE_JQ" = 1 ]; then
  new_home
  printf '{"theme":"dark"}\n' > "$T/settings.json"; chmod 644 "$T/settings.json"
  run_install >/dev/null 2>&1
  assert_eq "$(ls -l "$T/settings.json" | cut -c1-10)" "-rw-r--r--" "settings.json mode"
fi

echo "PASS: all cds-skills install tests"
