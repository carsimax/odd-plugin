#!/bin/sh
# odd-skills installer. Installs the payload next to this script into a Claude config dir.
# Usage: install.sh --target <config-dir> [--uninstall] [--dry-run] [--i-know-this-is-my-real-config]
# Only ever writes inside <config-dir>.

BEGIN_MARK='<!-- odd-skills:begin -->'
END_MARK='<!-- odd-skills:end -->'

usage() {
  cat >&2 <<USAGE
Usage: install.sh --target <config-dir> [--uninstall] [--dry-run] [--i-know-this-is-my-real-config]
  --target <dir>   REQUIRED. Claude config dir to install into (no default).
  --uninstall      Remove what a previous install added (needs the manifest).
  --dry-run        Print every planned action, change nothing.
  --i-know-this-is-my-real-config
                   Required to target \$HOME/.claude.
USAGE
}
die() { printf 'install.sh: %s\n' "$*" >&2; exit 1; }

TARGET=
UNINSTALL=0
DRY=0
REAL_OK=0
while [ $# -gt 0 ]; do
  case $1 in
    --target) [ $# -ge 2 ] || die "--target needs a value"; TARGET=$2; shift 2 ;;
    --target=*) TARGET=${1#--target=}; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    --dry-run) DRY=1; shift ;;
    --i-know-this-is-my-real-config) REAL_OK=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage; die "unknown argument: $1" ;;
  esac
done
if [ -z "$TARGET" ]; then
  usage
  die "--target is required (there is no default config dir)"
fi

# Resolve a path physically, even when it does not exist yet (nearest existing ancestor).
resolve() {
  _p=$1
  case $_p in /*) ;; *) _p=$PWD/$_p ;; esac
  _rest=
  while [ ! -d "$_p" ]; do
    _rest=/$(basename "$_p")$_rest
    _p=$(dirname "$_p")
  done
  _base=$(cd "$_p" && pwd -P) || return 1
  [ "$_base" = / ] && _base=
  printf '%s%s\n' "$_base" "$_rest"
}

TARGET=$(resolve "$TARGET") || die "cannot resolve target"
[ -n "$TARGET" ] || die "refusing to use / as target"
if [ -n "${HOME:-}" ]; then
  REAL=$(resolve "$HOME/.claude")
  if [ "$TARGET" = "$REAL" ] && [ "$REAL_OK" -ne 1 ]; then
    die "target resolves to your real config dir ($REAL). Pass --i-know-this-is-my-real-config to proceed."
  fi
fi

SRC=$(cd "$(dirname "$0")" && pwd -P)
ODD=$TARGET/odd-skills
MANIFEST=$ODD/manifest.txt
GUARD_DEST=$ODD/hooks/guard.sh
PRE_SETTINGS=$ODD/settings.pre-install.json
ABSENT_SETTINGS=$ODD/settings.absent
BACKUP_ROOT=$TARGET/.odd-skills-backup
BACKUP=

TMPD=$(mktemp -d) || die "cannot create temp dir"
trap 'rm -rf "$TMPD"' EXIT INT TERM

say() { if [ "$DRY" -eq 1 ]; then printf '[dry-run] would: %s\n' "$*"; else printf '%s\n' "$*"; fi; }
# act "<description>": announce; true only when the action should really run.
act() { say "$*"; [ "$DRY" -eq 0 ]; }

backup_path() { # backup_path <relative path under target>
  [ -e "$TARGET/$1" ] || return 0
  if [ -z "$BACKUP" ]; then
    _ts=$(date +%Y%m%dT%H%M%S); BACKUP=$BACKUP_ROOT/$_ts; _n=1
    while [ -e "$BACKUP" ]; do BACKUP=$BACKUP_ROOT/$_ts-$_n; _n=$((_n + 1)); done
  fi
  if act "back up $1 -> $BACKUP/$1"; then
    mkdir -p "$BACKUP/$(dirname "$1")" && cp -R "$TARGET/$1" "$BACKUP/$1" || die "backup of $1 failed"
  fi
}

# jq filter: remove our hook entry (command == $cmd) and any containers it leaves empty.
STRIP='
  if (.hooks.PreToolUse | type) == "array" then
    .hooks.PreToolUse |= map(
      if (.hooks | type) == "array" then
        (.hooks | map(select(.command != $cmd))) as $k
        | if ($k | length) == (.hooks | length) then .
          elif ($k | length) == 0 then empty
          else .hooks = $k end
      else . end)
    | if (.hooks.PreToolUse | length) == 0 then del(.hooks.PreToolUse) else . end
    | if (.hooks | length) == 0 then del(.hooks) else . end
  else . end'

has_markers() { grep -qxF "$BEGIN_MARK" "$1" && grep -qxF "$END_MARK" "$1"; }
manifest_safe() { case $1 in /*|*..*|'') return 1 ;; esac; return 0; }

# ---------------------------------------------------------------- uninstall
if [ "$UNINSTALL" -eq 1 ]; then
  [ -f "$MANIFEST" ] || die "no manifest at $MANIFEST: nothing to uninstall (was odd-skills installed into this target?)"
  say "uninstall odd-skills from $TARGET"
  SETTINGS=$TARGET/settings.json
  NEW_SETTINGS=
  if [ -f "$SETTINGS" ]; then
    command -v jq >/dev/null 2>&1 || die "jq is required to remove the hook entry from settings.json"
    jq --arg cmd "$GUARD_DEST" "$STRIP" "$SETTINGS" >"$TMPD/settings.new" || die "settings.json is not valid JSON; aborting before any change"
    NEW_SETTINGS=$TMPD/settings.new
  fi
  CLAUDE=$TARGET/CLAUDE.md
  if [ -f "$CLAUDE" ] && grep -qxF "$BEGIN_MARK" "$CLAUDE" && ! has_markers "$CLAUDE"; then
    die "CLAUDE.md has a begin marker without an end marker; fix it by hand first"
  fi

  HAD_PRE=0; HAD_ABSENT=0
  [ -f "$PRE_SETTINGS" ] && HAD_PRE=1
  [ -f "$ABSENT_SETTINGS" ] && HAD_ABSENT=1
  [ "$HAD_PRE" -eq 1 ] && cp "$PRE_SETTINGS" "$TMPD/pre.json"
  while IFS= read -r rel; do
    manifest_safe "$rel" || { say "skip unsafe manifest entry: $rel"; continue; }
    if [ -e "$TARGET/$rel" ]; then act "remove $rel" && rm -rf "${TARGET:?}/$rel"; fi
  done <"$MANIFEST"

  if [ -f "$CLAUDE" ] && has_markers "$CLAUDE"; then
    backup_path CLAUDE.md
    awk -v b="$BEGIN_MARK" -v e="$END_MARK" '
      $0 == b { inb = 1; held = 0; next }
      inb { if ($0 == e) inb = 0; next }
      { if (held) print ""; held = 0; if ($0 == "") { held = 1; next } print }
      END { if (held) print "" }' "$CLAUDE" >"$TMPD/claude.new"
    if [ -s "$TMPD/claude.new" ]; then
      act "remove odd-skills block from CLAUDE.md" && cat "$TMPD/claude.new" >"$CLAUDE"
    else
      act "remove CLAUDE.md (only held the odd-skills block)" && rm -f "$CLAUDE"
    fi
  fi

  if [ -n "$NEW_SETTINGS" ]; then
    backup_path settings.json
    if [ "$HAD_PRE" -eq 1 ] && [ "$(jq -S . "$TMPD/pre.json" 2>/dev/null)" = "$(jq -S . "$NEW_SETTINGS")" ]; then
      act "restore settings.json (hook entry removed, original formatting)" && cat "$TMPD/pre.json" >"$SETTINGS"
    elif [ "$HAD_ABSENT" -eq 1 ] && [ "$(jq -c . "$NEW_SETTINGS")" = '{}' ]; then
      act "remove settings.json (created by the installer, now empty)" && rm -f "$SETTINGS"
    else
      act "remove odd-skills hook entry from settings.json" && cat "$NEW_SETTINGS" >"$SETTINGS"
    fi
  fi

  if act "remove manifest and installer state"; then
    rm -f "$MANIFEST" "$PRE_SETTINGS" "$ABSENT_SETTINGS"
    rmdir "$ODD/hooks" "$ODD" 2>/dev/null
  fi
  say "done. Backups (if any) stay in $BACKUP_ROOT"
  exit 0
fi

# ------------------------------------------------------------------ install
command -v jq >/dev/null 2>&1 || die "jq is required to merge the hook into settings.json; install jq and retry"
[ -d "$SRC/skills" ] || [ -d "$SRC/agents" ] || [ -f "$SRC/CLAUDE.md" ] || die "nothing to install under $SRC"

SETTINGS=$TARGET/settings.json
CLAUDE=$TARGET/CLAUDE.md

# Validate and precompute everything before the first write.
if [ -f "$SETTINGS" ]; then
  jq -e 'type == "object"' "$SETTINGS" >/dev/null 2>&1 || die "$SETTINGS is not a valid JSON object; aborting before any change"
  BASE=$SETTINGS
else
  printf '{}\n' >"$TMPD/empty.json"; BASE=$TMPD/empty.json
fi
jq --arg cmd "$GUARD_DEST" "($STRIP)
  | .hooks = (.hooks // {})
  | .hooks.PreToolUse = ((.hooks.PreToolUse // []) + [{matcher: \"Bash\", hooks: [{type: \"command\", command: \$cmd}]}])" \
  "$BASE" >"$TMPD/settings.new" || die "could not merge the hook into settings.json"

if [ -f "$SRC/CLAUDE.md" ]; then
  { printf '%s\n' "$BEGIN_MARK"; cat "$SRC/CLAUDE.md"
    [ -n "$(tail -c1 "$SRC/CLAUDE.md")" ] && printf '\n'
    printf '%s\n' "$END_MARK"; } >"$TMPD/block"
  if [ -f "$CLAUDE" ] && grep -qxF "$BEGIN_MARK" "$CLAUDE" && ! has_markers "$CLAUDE"; then
    die "CLAUDE.md has a begin marker without an end marker; fix it by hand first"
  fi
fi

say "install odd-skills from $SRC into $TARGET"
if act "create $TARGET and $ODD"; then mkdir -p "$ODD/hooks" || die "cannot create $ODD"; fi

OLD=$TMPD/old-manifest
if [ -f "$MANIFEST" ]; then cat "$MANIFEST" >"$OLD"; else : >"$OLD"; fi
NEWLIST=$TMPD/new-manifest
: >"$NEWLIST"

copy_item() { # copy_item <relative dest> <source path>
  rel=$1; from=$2
  if [ -e "$TARGET/$rel" ] && ! grep -qxF "$rel" "$OLD"; then
    say "existing $rel was not installed by odd-skills; it will be backed up before overwrite"
    backup_path "$rel"
  fi
  if act "copy $rel"; then
    mkdir -p "$(dirname "$TARGET/$rel")" && rm -rf "${TARGET:?}/$rel" && cp -R "$from" "$TARGET/$rel" || die "copy of $rel failed"
  fi
  printf '%s\n' "$rel" >>"$NEWLIST"
}

if [ -d "$SRC/skills" ]; then
  for d in "$SRC"/skills/*/; do
    [ -d "$d" ] || continue
    n=$(basename "$d"); copy_item "skills/$n" "$SRC/skills/$n"
  done
fi
if [ -d "$SRC/agents" ]; then
  for f in "$SRC"/agents/*.md; do
    [ -f "$f" ] || continue
    n=$(basename "$f"); copy_item "agents/$n" "$f"
  done
fi
if [ -f "$SRC/hooks/guard.sh" ]; then
  if act "copy odd-skills/hooks/guard.sh"; then
    mkdir -p "$ODD/hooks" && cp "$SRC/hooks/guard.sh" "$GUARD_DEST" && chmod +x "$GUARD_DEST" || die "copy of guard failed"
  fi
  printf '%s\n' "odd-skills/hooks/guard.sh" >>"$NEWLIST"
else
  say "warning: $SRC/hooks/guard.sh missing; hook will point at a file that does not exist"
fi

if [ -f "$SRC/CLAUDE.md" ]; then
  backup_path CLAUDE.md
  if [ -f "$CLAUDE" ] && has_markers "$CLAUDE"; then
    if act "replace odd-skills block in CLAUDE.md in place"; then
      awk -v b="$BEGIN_MARK" -v e="$END_MARK" -v bf="$TMPD/block" '
        $0 == b { while ((getline l < bf) > 0) print l; close(bf); inb = 1; next }
        inb { if ($0 == e) inb = 0; next }
        { print }' "$CLAUDE" >"$TMPD/claude.new" && cat "$TMPD/claude.new" >"$CLAUDE"
    fi
  else
    if act "append odd-skills block to CLAUDE.md"; then
      { if [ -f "$CLAUDE" ]; then
          cat "$CLAUDE"
          [ -n "$(tail -c1 "$CLAUDE")" ] && printf '\n'
          [ -s "$CLAUDE" ] && printf '\n'
        fi
        cat "$TMPD/block"; } >"$TMPD/claude.new" && cat "$TMPD/claude.new" >"$CLAUDE"
    fi
  fi
fi

# Remember the pristine settings.json once, so uninstall can restore exact bytes.
if [ ! -f "$PRE_SETTINGS" ] && [ ! -f "$ABSENT_SETTINGS" ]; then
  if [ -f "$SETTINGS" ]; then
    if act "save original settings.json to odd-skills/settings.pre-install.json"; then cp "$SETTINGS" "$PRE_SETTINGS"; fi
    printf '%s\n' "odd-skills/settings.pre-install.json" >>"$NEWLIST"
  else
    if act "note that settings.json did not exist"; then : >"$ABSENT_SETTINGS"; fi
    printf '%s\n' "odd-skills/settings.absent" >>"$NEWLIST"
  fi
fi
backup_path settings.json
if act "register PreToolUse(Bash) hook -> $GUARD_DEST in settings.json"; then
  cat "$TMPD/settings.new" >"$SETTINGS"
fi

if act "write manifest $MANIFEST"; then
  cat "$OLD" "$NEWLIST" | sort -u >"$MANIFEST"
fi
say "done."
[ -n "$BACKUP" ] && [ "$DRY" -eq 0 ] && say "backups in $BACKUP"
exit 0
