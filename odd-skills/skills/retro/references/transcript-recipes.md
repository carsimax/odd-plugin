# Transcript recipes

Transcripts are JSONL, one record per line, under `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects/<project-dir>/<session-id>.jsonl`. `<project-dir>` is the absolute working directory with every `/` and `.` replaced by `-`. Subagent transcripts, when present, sit in a `subagents/` folder beside or under it.

Set `T` to the transcript path. Default to the most recently modified one for the project (the current session is the newest):

```sh
D="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects/$(pwd | tr '/.' '--')"
T=$(find "$D" -maxdepth 1 -name '*.jsonl' -exec stat -f '%m %N' {} + 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2-)
# GNU stat (Linux): replace `stat -f '%m %N'` with `stat -c '%Y %n'`
wc -lc "$T"
```

Record shapes used below: `.type` is `user` or `assistant`; `.message.content` is a string or an array of blocks (`text`, `tool_use` with `.name`/`.input`, `tool_result` with `.is_error`); `.isMeta == true` marks injected reminders, not human input.

## Human messages (with absolute line numbers)

```sh
jq -c --slurp 'to_entries[] | select(.value.type=="user" and (.value.isMeta|not)) | {line:(.key+1), text:(.value.message.content | if type=="string" then . else ([.[]? | select(.type=="text") | .text] | join(" ")) end)} | select(.text != "")' "$T" | cut -c1-300
```

Drop rows whose text starts with `<system-reminder>`, `<command-` or `<local-command`, `<task-notification` (injected, not typed).

## Tool-call counts and errors

```sh
jq -r 'select(.type=="assistant") | .message.content[]? | select(.type=="tool_use") | .name' "$T" | sort | uniq -c | sort -rn
jq -c --slurp 'to_entries[] | select(.value.type=="user") | {line:(.key+1), err:[.value.message.content | arrays | .[] | select(.type=="tool_result" and .is_error==true) | (.content|tostring)[0:200]]} | select(.err|length>0)' "$T"
```

## Repeated work

```sh
# files read or edited, with counts (3+ reads, 2+ edits are findings)
jq -r 'select(.type=="assistant") | .message.content[]? | select(.type=="tool_use" and (.name=="Read" or .name=="Edit" or .name=="Write")) | "\(.name) \(.input.file_path)"' "$T" | sort | uniq -c | sort -rn | head -20
# repeated shell commands
jq -r 'select(.type=="assistant") | .message.content[]? | select(.type=="tool_use" and .name=="Bash") | .input.command[0:120]' "$T" | sort | uniq -c | sort -rn | head -10
```

## Agent launches, edits before the feature document

```sh
jq -c --slurp 'to_entries[] | select(.value.type=="assistant") | .key as $k | .value.message.content[]? | select(.type=="tool_use" and .name=="Agent") | {line:($k+1), type:.input.subagent_type, model:.input.model, prompt:(.input.prompt|tostring[0:160])}' "$T"
# line of each write/edit, to compare against the first write of odd/tasks/<feature>.md
jq -c --slurp 'to_entries[] | .key as $k | select(.value.type=="assistant") | .value.message.content[]? | select(.type=="tool_use" and (.name=="Edit" or .name=="Write")) | {line:($k+1), file:.input.file_path}' "$T"
```

## Cost proxy

```sh
jq -s '[.[] | select(.type=="assistant") | .message.usage | select(.) | (.input_tokens + .output_tokens)] | {turns:length, tokens:add}' "$T"
```

Cost and time come only from these counts; for a transcript path the human gives, there is nothing else.
