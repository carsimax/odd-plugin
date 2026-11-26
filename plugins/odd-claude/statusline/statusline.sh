#!/bin/bash
# One-line status line: model/effort | context | 5h | 7d | repo branch | +/- | odd version
command -v jq >/dev/null || { echo "statusline: jq is missing"; exit 0; }

IFS=$'\x1f' read -r model effort ctx cwd repo five five_r week week_r < <(
  jq -r '[.model.display_name // "?", (.effort | if type == "object" then .level else . end // ""), (.context_window.used_percentage // "" | tostring),
    .workspace.current_dir // .cwd // "", (.workspace.repo.name // ""),
    (.rate_limits.five_hour.used_percentage // "" | tostring), (.rate_limits.five_hour.resets_at // "" | tostring),
    (.rate_limits.seven_day.used_percentage // "" | tostring), (.rate_limits.seven_day.resets_at // "" | tostring)
  ] | join("\u001f")')

R=$'\e[0m'; D=$'\e[38;5;240m'; SEP=" ${D}│${R} "
col() { # pct -> color by level
  local p=${1%.*}; if [ "$p" -ge 80 ]; then printf '\e[38;5;203m'; elif [ "$p" -ge 50 ]; then printf '\e[38;5;221m'; else printf '\e[38;5;114m'; fi; }
bar() { # pct [marker_pct] -> 10-cell bar
  local p=${1%.*} m=${2:-} n=10 i f c out="" mc=-1
  f=$(( (p * n + 50) / 100 )); [ "$f" -gt "$n" ] && f=$n; c=$(col "$p")
  [ -n "$m" ] && mc=$(( m * n / 100 )); [ "$mc" -ge "$n" ] && mc=$((n-1))
  for ((i=0;i<n;i++)); do
    if [ $i -lt $f ]; then out+="${c}━"
    elif [ $i -eq $mc ]; then out+=$'\e[38;5;203m┃'
    else out+="${D}─"; fi
  done; printf '%s%s' "$out" "$R"; }
fmt() { # epoch format -> date (BSD `date -r`, GNU `date -d @`)
  date -r "$1" "$2" 2>/dev/null || date -d "@$1" "$2" 2>/dev/null; }
rst() { # epoch [day]
  [ -z "$1" ] && return; local d=(x Mon Tue Wed Thu Fri Sat Sun) e=${1%.*}
  if [ "$2" = day ]; then printf '%s %s' "${d[$(fmt "$e" +%u)]}" "$(fmt "$e" '+%d/%m %H:%M')"
  else fmt "$e" +%H:%M; fi; }

# model/effort
out="\e[1;38;5;141m${model}${R}"
[ -n "$effort" ] && out+=" ${D}·${R} \e[38;5;215m${effort}${R}"

# context + autocompact marker (env or settings.json; 95 by default)
ac=${CLAUDE_AUTOCOMPACT_PCT_OVERRIDE:-$(jq -r '.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE // empty' "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json" 2>/dev/null)}
ac=${ac:-95}
if [ -n "$ctx" ]; then out+="${SEP}${D}ctx${R} $(bar "$ctx" "$ac") $(col "$ctx")${ctx%.*}%${R}"
else out+="${SEP}${D}ctx${R} $(bar 0 "$ac") ${D}0%${R}"; fi

# limits (only when present)
[ -n "$five" ] && out+="${SEP}${D}5h${R} $(bar "$five") $(col "$five")${five%.*}%${R} ${D}↻ $(rst "$five_r")${R}"
[ -n "$week" ] && out+="${SEP}${D}7d${R} $(bar "$week") $(col "$week")${week%.*}%${R} ${D}↻ $(rst "$week_r" day)${R}"

# repo + branch + diff
[ -z "$repo" ] && repo=$(basename "$cwd")
out+="${SEP}\e[38;5;117m${repo}${R}"
if br=$(git -C "$cwd" --no-optional-locks branch --show-current 2>/dev/null) && [ -n "$br" ]; then
  out+=" \e[38;5;183m⎇ ${br}${R}"
  read -r a d < <(git -C "$cwd" --no-optional-locks diff HEAD --numstat 2>/dev/null | awk '{a+=$1;d+=$2} END{print a+0, d+0}')
  out+=" \e[38;5;114m+${a:-0}${R}\e[38;5;203m -${d:-0}${R}"
fi

# odd-claude version, read next to the script (<root>/statusline/ -> <root>/package.json); omitted when unreadable
ver=$(jq -r '.version // empty' "$(dirname "$0")/../package.json" 2>/dev/null)
[ -n "$ver" ] && out+="${SEP}${D}odd v${ver}${R}"

printf '%b\n' "$out"
