from mcp.server.fastmcp import FastMCP

server = FastMCP("SheJane E2E")


@server.tool()
def echo(value: str) -> str:
    """Echo a deterministic value for the Runtime MCP contract test."""
    return f"E2E_MCP_OK:{value}"


def _register_helper(index: int) -> None:
    @server.tool(name=f"helper_{index:02d}")
    def helper(value: str) -> str:
        """Provide a deterministic helper result."""
        return f"E2E_MCP_HELPER_{index:02d}:{value}"


for helper_index in range(1, 12):
    _register_helper(helper_index)


if __name__ == "__main__":
    server.run()
