#!/bin/sh
# odd-claude bootstrap: installs the release bundle and a launcher, then runs it.
#   curl -fsSL <raw-url>/scripts/install.sh | sh        (needs node >= 22 and an authenticated gh: the repo is private)
#   sh scripts/install.sh [--version <v>] [--repo <owner/name>] [--no-run] [--help] [-- <odd-claude args>]
# It never touches ~/.claude; the bundle (odd-claude.mjs) does that.
set -eu

DEFAULT_REPO="carsimax/odd-plugin"
REPO="${ODD_CLAUDE_REPO:-$DEFAULT_REPO}"
HOME_DIR="${ODD_CLAUDE_HOME:-$HOME/.odd-claude}"
BIN_DIR="${ODD_CLAUDE_BIN_DIR:-$HOME/.local/bin}"
VERSION=""
RUN=1

die() { printf 'odd-claude install: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: install.sh [options] [-- odd-claude args]

  --version <v>      install release v<v> (default: latest)
  --repo <o/n>       GitHub repository (default: carsimax/odd-plugin, or $ODD_CLAUDE_REPO)
  --no-run           install only; do not start odd-claude afterwards
  --help             show this help

Any other argument is passed to odd-claude (for example `status` or `install --yes`).
With no arguments odd-claude starts its interactive TUI.
Environment: ODD_CLAUDE_HOME (default ~/.odd-claude), ODD_CLAUDE_BIN_DIR (default ~/.local/bin).
Requires node >= 22 and an authenticated gh (run `gh auth login`).
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --version) [ $# -ge 2 ] || die "--version needs a value"; VERSION="$2"; shift 2 ;;
    --repo) [ $# -ge 2 ] || die "--repo needs a value"; REPO="$2"; shift 2 ;;
    --no-run) RUN=0; shift ;;
    --help|-h) usage; exit 0 ;;
    --) shift; break ;;
    *) break ;;
  esac
done

case "$(uname -s)" in
  Darwin|Linux) ;;
  *) die "unsupported platform $(uname -s); only macOS and Linux are supported" ;;
esac

command -v node >/dev/null 2>&1 || die "node is required (>= 22). Install it from https://nodejs.org and retry."
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)
case "$NODE_MAJOR" in
  ''|*[!0-9]*) die "could not determine the node version; node >= 22 is required" ;;
esac
[ "$NODE_MAJOR" -ge 22 ] || die "node >= 22 is required (found $NODE_MAJOR). Upgrade node and retry."

command -v gh >/dev/null 2>&1 || die "gh (GitHub CLI) is required because the repository is private. Install it from https://cli.github.com, then run: gh auth login"
gh auth status >/dev/null 2>&1 || die "gh is not authenticated. Run: gh auth login"

case "$REPO" in
  */*) ;;
  *) die "invalid repository '$REPO' (expected owner/name)" ;;
esac
case "$HOME_DIR$BIN_DIR" in
  *[\"\$\`\\]*) die "ODD_CLAUDE_HOME and ODD_CLAUDE_BIN_DIR must not contain quotes, \$, backticks or backslashes" ;;
esac

if [ -n "$VERSION" ]; then
  TAG="v${VERSION#v}"
else
  TAG=$(gh release view --repo "$REPO" --json tagName -q .tagName) || die "could not resolve the latest release of $REPO"
  [ -n "$TAG" ] || die "no release found in $REPO"
fi

TMP=$(mktemp -d)
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT INT TERM

printf 'Downloading odd-claude %s from %s\n' "$TAG" "$REPO"
gh release download "$TAG" --repo "$REPO" --dir "$TMP" --pattern odd-claude.mjs --pattern checksums.txt \
  || die "download of $TAG failed"
[ -f "$TMP/odd-claude.mjs" ] || die "release $TAG has no odd-claude.mjs"
[ -f "$TMP/checksums.txt" ] || die "release $TAG has no checksums.txt"

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  else die "sha256sum or shasum is required to verify the download"
  fi
}

EXPECTED=$(awk '$2 == "odd-claude.mjs" || $2 == "*odd-claude.mjs" { print $1; exit }' "$TMP/checksums.txt")
[ -n "$EXPECTED" ] || die "checksums.txt has no entry for odd-claude.mjs; refusing to install"
ACTUAL=$(sha256 "$TMP/odd-claude.mjs")
[ "$ACTUAL" = "$EXPECTED" ] || die "checksum mismatch for odd-claude.mjs (expected $EXPECTED, got $ACTUAL); refusing to install"

BUNDLE="$HOME_DIR/bin/odd-claude.mjs"
mkdir -p "$HOME_DIR/bin" "$BIN_DIR"
STAGE="$HOME_DIR/bin/.odd-claude.mjs.$$"
cp "$TMP/odd-claude.mjs" "$STAGE"
chmod 755 "$STAGE"
mv -f "$STAGE" "$BUNDLE"

LAUNCHER="$BIN_DIR/odd-claude"
LSTAGE="$BIN_DIR/.odd-claude.$$"
printf '#!/bin/sh\nexec node "%s" "$@"\n' "$BUNDLE" > "$LSTAGE"
chmod 755 "$LSTAGE"
mv -f "$LSTAGE" "$LAUNCHER"
printf 'Installed %s and %s\n' "$BUNDLE" "$LAUNCHER"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) printf 'warning: %s is not on your PATH. Add it, for example: export PATH="%s:$PATH"\n' "$BIN_DIR" "$BIN_DIR" >&2 ;;
esac

[ "$RUN" -eq 1 ] || exit 0

# Release the temp dir now: exec below skips the EXIT trap.
cleanup
trap - EXIT INT TERM

if [ $# -eq 0 ] && [ ! -t 0 ]; then
  # Piped (curl | sh): the TUI needs a terminal.
  if (: </dev/tty) 2>/dev/null; then
    exec "$LAUNCHER" </dev/tty
  fi
  printf 'No terminal available. Run: %s\n' "$LAUNCHER"
  exit 0
fi
exec "$LAUNCHER" "$@"
