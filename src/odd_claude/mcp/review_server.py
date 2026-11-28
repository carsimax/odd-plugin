"""Review MCP server (port of v9 mcp/review-server.ts): the plugin's stdio MCP server, `python -m odd_claude.mcp.review_server`.
Minimal JSON-RPC 2.0 / MCP over stdio, newline-delimited, hand-rolled (decision of spikes/py-02-mcp, no SDK):
  initialize, notifications/initialized, ping, tools/list, tools/call, notifications/cancelled.
stdout carries protocol messages only; nothing is written to stderr or sent anywhere else.

Error model (as v9): protocol problems are JSON-RPC errors (-32700 parse, -32600 invalid request, -32601 unknown method, -32602 invalid
params / unknown tool); a tool that runs and refuses, or whose arguments violate its schema, is a normal result with `isError: true` and
a typed body `{error:{code,message,...}}` so the model can read and correct it.

Python port: `ReviewServer.begin(message)` returns the response (or None) at once, or a job producing it (a tool call, registered as in
flight before it returns); `handle(message)` runs that job inline. `ServerOptions` is a dict `{"deps": ToolDeps, "cwd": str}`."""
import json
import os
import signal
import sys
import threading
from typing import Any, BinaryIO, Callable

from ..lib.js import utf16_head
from ..review.consent import plugin_root_dir
from ..review.run import AbortSignal
from ..review.runner import kill_live_reviewers
from .server_core import MAX_LINE_BYTES, SUPPORTED_PROTOCOLS, Response, inflight_key, is_object, rpc_error, serve_lines
from .tools import TOOL_BY_NAME, TOOLS, ToolContext, call_tool, fail

__all__ = ["MAX_LINE_BYTES", "SUPPORTED_PROTOCOLS", "SERVER_NAME", "ReviewServer", "serve", "main"]

SERVER_NAME = "odd-review"

INSTRUCTIONS = (
    "Review tools of odd-claude. Start with review_status and follow only the next_transition it returns. Consent is the human's: review_start relays the question, review_answer_consent records only their explicit answer. Reviewers cost money: acknowledge a forecast before they run. Exception: only a standing consent recorded in the feature document `## Log` (asked once per tracked feature, covering only that feature branch's work-unit commit candidates) lets the parent answer consent and acknowledge forecasts for them, never on your own judgment; otherwise the human answers."
)


def _is_id(v: Any) -> bool:
    return isinstance(v, str) or (isinstance(v, (int, float)) and not isinstance(v, bool))


def server_version() -> str:
    try:
        with open(os.path.join(plugin_root_dir(), "package.json"), encoding="utf-8") as f:
            v = json.load(f).get("version")
        return v if isinstance(v, str) else "0.0.0"
    except Exception:  # noqa: BLE001 - v9 `catch`: the version is cosmetic
        return "0.0.0"


class ReviewServer:
    def __init__(self, opts: dict | None = None):
        self.opts = {} if opts is None else opts
        self._inflight: dict[str, AbortSignal] = {}
        self._lock = threading.Lock()

    def handle(self, message: Any) -> Response | None:
        """Handles one decoded JSON message to completion; None for notifications (nothing to answer)."""
        r = self.begin(message)
        return r() if callable(r) else r

    def begin(self, message: Any) -> Response | None | Callable[[], Response | None]:
        """Answers at once (a response, or None for a notification) or returns the job that produces the response of a tool call."""
        if isinstance(message, list):
            return rpc_error(None, -32600, "batch requests are not supported")
        if not is_object(message) or message.get("jsonrpc") != "2.0" or not isinstance(message.get("method"), str):
            mid = message.get("id") if is_object(message) else None
            return rpc_error(mid if is_object(message) and isinstance(mid, (str, int, float)) and not isinstance(mid, bool) else None, -32600, "invalid request")
        has_id = "id" in message
        mid = message.get("id")
        if has_id and not _is_id(mid):
            return rpc_error(None, -32600, "request id must be a string or a number")
        method = message["method"]
        params = message.get("params")
        if not has_id:
            self._notification(method, params)
            return None
        if method == "initialize":
            asked = params.get("protocolVersion") if is_object(params) and isinstance(params.get("protocolVersion"), str) else None
            version = asked if asked is not None and asked in SUPPORTED_PROTOCOLS else SUPPORTED_PROTOCOLS[0]
            return {"jsonrpc": "2.0", "id": mid, "result": {
                "protocolVersion": version, "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {"name": SERVER_NAME, "version": server_version()}, "instructions": INSTRUCTIONS,
            }}
        if method == "ping":
            return {"jsonrpc": "2.0", "id": mid, "result": {}}
        if method == "tools/list":
            return {"jsonrpc": "2.0", "id": mid, "result": {"tools": [{"name": t.name, "description": t.description, "inputSchema": t.input_schema, "annotations": t.annotations} for t in TOOLS]}}
        if method == "tools/call":
            return self._call_tool(mid, params)
        return rpc_error(mid, -32601, f"method not found: {utf16_head(method, 100)}")

    def _notification(self, method: str, params: Any) -> None:
        if method == "notifications/cancelled" and is_object(params) and _is_id(params.get("requestId")):
            with self._lock:
                signal_ = self._inflight.get(inflight_key(params["requestId"]))
            if signal_ is not None:
                signal_.abort()

    def _call_tool(self, id: Any, params: Any) -> Response | Callable[[], Response]:
        if not is_object(params) or not isinstance(params.get("name"), str):
            return rpc_error(id, -32602, "tools/call needs params.name")
        if "arguments" in params and not is_object(params["arguments"]):
            return rpc_error(id, -32602, "params.arguments must be an object")
        tool = TOOL_BY_NAME.get(params["name"])
        if tool is None:
            return rpc_error(id, -32602, f"unknown tool: {utf16_head(params['name'], 100)}")
        controller = AbortSignal()
        key = inflight_key(id)
        with self._lock:
            if key in self._inflight:
                return rpc_error(id, -32600, "a request with this id is already in flight")
            self._inflight[key] = controller
        arguments = params["arguments"] if "arguments" in params else {}

        def job() -> Response:
            try:
                ctx = ToolContext(deps=self.opts.get("deps") or {}, signal=controller, default_cwd=self.opts.get("cwd") or os.getcwd())
                return {"jsonrpc": "2.0", "id": id, "result": call_tool(tool, arguments, ctx)}
            except Exception as e:  # noqa: BLE001
                return {"jsonrpc": "2.0", "id": id, "result": fail("internal_error", str(e))}
            finally:
                with self._lock:
                    self._inflight.pop(key, None)

        return job


def serve(input: BinaryIO, output: BinaryIO, opts: dict | None = None) -> None:
    """Reads newline-delimited JSON from `input` and writes responses to `output` until `input` ends and every call settled."""
    server = ReviewServer(opts)
    serve_lines(input, output, server.begin)


def main() -> int:
    # Reviewer children are detached process groups: without this they would outlive a stopped server.
    def stop(signum: int, frame: Any) -> None:
        kill_live_reviewers()
        raise SystemExit(0)

    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, stop)
    serve(sys.stdin.buffer, sys.stdout.buffer)
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
