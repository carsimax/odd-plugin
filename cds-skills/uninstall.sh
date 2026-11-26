#!/usr/bin/env bash
# cds-skills uninstaller: removes only what the manifest lists (allowlisted), the CLAUDE.md block
# and outputStyle when it equals "cds". Safe to run twice.
set -euo pipefail

START='<!-- cds:start -->'
END='<!-- cds:end -->'

is_allowed() {
  case "$1" in
    ''|/*|*..*) return 1 ;;
    skills/cds|skills/cds-*|agents/cds-*.md|rules/cds-*.md|output-styles/cds.md) return 0 ;;
    *) return 1 ;;
  esac
}

main() {
  local T="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
  local JQ="${CDS_JQ:-jq}"
  local line removed=0

  if [ -f "$T/cds-skills/manifest.txt" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      if is_allowed "$line" && [ -e "$T/$line" ]; then
        rm -rf "${T:?}/$line"
        removed=$((removed + 1))
      fi
    done < "$T/cds-skills/manifest.txt"
  fi

  # CLAUDE.md block
  local content before rest after ts bk i block_msg="no block found"
  if [ -f "$T/CLAUDE.md" ]; then
    content="$(cat "$T/CLAUDE.md"; printf x)"
    content="${content%x}"
    rest=""
    if [[ "$content" == *"$START"* ]]; then rest="${content#*"$START"}"; fi
    if [[ -n "$rest" && "$rest" == *"$END"* ]]; then
      ts="$(date +%Y%m%d%H%M%S)"
      bk="$T/CLAUDE.md.cds-backup-$ts"
      i=1
      while [ -e "$bk" ]; do bk="$T/CLAUDE.md.cds-backup-$ts-$i"; i=$((i + 1)); done
      cp "$T/CLAUDE.md" "$bk"
      before="${content%%"$START"*}"
      after="${rest#*"$END"}"
      # drop the separator blank line the installer added when the block was appended
      if [[ "$before" == *$'\n\n' && ( -z "$after" || "$after" == $'\n' ) ]]; then
        before="${before%$'\n'}"
        after="${after#$'\n'}"
      fi
      printf '%s' "$before$after" > "$T/CLAUDE.md.cds-tmp"
      cat "$T/CLAUDE.md.cds-tmp" > "$T/CLAUDE.md"
      rm -f "$T/CLAUDE.md.cds-tmp"
      block_msg="block removed (backup: $bk)"
    fi
  fi

  # output style
  local style_msg="outputStyle untouched" tmp
  if [ -f "$T/settings.json" ]; then
    if command -v "$JQ" >/dev/null 2>&1; then
      if "$JQ" -e '.outputStyle == "cds"' "$T/settings.json" >/dev/null 2>&1; then
        tmp="$(mktemp "$T/settings.json.XXXXXX")"
        if "$JQ" 'del(.outputStyle)' "$T/settings.json" > "$tmp"; then
          cat "$tmp" > "$T/settings.json"
          rm -f "$tmp"
          style_msg="outputStyle removed"
        else
          rm -f "$tmp"
          style_msg="could not edit settings.json"
        fi
      fi
    elif grep -Eq '"outputStyle"[[:space:]]*:[[:space:]]*"cds"' "$T/settings.json"; then
      style_msg="jq not found: remove \"outputStyle\": \"cds\" from $T/settings.json by hand, or pick another style with /output-style."
    fi
  fi

  rm -rf "${T:?}/cds-skills"
  echo "cds-skills uninstalled from $T"
  echo "  files removed: $removed"
  echo "  CLAUDE.md: $block_msg"
  echo "  output style: $style_msg"
}

main "$@"
exit
