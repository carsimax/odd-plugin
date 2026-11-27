# /// script
# requires-python = ">=3.14"
# dependencies = ["mcp"]
# ///
"""Minimal official-SDK stdio server: one slow tool (cancellation) and one typed tool (invalid params)."""
import anyio
from mcp.server.mcpserver import MCPServer

app = MCPServer("spike")


@app.tool()
async def slow() -> str:
    try:
        await anyio.sleep(3)
    except BaseException:
        print("SLOW_CANCELLED", file=__import__("sys").stderr, flush=True)
        raise
    return "done"


@app.tool()
def add(a: int, b: int) -> int:
    return a + b


if __name__ == "__main__":
    app.run("stdio")
