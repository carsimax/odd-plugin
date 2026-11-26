#!/bin/sh
# Tests for scripts/install.sh. Runs it with a temp HOME and fake gh/node/uname first on PATH.
# Usage: sh scripts/tests/install.test.sh
set -u

HERE=$(cd "$(dirname "$0")" && pwd)
INSTALL="$HERE/../install.sh"
ROOT=$(mktemp -d)
trap 'rm -rf "$ROOT"' EXIT INT TERM
PASS=0
FAIL=0
ZEROS=0000000000000000000000000000000000000000000000000000000000000000

# Real tools the script may use, linked into one dir so `gh` (and others) can be absent from PATH.
TOOLS="$ROOT/tools"
mkdir -p "$TOOLS"
for t in sh mktemp mkdir mv cp rm chmod cat sed awk grep tr cut head dirname basename uname id sha256sum shasum cmp wc ln ls; do
  p=$(command -v "$t" 2>/dev/null || true)
  case "$p" in /*) ln -sf "$p" "$TOOLS/$t" ;; esac
done

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

# new_case: fresh HOME + stub dir with fakes; sets H, STUB, LOG, FIX, BIN_DIR, ODD_HOME.
new_case() {
  CASE=$(mktemp -d "$ROOT/case.XXXXXX")
  H="$CASE/home"; STUB="$CASE/stub"; FIX="$CASE/fixtures"; LOG="$CASE/log"
  mkdir -p "$H" "$STUB" "$FIX"
  : > "$LOG"
  BIN_DIR="$H/.local/bin"; ODD_HOME="$H/.odd-claude"
  printf '// fake bundle\n' > "$FIX/odd-claude.mjs"
  printf '%s  odd-claude.mjs\n%s  odd-claude-payload-9.9.9.tar.gz\n' "$(sha256_of "$FIX/odd-claude.mjs")" "$ZEROS" > "$FIX/checksums.txt"
  cat > "$STUB/gh" <<'GH'
#!/bin/sh
echo "gh $*" >> "$FAKE_LOG"
case "$1 $2" in
  "auth status") exit "${FAKE_GH_AUTH:-0}" ;;
  "release view") echo "v9.9.9"; exit 0 ;;
  "release download")
    dir=""; shift 2
    while [ $# -gt 0 ]; do case "$1" in --dir) dir="$2"; shift ;; esac; shift; done
    cp "$FAKE_FIXTURES/odd-claude.mjs" "$FAKE_FIXTURES/checksums.txt" "$dir/"; exit 0 ;;
esac
exit 1
GH
  cat > "$STUB/node" <<'NODE'
#!/bin/sh
case "$1" in
  -p|-e|--version|-v) echo "${FAKE_NODE_MAJOR:-22}"; exit 0 ;;
esac
echo "node $*" >> "$FAKE_LOG"
exit 0
NODE
  chmod +x "$STUB/gh" "$STUB/node"
}

# run_install [args...]: stdout+stderr in $OUT, status in $RC.
run_install() {
  OUT=$(HOME="$H" PATH="$STUB:$TOOLS" FAKE_LOG="$LOG" FAKE_FIXTURES="$FIX" \
    ODD_CLAUDE_HOME="$ODD_HOME" ODD_CLAUDE_BIN_DIR="$BIN_DIR" ODD_CLAUDE_REPO="${REPO_ENV:-}" \
    "$TOOLS/sh" "$INSTALL" "$@" 2>&1 </dev/null)
  RC=$?
}

ok() { PASS=$((PASS + 1)); }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL: %s\n' "$1"; printf '  rc=%s output: %s\n' "${RC:-?}" "${OUT:-}"; }
check() { # check <desc> <command...>
  desc=$1; shift
  if "$@"; then ok; else bad "$desc"; fi
}
has() { printf '%s' "$OUT" | grep -q -- "$1"; }
logged() { grep -q -- "$1" "$LOG"; }
not_logged() { ! grep -q -- "$1" "$LOG"; }
nonzero() { [ "$RC" -ne 0 ]; }
nothing_installed() { [ ! -e "$ODD_HOME/bin/odd-claude.mjs" ] && [ ! -e "$BIN_DIR/odd-claude" ]; }
no_staging_left() { [ ! -d "$ODD_HOME/bin" ] || [ -z "$(ls -A "$ODD_HOME/bin")" ]; }
no_claude_dir() { [ ! -e "$H/.claude" ]; }
launcher_ok() { [ "$(cat "$BIN_DIR/odd-claude")" = "$(printf '#!/bin/sh\nexec node "%s/bin/odd-claude.mjs" "$@"' "$ODD_HOME")" ]; }

# 1. old node refused
new_case; FAKE_NODE_MAJOR=20; export FAKE_NODE_MAJOR
run_install --no-run
check "old node exits non-zero" nonzero
check "old node message names >= 22" has '>= 22'
check "old node installs nothing" nothing_installed
unset FAKE_NODE_MAJOR

# 2. missing node
new_case; rm "$STUB/node"
run_install --no-run
check "missing node exits non-zero" nonzero
check "missing node message" has 'node'
check "missing node installs nothing" nothing_installed

# 3. missing gh
new_case; rm "$STUB/gh"
run_install --no-run
check "missing gh exits non-zero" nonzero
check "missing gh message" has 'gh'
check "missing gh installs nothing" nothing_installed

# 4. unauthenticated gh
new_case; FAKE_GH_AUTH=1; export FAKE_GH_AUTH
run_install --no-run
check "unauthenticated gh exits non-zero" nonzero
check "unauthenticated gh says gh auth login" has 'gh auth login'
check "unauthenticated gh downloads nothing" not_logged 'release download'
unset FAKE_GH_AUTH

# 5. unsupported platform
new_case
printf '#!/bin/sh\necho FreeBSD\n' > "$STUB/uname"; chmod +x "$STUB/uname"
run_install --no-run
check "unsupported platform exits non-zero" nonzero
check "unsupported platform message" has 'macOS'

# 6. checksum mismatch fails closed
new_case
printf '1111111111111111111111111111111111111111111111111111111111111111  odd-claude.mjs\n' > "$FIX/checksums.txt"
run_install --no-run
check "mismatch exits non-zero" nonzero
check "mismatch message" has 'hecksum'
check "mismatch installs nothing" nothing_installed
check "mismatch leaves no staging file" no_staging_left

# 7. missing checksum entry fails closed
new_case
printf '1111111111111111111111111111111111111111111111111111111111111111  something-else.tar.gz\n' > "$FIX/checksums.txt"
run_install --no-run
check "missing entry exits non-zero" nonzero
check "missing entry installs nothing" nothing_installed

# 8. success: bundle + launcher, latest resolved, never touches ~/.claude, --no-run does not exec
new_case
run_install --no-run
check "success exits 0" [ "$RC" -eq 0 ]
check "bundle installed" cmp -s "$FIX/odd-claude.mjs" "$ODD_HOME/bin/odd-claude.mjs"
check "launcher executable" [ -x "$BIN_DIR/odd-claude" ]
check "launcher content" launcher_ok
check "latest resolved via gh release view" logged 'release view --repo carsimax/odd-plugin --json tagName -q .tagName'
check "downloaded the latest tag" logged 'release download v9.9.9'
check "--no-run does not exec the bundle" not_logged '^node '
check "does not touch ~/.claude" no_claude_dir
check "warns when bin dir is not on PATH" has 'not on your PATH'

# 9. launcher is exec'd with the remaining args
new_case
run_install status --json
check "run exits 0" [ "$RC" -eq 0 ]
check "launcher execs node with bundle and args" logged "node $ODD_HOME/bin/odd-claude.mjs status --json"

# 10. --version pins the tag (with or without v); --repo and ODD_CLAUDE_REPO override
new_case
run_install --version 1.2.3 --no-run
check "--version pins tag" logged 'release download v1.2.3 --repo carsimax/odd-plugin'
check "--version skips release view" not_logged 'release view'
new_case
run_install --version v1.2.3 --repo someone/fork --no-run
check "--repo overrides the repository" logged 'release download v1.2.3 --repo someone/fork'
new_case; REPO_ENV=env/repo
run_install --version 1.2.3 --no-run
check "ODD_CLAUDE_REPO overrides the default" logged 'release download v1.2.3 --repo env/repo'
REPO_ENV=

# 11. re-install replaces the bundle
new_case
run_install --no-run
printf '// newer\n' > "$FIX/odd-claude.mjs"
printf '%s  odd-claude.mjs\n' "$(sha256_of "$FIX/odd-claude.mjs")" > "$FIX/checksums.txt"
run_install --no-run
check "re-install replaces the bundle" cmp -s "$FIX/odd-claude.mjs" "$ODD_HOME/bin/odd-claude.mjs"

# 12. --help and a flag missing its value
new_case
run_install --help
check "--help exits 0" [ "$RC" -eq 0 ]
check "--help lists flags" has '--no-run'
check "--help installs nothing" nothing_installed
run_install --version
check "--version without a value fails" nonzero

printf '%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
