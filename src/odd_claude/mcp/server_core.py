"""Shared stdio JSON-RPC plumbing for the plugin's MCP servers (port of v9 mcp/server-core.ts): error builder, newline-delimited line loop and the
"run only as entry point" helper. No SDK (decision of spikes/py-02-mcp), no I/O besides the given streams.

Python port conventions: messages are plain dicts. The v9 loop dispatches each line synchronously and lets calls settle on their own; here
`serve_lines(input, output, begin)` calls `begin(message)` in the reader thread, in line order, and `begin` returns either a response (or
None) right away or a zero-argument job that produces one: the job runs in its own thread, so slow tool calls overlap and a later
`notifications/cancelled` (handled in `begin`, in order) always finds the call it cancels registered."""
import codecs
import threading
from typing import Any, BinaryIO, Callable, Union

from ..lib.js import js_json_loads, js_number_to_string, js_stringify, js_trim, utf16_len

SUPPORTED_PROTOCOLS = ("2025-06-18", "2025-03-26", "2024-11-05")
#: Longest accepted input line (bytes); a longer line is dropped with an invalid-request error.
MAX_LINE_BYTES = 4 * 1024 * 1024
_CHUNK = 65536

Response = dict
Begin = Callable[[Any], Union[Response, None, Callable[[], Union[Response, None]]]]


def rpc_error(id: Any, code: int, message: str) -> Response:
    return {"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}}


def is_object(v: Any) -> bool:
    return isinstance(v, dict)


def inflight_key(id: Any) -> str:
    """JSON-RPC ids 6 and "6" are different ids."""
    return f"string:{id}" if isinstance(id, str) else f"number:{js_number_to_string(id)}"


def _over_cap_bytes(line: str) -> bool:
    if len(line) <= MAX_LINE_BYTES // 4:
        return False
    return len(line.encode("utf-8", "surrogatepass")) > MAX_LINE_BYTES


def _over_cap_units(buf: str) -> bool:
    """JS `buf.length > MAX_LINE_BYTES` (UTF-16 code units)."""
    if len(buf) * 2 <= MAX_LINE_BYTES:
        return False
    return len(buf) > MAX_LINE_BYTES or utf16_len(buf) > MAX_LINE_BYTES


def serve_lines(input: BinaryIO, output: BinaryIO, begin: Begin) -> None:
    """Reads newline-delimited JSON from `input` and writes responses to `output` until `input` ends and every call settled."""
    write_lock = threading.Lock()
    threads: list[threading.Thread] = []

    def send(r: Response) -> None:
        data = (js_stringify(r) + "\n").encode("utf-8")
        with write_lock:
            output.write(data)
            output.flush()

    def settle(job: Callable[[], Union[Response, None]]) -> None:
        try:
            r = job()
        except Exception as e:  # noqa: BLE001 - v9: a rejected handler is a -32603 with the error's message
            send(rpc_error(None, -32603, str(e)))
            return
        if r is not None:
            send(r)

    def dispatch(line: str) -> None:
        try:
            message = js_json_loads(line)
        except ValueError:
            send(rpc_error(None, -32700, "parse error"))
            return
        try:
            first = begin(message)
        except Exception as e:  # noqa: BLE001
            send(rpc_error(None, -32603, str(e)))
            return
        if callable(first):
            t = threading.Thread(target=settle, args=(first,), daemon=True)
            threads.append(t)
            t.start()
        elif first is not None:
            send(first)

    read = getattr(input, "read1", None) or input.read
    decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
    buf = ""
    dropping = False
    while True:
        try:
            chunk = read(_CHUNK)
        except (OSError, ValueError):
            break
        if not chunk:
            break
        buf += decoder.decode(chunk)
        while (nl := buf.find("\n")) >= 0:
            line = buf[:nl]
            if line.endswith("\r"):
                line = line[:-1]
            buf = buf[nl + 1:]
            if dropping:
                dropping = False
            elif js_trim(line) != "":
                if _over_cap_bytes(line):
                    send(rpc_error(None, -32600, "message too large"))
                else:
                    dispatch(line)
        if _over_cap_units(buf):
            # An unterminated line past the cap: answer once, drop everything up to the next newline.
            send(rpc_error(None, -32600, "message too large"))
            buf = ""
            dropping = True
    buf += decoder.decode(b"", final=True)
    if not dropping and js_trim(buf) != "":
        dispatch(buf)
    for t in list(threads):
        t.join()
