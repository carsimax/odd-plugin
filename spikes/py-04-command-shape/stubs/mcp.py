"""Throwaway MCP stdio stub: answers only `initialize` (newline-delimited JSON-RPC), exits on EOF."""
import json, sys

for line in sys.stdin:
    req = json.loads(line)
    if req.get("method") == "initialize":
        res = {"protocolVersion": req["params"]["protocolVersion"], "capabilities": {}, "serverInfo": {"name": "py-04-stub", "version": "0"}}
        print(json.dumps({"jsonrpc": "2.0", "id": req["id"], "result": res}), flush=True)
