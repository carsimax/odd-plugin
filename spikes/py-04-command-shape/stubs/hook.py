"""Throwaway hook stub: reads hook JSON on stdin, prints a valid hook JSON response."""
import json, sys

event = sys.argv[1] if len(sys.argv) > 1 else ""
payload = json.load(sys.stdin)
assert payload.get("hook_event_name") == event, (payload.get("hook_event_name"), event)
print(json.dumps({"hookSpecificOutput": {"hookEventName": event, "additionalContext": "py-04 stub ok"}}))
