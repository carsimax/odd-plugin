#!/usr/bin/env bash
# cds-skills installer: skills, agents, rules, CLAUDE.md block and output style.
# Usage: curl -fsSL https://raw.githubusercontent.com/carsimax/odd-plugin/main/cds-skills/install.sh | bash
# Env: CDS_REF (git ref, default main), CLAUDE_CONFIG_DIR (default ~/.claude),
#      CDS_SRC (local payload dir, skips download), CDS_JQ (jq binary).
set -euo pipefail

START='<!-- cds:start -->'
END='<!-- cds:end -->'

# Only these target-relative paths may ever be removed by cds.
is_allowed() {
  case "$1" in
    ''|/*|*..*) return 1 ;;
    skills/cds|skills/cds-*|agents/cds-*.md|rules/cds-*.md|output-styles/cds.md) return 0 ;;
    *) return 1 ;;
  esac
}

WORK=""
main() {
  local T="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
  local JQ="${CDS_JQ:-jq}"
  local P="" UNINSTALL_SRC=""
  trap '[ -z "$WORK" ] || rm -rf "$WORK"' EXIT

  # ---- locate payload ----
  if [ -n "${CDS_SRC:-}" ]; then
    P="$CDS_SRC"
    UNINSTALL_SRC="$CDS_SRC/../uninstall.sh"
  else
    WORK="$(mktemp -d)"
    local url="https://github.com/carsimax/odd-plugin/archive/${CDS_REF:-main}.tar.gz"
    echo "Downloading $url"
    curl -fsSL "$url" -o "$WORK/src.tar.gz" </dev/null || { echo "error: download failed: $url" >&2; exit 1; }
    mkdir "$WORK/x"
    tar -xzf "$WORK/src.tar.gz" -C "$WORK/x" </dev/null
    local d
    for d in "$WORK"/x/*/cds-skills; do
      if [ -d "$d/payload" ]; then P="$d/payload"; UNINSTALL_SRC="$d/uninstall.sh"; fi
    done
  fi
  if [ -z "$P" ] || [ ! -d "$P" ] || [ ! -f "$P/CLAUDE.md" ]; then
    echo "error: cds-skills payload not found (looked for ${P:-cds-skills/payload}); is the ref valid and the repo readable?" >&2
    exit 1
  fi
  if [ ! -f "$UNINSTALL_SRC" ]; then
    echo "error: uninstall.sh not found next to the payload ($UNINSTALL_SRC)" >&2
    exit 1
  fi

  # ---- preflight: settings.json must be valid before anything is written ----
  local have_jq=0
  if command -v "$JQ" >/dev/null 2>&1; then have_jq=1; fi
  if [ "$have_jq" = 1 ] && [ -f "$T/settings.json" ]; then
    if ! "$JQ" -e 'type == "object"' "$T/settings.json" >/dev/null 2>&1; then
      echo "error: $T/settings.json is not a valid JSON object; nothing was changed. Fix it and rerun." >&2
      exit 1
    fi
  fi

  # ---- new manifest ----
  mkdir -p "$T/cds-skills"
  local NEW="$T/cds-skills/manifest.txt.new" e name
  : > "$NEW"
  for e in "$P"/skills/*; do
    [ -d "$e" ] || continue
    name="skills/$(basename "$e")"
    is_allowed "$name" || { echo "error: payload entry not allowed: $name" >&2; rm -f "$NEW"; exit 1; }
    echo "$name" >> "$NEW"
  done
  for e in "$P"/agents/*.md; do
    [ -f "$e" ] || continue
    name="agents/$(basename "$e")"
    is_allowed "$name" || { echo "error: payload entry not allowed: $name" >&2; rm -f "$NEW"; exit 1; }
    echo "$name" >> "$NEW"
  done
  for e in "$P"/rules/*.md; do
    [ -f "$e" ] || continue
    name="rules/$(basename "$e")"
    is_allowed "$name" || { echo "error: payload entry not allowed: $name" >&2; rm -f "$NEW"; exit 1; }
    echo "$name" >> "$NEW"
  done
  if [ -f "$P/output-styles/cds.md" ]; then echo "output-styles/cds.md" >> "$NEW"; fi

  # ---- remove stale entries of the previous manifest ----
  local line
  if [ -f "$T/cds-skills/manifest.txt" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      if ! grep -qxF -- "$line" "$NEW" && is_allowed "$line"; then
        rm -rf "${T:?}/$line"
      fi
    done < "$T/cds-skills/manifest.txt"
  fi

  # ---- copy ----
  mkdir -p "$T/skills" "$T/agents" "$T/rules" "$T/output-styles"
  local n_skills=0 n_agents=0 n_rules=0
  while IFS= read -r line; do
    case "$line" in
      skills/*) rm -rf "${T:?}/$line"; cp -R "$P/$line" "$T/skills/"; n_skills=$((n_skills + 1)) ;;
      agents/*) cp "$P/$line" "$T/agents/"; n_agents=$((n_agents + 1)) ;;
      rules/*) cp "$P/$line" "$T/rules/"; n_rules=$((n_rules + 1)) ;;
      output-styles/*) cp "$P/$line" "$T/output-styles/" ;;
    esac
  done < "$NEW"
  cp "$UNINSTALL_SRC" "$T/cds-skills/uninstall.sh"
  chmod +x "$T/cds-skills/uninstall.sh"
  mv "$NEW" "$T/cds-skills/manifest.txt"

  # ---- CLAUDE.md block ----
  local block content before rest after status ts bk i
  block="$START"$'\n'"$(cat "$P/CLAUDE.md")"$'\n'"$END"
  if [ -f "$T/CLAUDE.md" ]; then
    ts="$(date +%Y%m%d%H%M%S)"
    bk="$T/CLAUDE.md.cds-backup-$ts"
    i=1
    while [ -e "$bk" ]; do bk="$T/CLAUDE.md.cds-backup-$ts-$i"; i=$((i + 1)); done
    cp "$T/CLAUDE.md" "$bk"
    content="$(cat "$T/CLAUDE.md"; printf x)"
    content="${content%x}"
  else
    content=""
  fi
  rest=""
  if [[ "$content" == *"$START"* ]]; then rest="${content#*"$START"}"; fi
  if [[ -n "$rest" && "$rest" == *"$END"* ]]; then
    before="${content%%"$START"*}"
    after="${rest#*"$END"}"
    printf '%s' "$before$block$after" > "$T/CLAUDE.md.cds-tmp"
    status="block replaced"
  else
    if [ -n "$content" ]; then
      case "$content" in *$'\n') ;; *) content="$content"$'\n' ;; esac
      printf '%s' "$content"$'\n'"$block"$'\n' > "$T/CLAUDE.md.cds-tmp"
      status="block appended"
    else
      printf '%s' "$block"$'\n' > "$T/CLAUDE.md.cds-tmp"
      status="file created"
    fi
  fi
  cat "$T/CLAUDE.md.cds-tmp" > "$T/CLAUDE.md"
  rm -f "$T/CLAUDE.md.cds-tmp"

  # ---- output style ----
  local style_msg tmp
  if [ "$have_jq" = 1 ]; then
    [ -f "$T/settings.json" ] || echo '{}' > "$T/settings.json"
    tmp="$(mktemp "$T/settings.json.XXXXXX")"
    if "$JQ" '.outputStyle = "cds"' "$T/settings.json" > "$tmp"; then
      cat "$tmp" > "$T/settings.json"
      rm -f "$tmp"
      style_msg="outputStyle set to cds in settings.json"
    else
      rm -f "$tmp"
      echo "error: could not update $T/settings.json" >&2
      exit 1
    fi
  else
    style_msg="jq not found: run /output-style cds inside Claude Code to activate the cds output style."
  fi

  echo
  echo "cds-skills installed into $T"
  echo "  skills: $n_skills, agents: $n_agents, rules: $n_rules"
  echo "  CLAUDE.md: $status"
  echo "  output style: $style_msg"
  echo "  uninstall: bash \"$T/cds-skills/uninstall.sh\""
}

main "$@"
exit
