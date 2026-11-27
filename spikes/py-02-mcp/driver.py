# /// script
# requires-python = ">=3.14"
# dependencies = ["mcp"]
# ///
"""Pipes JSON-RPC lines to server.py and prints what comes back (stdout JSON lines, truncated; stderr tail)."""
import json, subprocess, sys, time
from pathlib import Path

SERVER = [sys.executable, str(Path(__file__).with_name("server.py"))]
INIT = lambda v, i=1: {"jsonrpc": "2.0", "id": i, "method": "initialize", "params": {"protocolVersion": v, "capabilities": {}, "clientInfo": {"name": "d", "version": "1"}}}
INITED = {"jsonrpc": "2.0", "method": "notifications/initialized"}


def run(lines, wait=1.5, close=True):
    p = subprocess.Popen(SERVER, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        for l in lines:
            p.stdin.write(l if isinstance(l, bytes) else (json.dumps(l) + "\n").encode())
            p.stdin.flush()
            time.sleep(0.3)
        time.sleep(wait)
        if close:
            p.stdin.close()
        try:
            p.wait(timeout=8)
        except subprocess.TimeoutExpired:
            p.kill()
        out, err = p.stdout.read().decode(), p.stderr.read().decode()
    except BrokenPipeError:
        out, err = p.stdout.read().decode(), p.stderr.read().decode()
    return [(json.loads(x) if x.startswith("{") else x) for x in out.splitlines()], err, p.returncode


def show(title, lines, **kw):
    out, err, rc = run(lines, **kw)
    print(f"== {title} (exit={rc})")
    for o in out:
        s = json.dumps(o)
        print("  <-", s[:300] + ("..." if len(s) > 300 else ""))
    tail = [l for l in err.splitlines() if l.strip()][-3:]
    for l in tail:
        print("  err:", l[:200])


for v in ["2025-06-18", "2025-03-26", "2024-11-05", "1999-01-01"]:
    show(f"initialize {v}", [INIT(v)])
ready = [INIT("2025-06-18"), INITED]
show("cancel in-flight slow tool", ready + [
    {"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "slow", "arguments": {}}},
    {"jsonrpc": "2.0", "method": "notifications/cancelled", "params": {"requestId": 2}}], wait=4)
show("unknown method", ready + [{"jsonrpc": "2.0", "id": 3, "method": "resources/nope"}])
show("invalid params: tools/call without name", ready + [{"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {}}])
show("invalid params: wrong argument type", ready + [{"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {"name": "add", "arguments": {"a": "x", "b": 1}}}])
show("invalid params: unknown tool", ready + [{"jsonrpc": "2.0", "id": 6, "method": "tools/call", "params": {"name": "nope"}}])
show("malformed JSON", ready + [b"{not json\n", {"jsonrpc": "2.0", "id": 7, "method": "ping"}])
big = b'{"jsonrpc":"2.0","id":8,"method":"ping","params":{"pad":"' + b"a" * (4 * 1024 * 1024 + 10) + b'"}}\n'
show(">4 MiB line then ping", ready + [big, {"jsonrpc": "2.0", "id": 9, "method": "ping"}], wait=3)
