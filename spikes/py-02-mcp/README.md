# py-02: MCP SDK vs hand-rolled

Question (roadmap Phase 0): "MCP SDK vs hand-rolled: protocol versions, cancellation, error codes, 4 MiB cap."
Measured: official Python SDK `mcp` 2.3.0 (`MCPServer`, stdio), Python 3.14, against v9
`plugins/odd-claude/src/mcp/server-core.ts` and `review-server.ts` (`SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"]`,
`MAX_LINE_BYTES = 4 * 1024 * 1024`). `server.py` is a minimal SDK server (tools `slow`, `add`); `driver.py` pipes JSON-RPC lines to it.
Note: `mcp` 2.x renamed `FastMCP` to `MCPServer` (`from mcp.server.mcpserver import MCPServer`), so the SDK API is not stable across majors.

## Result

Observed by `uv run --script driver.py` (full output reproduced by the Rerun command):

1. Protocol versions: `initialize` with `2025-06-18`, `2025-03-26` and `2024-11-05` each echoes the same version back. An unknown
   version (`1999-01-01`) is answered with `2025-11-25` (the SDK's latest). v9 answers `2025-06-18` (its first supported version).
   The SDK supports a superset of the 3 v9 versions.
2. Cancellation: `tools/call slow` followed by `notifications/cancelled {requestId: 2}` cancels the running tool (the tool saw
   the cancellation, `SLOW_CANCELLED` on stderr) and the SDK sends no response for request 2. v9 aborts the tool signal and
   still answers id 2 with the tool's own result (a typed `cancelled` outcome).
3. Error codes:
   - unknown method `resources/nope`: `-32601` "Method not found" (same code as v9, `-32601`).
   - `tools/call` with `params: {}`: `-32602` "Invalid request parameters" (v9: `-32602`).
   - `tools/call` with wrong argument type (`add` with `a: "x"`): a normal result with `isError: true` and a pydantic message, not an error code (v9: `-32602` only for a non-object `arguments`; per-tool validation is the tool's own).
   - `tools/call` unknown tool: a normal result with `isError: true` "Unknown tool: nope" (v9: `-32602`).
   - malformed JSON line `{not json`: no response at all, the server stays alive and answers the next request (v9: `-32700` "parse error" with `id: null`).
4. 4 MiB cap: a line of 4 MiB + 10 bytes is accepted and answered normally (`id: 8` result `{}`), no limit. v9 answers `-32600`
   "message too large" and drops the line.

| Point | SDK (`mcp` 2.3.0) | v9 hand-rolled |
|---|---|---|
| 3 supported versions | echoed | echoed |
| Unknown version | `2025-11-25` | `2025-06-18` |
| Cancel in-flight | tool cancelled, no reply | tool aborted, reply with `cancelled` outcome |
| Unknown method | `-32601` | `-32601` |
| Missing tool name | `-32602` | `-32602` |
| Unknown tool / bad argument type | `isError` result | `-32602` (unknown tool) |
| Malformed JSON | silently ignored | `-32700` |
| > 4 MiB line | accepted | `-32600` "message too large" |

Recommendation: hand-rolled (port `server-core.ts` and `review-server.ts` as a small stdlib `asyncio` loop, about 100 lines).
Reason: the SDK diverges on 4 of the 8 points, including the contract points the v9 specs pin (`-32700` parse error, the 4 MiB
`-32600` cap, unknown-version fallback, cancelled reply), and gives no hook for the line cap since its stdio transport owns the
reader. Re-implementing those on top of the SDK means patching its transport, which costs more than the hand-rolled loop, and the
2.x rename shows its API churns. The SDK's only gain here (newer protocol versions, schema generation) is not needed by the review server.

## Rerun

```sh
cd /tmp && uv run --script <repo>/spikes/py-02-mcp/driver.py
```

`driver.py` and `server.py` carry PEP 723 metadata (`mcp`, Python >= 3.14), so no repo `pyproject.toml` or venv is used.
Replace `<repo>` with the repository root (for example `/Users/carsimax/Developer/03-PERSONAL/odd-claude`).
